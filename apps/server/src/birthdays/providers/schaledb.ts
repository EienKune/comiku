import { createHash } from "node:crypto";
import { reviewedRegistry } from "./reviewed-registry.js";

export interface BirthdayPerson {
  key: string;
  name: string;
  aliases: string[];
  month: number | null;
  day: number | null;
  originalEntryId: number | null;
  entryIds: number[];
  notificationEligible: boolean;
}

const birthdayIdentityStatuses = [
  "confirmed",
  "pending",
  "unlocalized",
] as const;

export interface BirthdayIdentity {
  entryId: number;
  personKey: string;
  originalEntryId: number | null;
  status: (typeof birthdayIdentityStatuses)[number];
}

export const isBirthdayIdentityStatus = (
  value: unknown,
): value is BirthdayIdentity["status"] =>
  birthdayIdentityStatuses.some((status) => value === status);

export interface BirthdaySourceCounts {
  jp: number;
  cn: number;
}
export interface BirthdayCatalog {
  people: BirthdayPerson[];
  identities: BirthdayIdentity[];
  sourceCounts: BirthdaySourceCounts;
  pendingEntryIds: number[];
  contentHash: string;
}
export interface BirthdayCatalogOptions {
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  previousPeople?: BirthdayPerson[];
  identities?: BirthdayIdentity[];
  previousCounts?: BirthdaySourceCounts;
}

interface Entry {
  id: number;
  name: string;
  familyName: string;
  personalName: string;
  month: number | null;
  day: number | null;
  alts: number[];
}

const ORIGIN = "https://schaledb.com";
const MAX_BODY = 8 * 1024 * 1024;
class BirthdayProviderError extends Error {}
const forbiddenNameCharacter = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const unique = (values: string[]) =>
  [...new Set(values)].filter(Boolean).sort();
const ids = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BirthdayProviderError("birthday_invalid_object");
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    forbiddenNameCharacter.test(value)
  )
    throw new BirthdayProviderError("birthday_invalid_name");
  return value.trim();
};
const optionalName = (value: unknown): string => {
  if (value === undefined) return "";
  if (typeof value !== "string" || forbiddenNameCharacter.test(value))
    throw new BirthdayProviderError("birthday_invalid_name");
  return value.trim();
};
const positiveId = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;

// Keep the deadline active through body streaming, rather than only until headers arrive.
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () =>
      reject(
        signal.reason ?? new BirthdayProviderError("birthday_request_aborted"),
      );
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function fetchJson(
  path: string,
  fetcher: typeof globalThis.fetch,
  overall: AbortSignal,
): Promise<unknown> {
  let url = new URL(path, ORIGIN);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const signal = AbortSignal.any([overall, AbortSignal.timeout(20_000)]);
    const response = await abortable(
      fetcher(url.href, { redirect: "manual", signal }),
      signal,
    );
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      void response.body?.cancel().catch(() => {});
      const location = response.headers.get("location");
      if (!location || redirects === 3)
        throw new BirthdayProviderError("birthday_invalid_redirect");
      const next = new URL(location, url);
      if (next.origin !== ORIGIN || next.username || next.password)
        throw new BirthdayProviderError("birthday_unsafe_redirect");
      url = next;
      continue;
    }
    if (!response.ok || !response.body) {
      void response.body?.cancel().catch(() => {});
      throw new BirthdayProviderError("birthday_source_unavailable");
    }
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_BODY) {
      void response.body.cancel().catch(() => {});
      throw new BirthdayProviderError("birthday_source_too_large");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await abortable(reader.read(), signal);
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_BODY)
          throw new BirthdayProviderError("birthday_source_too_large");
        chunks.push(chunk.value);
      }
    } catch (error) {
      void reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new BirthdayProviderError("birthday_invalid_json");
    }
  }
  throw new BirthdayProviderError("birthday_invalid_redirect");
}

function parseEntries(config: unknown, source: unknown): Entry[] {
  const regions = object(config).Regions;
  if (!Array.isArray(regions))
    throw new BirthdayProviderError("birthday_invalid_regions");
  const indexes = regions.flatMap((r, i) =>
    object(r).Name === "Jp" ? [i] : [],
  );
  if (indexes.length !== 1)
    throw new BirthdayProviderError("birthday_invalid_regions");
  const result: Entry[] = [];
  for (const [key, raw] of Object.entries(object(source))) {
    const e = object(raw);
    if (
      !positiveId(e.Id) ||
      String(e.Id) !== key ||
      !Array.isArray(e.IsReleased) ||
      e.IsReleased.length <= indexes[0] ||
      e.IsReleased.some((v) => typeof v !== "boolean")
    ) {
      throw new BirthdayProviderError("birthday_invalid_entry");
    }
    const name = text(e.Name);
    if (!e.IsReleased[indexes[0]]) continue;
    let month: number | null = null;
    let day: number | null = null;
    if (e.BirthDay !== "-") {
      if (
        typeof e.BirthDay !== "string" ||
        !/^\d{1,2}\/\d{1,2}$/.test(e.BirthDay)
      )
        throw new BirthdayProviderError("birthday_invalid_date");
      [month, day] = e.BirthDay.split("/").map(Number);
      const date = new Date(Date.UTC(2000, month - 1, day));
      if (
        month < 1 ||
        month > 12 ||
        day < 1 ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
      ) {
        throw new BirthdayProviderError("birthday_invalid_date");
      }
    }
    if (
      e.FavorAlts !== undefined &&
      (!Array.isArray(e.FavorAlts) || e.FavorAlts.some((v) => !positiveId(v)))
    ) {
      throw new BirthdayProviderError("birthday_invalid_association");
    }
    result.push({
      id: e.Id,
      name,
      familyName: optionalName(e.FamilyName),
      personalName: optionalName(e.PersonalName),
      month,
      day,
      alts: (e.FavorAlts ?? []) as number[],
    });
  }
  if (!result.length) throw new BirthdayProviderError("birthday_empty_source");
  return result.sort((a, b) => a.id - b.id);
}

function parseChinese(source: unknown): Map<number, Record<string, unknown>> {
  const result = new Map<number, Record<string, unknown>>();
  for (const [key, raw] of Object.entries(object(source))) {
    const entry = object(raw);
    if (!positiveId(entry.Id) || String(entry.Id) !== key)
      throw new BirthdayProviderError("birthday_invalid_chinese_entry");
    for (const field of ["Name", "FamilyName", "PersonalName"]) {
      if (entry[field] !== null) optionalName(entry[field]);
    }
    result.set(entry.Id, entry);
  }
  if (!result.size)
    throw new BirthdayProviderError("birthday_empty_chinese_source");
  return result;
}

function chineseName(
  entry: Record<string, unknown>,
  independent: boolean,
): string {
  if (typeof entry.FamilyName !== "string")
    throw new BirthdayProviderError("birthday_missing_chinese_name");
  const family = optionalName(entry.FamilyName);
  const personal = text(entry.PersonalName);
  const name = independent ? text(entry.Name) : personal;
  if (independent && name === personal)
    throw new BirthdayProviderError("birthday_invalid_chinese_name");
  const full = family + name;
  if (
    !/\p{Script=Han}/u.test(personal) ||
    !/\p{Script=Han}/u.test(full) ||
    /[^\p{Script=Han}\p{P}\p{Z}\p{N}]/u.test(full)
  )
    throw new BirthdayProviderError("birthday_invalid_chinese_name");
  return full;
}

/** Returns a complete candidate snapshot; callers atomically retain the old snapshot on any error. */
async function fetchCatalog(
  options: BirthdayCatalogOptions,
): Promise<BirthdayCatalog> {
  const overall = AbortSignal.any([
    AbortSignal.timeout(60_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const fetcher = options.fetch ?? globalThis.fetch;
  const config = await fetchJson("/data/config.min.json", fetcher, overall);
  const entries = parseEntries(
    config,
    await fetchJson("/data/jp/students.min.json", fetcher, overall),
  );
  const chinese = parseChinese(
    await fetchJson("/data/cn/students.min.json", fetcher, overall),
  );
  const sourceCounts = { jp: entries.length, cn: chinese.size };
  for (const source of ["jp", "cn"] as const) {
    const previous = options.previousCounts?.[source];
    if (
      previous !== undefined &&
      (!Number.isSafeInteger(previous) ||
        previous < 0 ||
        sourceCounts[source] < previous * 0.9)
    ) {
      throw new BirthdayProviderError("birthday_source_count_decline");
    }
  }
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const people = new Map(
    (options.previousPeople ?? []).map((p) => [
      p.key,
      { ...p, aliases: [...p.aliases], entryIds: [...p.entryIds] },
    ]),
  );
  const mapping = new Map<number, BirthdayIdentity>();
  const blocked = new Set<number>();
  const pending = new Set<number>();
  const discoveries = new Set<string>();
  const heldGroups = new Map<string, number[]>();
  // Unpublished groups retain their canonical key and every member even when
  // upstream association edges change. Localization alone is retryable; a
  // subsequent identity conflict permanently changes the whole group to pending.
  const unpublishedKeys = new Set(
    (options.identities ?? [])
      .filter(
        (identity) => identity.personKey && !people.has(identity.personKey),
      )
      .map((identity) => identity.personKey),
  );
  const registryIds = new Set<number>(
    reviewedRegistry.flatMap((seed) => [...seed.entryIds]),
  );
  for (const key of unpublishedKeys) {
    const group = (options.identities ?? []).filter(
      (identity) => identity.personKey === key,
    );
    const canonicalId = Number(key.slice("schaledb:".length));
    if (
      key !== `schaledb:${canonicalId}` ||
      !positiveId(canonicalId) ||
      !group.some((identity) => identity.entryId === canonicalId) ||
      group.some(
        (identity) =>
          identity.originalEntryId !== null ||
          !["pending", "unlocalized"].includes(identity.status) ||
          registryIds.has(identity.entryId),
      )
    )
      throw new BirthdayProviderError("birthday_invalid_persisted_identity");
  }
  for (const identity of options.identities ?? []) {
    if (
      mapping.has(identity.entryId) ||
      !positiveId(identity.entryId) ||
      !isBirthdayIdentityStatus(identity.status) ||
      !(
        identity.originalEntryId === null ||
        positiveId(identity.originalEntryId)
      ) ||
      (identity.personKey &&
        !people.has(identity.personKey) &&
        !unpublishedKeys.has(identity.personKey)) ||
      (identity.status === "confirmed" && !identity.personKey)
    )
      throw new BirthdayProviderError("birthday_invalid_persisted_identity");
    const unpublished = unpublishedKeys.has(identity.personKey);
    if (identity.status === "unlocalized" && !unpublished)
      throw new BirthdayProviderError("birthday_invalid_persisted_identity");
    mapping.set(identity.entryId, { ...identity });
    if (unpublished)
      heldGroups.set(identity.personKey, [
        ...(heldGroups.get(identity.personKey) ?? []),
        identity.entryId,
      ]);
    if (identity.status !== "confirmed") {
      if (identity.status === "pending") blocked.add(identity.entryId);
      pending.add(identity.entryId);
    }
  }
  for (const [key, entryIds] of heldGroups) {
    const canonicalId = Number(key.slice("schaledb:".length));
    const representative =
      byId.get(canonicalId) ??
      ids(entryIds)
        .map((id) => byId.get(id))
        .find(Boolean);
    if (!representative) continue;
    discoveries.add(key);
    people.set(key, {
      key,
      name: representative.name,
      aliases: [],
      month: representative.month,
      day: representative.day,
      originalEntryId: null,
      entryIds: ids(entryIds),
      notificationEligible: representative.month !== null,
    });
  }
  // Previous people also fence identities if a caller is upgrading an older persisted snapshot.
  for (const p of people.values())
    for (const id of p.entryIds) {
      const existing = mapping.get(id);
      if (existing && existing.personKey !== p.key)
        throw new BirthdayProviderError("birthday_persisted_identity_conflict");
      if (!existing)
        mapping.set(id, {
          entryId: id,
          personKey: p.key,
          originalEntryId: p.originalEntryId,
          status: "confirmed",
        });
    }
  for (const seed of reviewedRegistry) {
    const present =
      byId.get(seed.originalEntryId) ??
      seed.entryIds.map((id) => byId.get(id)).find(Boolean);
    if (!present) continue;
    if (!people.has(seed.key))
      people.set(seed.key, {
        key: seed.key,
        name: seed.name,
        aliases: [...seed.aliases],
        month: present.month,
        day: present.day,
        originalEntryId: seed.originalEntryId,
        entryIds: [],
        notificationEligible: present.month !== null,
      });
    const p = people.get(seed.key)!;
    if (
      p.originalEntryId !== null &&
      p.originalEntryId !== seed.originalEntryId
    )
      throw new BirthdayProviderError("birthday_original_identity_conflict");
    p.originalEntryId = seed.originalEntryId;
    p.aliases = unique([...p.aliases, ...seed.aliases]);
    for (const id of seed.entryIds)
      if (byId.has(id)) {
        const existing = mapping.get(id);
        if (existing?.personKey && existing.personKey !== seed.key)
          throw new BirthdayProviderError("birthday_seed_identity_conflict");
        if (!existing)
          mapping.set(id, {
            entryId: id,
            personKey: seed.key,
            originalEntryId: seed.originalEntryId,
            status: "confirmed",
          });
      }
  }
  // A persisted confirmed review can supply the original for a discovered person.
  // Null metadata on older outfit mappings is only an absent hint; it must not
  // erase this approval. Neither pending reviews nor cross-person IDs are authority.
  const approvedOriginals = new Map<string, number>();
  for (const identity of options.identities ?? []) {
    if (identity.status !== "confirmed" || identity.originalEntryId === null)
      continue;
    const p = people.get(identity.personKey)!;
    const original = mapping.get(identity.originalEntryId);
    if (
      !original ||
      original.personKey !== p.key ||
      original.status !== "confirmed"
    ) {
      throw new BirthdayProviderError("birthday_original_identity_conflict");
    }
    const priorApproval = approvedOriginals.get(p.key) ?? p.originalEntryId;
    if (
      priorApproval !== null &&
      priorApproval !== undefined &&
      priorApproval !== identity.originalEntryId
    ) {
      throw new BirthdayProviderError("birthday_original_identity_conflict");
    }
    approvedOriginals.set(p.key, identity.originalEntryId);
  }
  for (const [key, originalEntryId] of approvedOriginals) {
    const p = people.get(key)!;
    const source = byId.get(originalEntryId);
    // A newly reviewed original must pass the same birthday boundary as every
    // other newly attached entry. Existing accepted IDs retain their old facts.
    if (
      p.entryIds.includes(originalEntryId) ||
      (source && source.month === p.month && source.day === p.day)
    ) {
      p.originalEntryId = originalEntryId;
    }
  }
  const quarantine = (id: number, key = "") => {
    pending.add(id);
    const p = people.get(key);
    mapping.set(id, {
      entryId: id,
      personKey: key,
      originalEntryId:
        mapping.get(id)?.originalEntryId ?? p?.originalEntryId ?? null,
      status: "pending",
    });
  };
  const update = (key: string, e: Entry) => {
    const p = people.get(key)!;
    if (blocked.has(e.id) || p.month !== e.month || p.day !== e.day) {
      quarantine(e.id, key);
      return;
    }
    mapping.set(e.id, {
      entryId: e.id,
      personKey: key,
      originalEntryId:
        p.originalEntryId ?? mapping.get(e.id)?.originalEntryId ?? null,
      status: "confirmed",
    });
    pending.delete(e.id);
    p.entryIds = ids([...p.entryIds, e.id]);
    p.aliases = unique([...p.aliases, e.name, e.familyName + e.personalName]);
  };
  for (const e of entries) {
    const known = mapping.get(e.id);
    if (known?.personKey && people.has(known.personKey))
      update(known.personKey, e);
  }
  const edges = new Map<number, Set<number>>();
  const edge = (a: number, b: number) => {
    if (a === 10100 || b === 10100) return;
    if (!edges.has(a)) edges.set(a, new Set());
    if (!edges.has(b)) edges.set(b, new Set());
    edges.get(a)!.add(b);
    edges.get(b)!.add(a);
  };
  for (const e of entries) for (const alt of e.alts) edge(e.id, alt);
  if (byId.has(10144)) edge(10144, 10011);
  const heldConflicts = new Set<string>();
  for (const [key, group] of heldGroups) {
    const seen = new Set<number>();
    const queue = [...group];
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      if (seen.has(id)) continue;
      seen.add(id);
      const identity = mapping.get(id);
      if (
        (identity?.personKey && identity.personKey !== key) ||
        identity?.status === "pending"
      ) {
        heldConflicts.add(key);
        continue;
      }
      queue.push(...(edges.get(id) ?? []));
    }
  }
  const visited = new Set<number>();
  for (const start of entries) {
    if (mapping.get(start.id)?.personKey || visited.has(start.id)) continue;
    const component: number[] = [];
    const known = new Set<string>();
    const queue = [start.id];
    let quarantined = false;
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      const identity = mapping.get(id);
      if (identity?.personKey) {
        known.add(identity.personKey);
        continue;
      }
      if (visited.has(id)) continue;
      visited.add(id);
      component.push(id);
      quarantined ||= blocked.has(id);
      queue.push(...(edges.get(id) ?? []));
    }
    const observed = ids(component)
      .map((id) => byId.get(id))
      .filter((e): e is Entry => Boolean(e));
    if (quarantined || known.size > 1) {
      for (const e of observed) quarantine(e.id);
      continue;
    }
    let key = [...known][0];
    if (key && !people.has(key)) {
      for (const e of observed) quarantine(e.id);
      continue;
    }
    if (!key) {
      // An unassociated same-name entry requires review; names never unite people.
      const conflict = observed.some(
        (e) =>
          e.id !== 10100 &&
          [...people.values()].some(
            (p) =>
              p.name === e.name ||
              p.aliases.includes(e.name) ||
              (e.familyName !== "" &&
                e.personalName !== "" &&
                p.aliases.includes(e.familyName + e.personalName)),
          ),
      );
      const representative = observed[0];
      const birthdaysAgree = observed.every(
        (e) => e.month === representative.month && e.day === representative.day,
      );
      if (conflict || !birthdaysAgree) {
        for (const e of observed) quarantine(e.id);
        continue;
      }
      key = `schaledb:${representative.id}`;
      discoveries.add(key);
      people.set(key, {
        key,
        name: representative.name,
        aliases: [],
        month: representative.month,
        day: representative.day,
        originalEntryId: null,
        entryIds: [],
        notificationEligible: representative.month !== null,
      });
    }
    for (const e of observed) update(key, e);
  }
  for (const p of people.values()) {
    const representative =
      p.originalEntryId ?? Number(p.key.replace(/^schaledb:/, ""));
    const localized = chinese.get(representative);
    const holdLocalization = () => {
      people.delete(p.key);
      for (const entryId of p.entryIds) {
        pending.add(entryId);
        mapping.set(entryId, {
          entryId,
          personKey: p.key,
          originalEntryId: null,
          status: "unlocalized",
        });
      }
    };
    if (
      heldConflicts.has(p.key) ||
      (heldGroups.has(p.key) &&
        p.entryIds.some((id) => mapping.get(id)?.status === "pending"))
    ) {
      people.delete(p.key);
      for (const entryId of p.entryIds) quarantine(entryId, p.key);
      continue;
    }
    // A newly discovered person's missing localization fields are an upstream
    // translation gap. Malformed types and unsafe text still fail parseChinese.
    if (
      discoveries.has(p.key) &&
      (!localized ||
        localized.FamilyName === null ||
        localized.FamilyName === undefined ||
        localized.PersonalName === null ||
        localized.PersonalName === undefined ||
        (typeof localized.PersonalName === "string" &&
          !localized.PersonalName.trim()))
    ) {
      holdLocalization();
      continue;
    }
    if (!localized)
      throw new BirthdayProviderError("birthday_missing_chinese_name");
    let name: string;
    try {
      name = chineseName(localized, p.key === "schaledb:10100");
    } catch (error) {
      if (
        !(error instanceof BirthdayProviderError) ||
        error.message !== "birthday_invalid_chinese_name" ||
        !discoveries.has(p.key)
      )
        throw error;
      // Never publish an untranslated newly discovered name. Keep a retryable
      // canonical key, rather than a permanent identity-conflict quarantine.
      holdLocalization();
      continue;
    }
    for (const entryId of heldGroups.get(p.key) ?? []) {
      pending.delete(entryId);
      mapping.set(entryId, {
        entryId,
        personKey: p.key,
        originalEntryId: null,
        status: "confirmed",
      });
    }
    p.aliases = unique([...p.aliases, p.name]).filter(
      (alias) => alias !== name,
    );
    p.name = name;
  }
  const result = {
    people: [...people.values()].sort((a, b) => a.key.localeCompare(b.key)),
    identities: [...mapping.values()].sort((a, b) => a.entryId - b.entryId),
    sourceCounts,
    pendingEntryIds: [...pending].sort((a, b) => a - b),
  };
  return {
    ...result,
    contentHash: createHash("sha256")
      .update(JSON.stringify(result))
      .digest("hex"),
  };
}

/** Errors intentionally contain only finite diagnostic codes, never upstream bodies or URLs. */
export async function fetchBirthdayCatalog(
  options: BirthdayCatalogOptions = {},
): Promise<BirthdayCatalog> {
  try {
    return await fetchCatalog(options);
  } catch (error) {
    if (error instanceof BirthdayProviderError) throw error;
    if (options.signal?.aborted)
      throw new BirthdayProviderError("birthday_source_aborted");
    if (error instanceof Error && error.name === "TimeoutError")
      throw new BirthdayProviderError("birthday_source_timeout");
    throw new BirthdayProviderError("birthday_source_failed");
  }
}
