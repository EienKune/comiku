import { createHash } from "node:crypto";

/** Kivo transport and normalization only; identity reconciliation belongs to the catalog layer. */
export interface KivoIndexEntry {
  id: number;
  name: string | null;
  japaneseName: string;
  skin: string;
  avatarUrl: string | null;
}

export interface KivoProfile {
  id: number;
  name: string | null;
  aliases: string[];
  japaneseName: string;
  month: number | null;
  day: number | null;
  entryIds: number[];
  gameEntryIds: number[];
  /** Kivo entry ID only; never the public catalog's SchaleDB avatar identity. */
  originalEntryId: number | null;
  avatarUrl: string | null;
  installed: boolean;
}

interface Options {
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

const ORIGIN = "https://api.kivo.wiki";
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
class KivoError extends Error {}
const fail = (code: string): never => {
  throw new KivoError(`birthday_kivo_${code}`);
};
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail("invalid_object");
  return value as Record<string, unknown>;
};
const positiveId = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
function text(value: unknown, max = 128): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    UNSAFE_TEXT.test(value)
  )
    return fail("invalid_name");
  return value.trim();
}
const optionalText = (value: unknown) =>
  value === null || value === undefined ? "" : text(value);
function fullName(
  data: Record<string, unknown>,
  suffix: string,
): string | null {
  const family = optionalText(data[`family_name${suffix}`]);
  const given = optionalText(data[`given_name${suffix}`]);
  if (!given) return null;
  return text(family + given);
}
function japaneseName(data: Record<string, unknown>): string {
  // Some indexed background characters have no localized name yet. Their
  // missing alias must not reject the otherwise complete source index.
  return fullName(data, "_jp") ?? "";
}
function avatar(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    UNSAFE_TEXT.test(value)
  )
    return fail("invalid_avatar");
  let url: URL;
  try {
    url = new URL(value.startsWith("//") ? `https:${value}` : value);
  } catch {
    return fail("invalid_avatar");
  }
  if (
    url.origin !== "https://static.kivo.wiki" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith("/images/students/") ||
    url.pathname === "/images/students/"
  )
    return fail("invalid_avatar");
  return url.href;
}
function date(month: unknown, day: unknown): void {
  if (month === null && day === null) return;
  if (!Number.isInteger(month) || !Number.isInteger(day))
    return fail("invalid_date");
  const m = month as number,
    d = day as number;
  const parsed = new Date(Date.UTC(2000, m - 1, d));
  if (
    m < 1 ||
    m > 12 ||
    d < 1 ||
    parsed.getUTCMonth() !== m - 1 ||
    parsed.getUTCDate() !== d
  )
    return fail("invalid_date");
}
function idList(value: unknown, allowEmpty: boolean): number[] {
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    (!allowEmpty && !value.length) ||
    value.some((id) => !positiveId(id))
  )
    return fail("invalid_association");
  if (new Set(value).size !== value.length) return fail("invalid_association");
  return [...value].sort((a, b) => a - b) as number[];
}

/** Revalidate the normalized minimal profile when it comes back from persistent JSON. */
export function readKivoProfile(value: unknown): KivoProfile {
  const p = record(value);
  if (!positiveId(p.id) || typeof p.installed !== "boolean")
    return fail("invalid_profile");
  const name = p.name === null ? null : text(p.name);
  if (name === "") return fail("invalid_name");
  const jp = text(p.japaneseName);
  if (!Array.isArray(p.aliases) || p.aliases.length > 100)
    return fail("invalid_name");
  const aliases = [...new Set(p.aliases.map((alias) => text(alias, 256)))]
    .filter(Boolean)
    .filter((alias) => alias !== name)
    .sort();
  const entryIds = idList(p.entryIds, false);
  const gameEntryIds = idList(p.gameEntryIds, true);
  if (!entryIds.includes(p.id)) return fail("invalid_association");
  if (!(
    p.originalEntryId === null ||
    (positiveId(p.originalEntryId) && entryIds.includes(p.originalEntryId))
  ))
    return fail("invalid_association");
  date(p.month, p.day);
  return {
    id: p.id,
    name,
    aliases,
    japaneseName: jp,
    month: p.month as number | null,
    day: p.day as number | null,
    entryIds,
    gameEntryIds,
    originalEntryId: p.originalEntryId,
    avatarUrl: avatar(p.avatarUrl),
    installed: p.installed,
  };
}

export const validateKivoProfile = readKivoProfile;

/** Hash only normalized facts, with stable field, alias and member ordering. */
export function kivoProfileHash(value: KivoProfile): string {
  return createHash("sha256")
    .update(JSON.stringify(readKivoProfile(value)))
    .digest("hex");
}

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => {});
    signal.throwIfAborted();
  }
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
async function pause(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, 250);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
async function request(
  path: string,
  limit: number,
  options: Options,
  overall: AbortSignal,
): Promise<Record<string, unknown>> {
  const signal = AbortSignal.any([overall, AbortSignal.timeout(20_000)]);
  let url = new URL(path, ORIGIN);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await abortable(
      (options.fetch ?? globalThis.fetch)(url.href, {
        redirect: "manual",
        signal,
        headers: {
          "User-Agent": "Comiku-Birthday/1.0",
          Accept: "application/json",
        },
      }),
      signal,
    );
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      void response.body?.cancel().catch(() => {});
      const location = response.headers.get("location");
      if (!location || redirects === 3) return fail("invalid_redirect");
      const next = new URL(location, url);
      if (next.origin !== ORIGIN || next.username || next.password)
        return fail("unsafe_redirect");
      url = next;
      continue;
    }
    if (!response.ok || !response.body) {
      void response.body?.cancel().catch(() => {});
      return fail("unavailable");
    }
    if (Number(response.headers.get("content-length")) > limit) {
      void response.body.cancel().catch(() => {});
      return fail("too_large");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await abortable(reader.read(), signal);
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > limit) return fail("too_large");
        chunks.push(chunk.value);
      }
    } catch (error) {
      void reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return fail("invalid_json");
    }
    const envelope = record(value);
    if (envelope.success !== true || envelope.code !== 2000)
      return fail("invalid_envelope");
    return record(envelope.data);
  }
  return fail("invalid_redirect");
}
async function guarded<T>(
  options: Options,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(60_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  try {
    return await work(signal);
  } catch (error) {
    if (error instanceof KivoError) throw error;
    if (options.signal?.aborted) return fail("aborted");
    if (
      signal.aborted ||
      (error instanceof Error && error.name === "TimeoutError")
    )
      return fail("timeout");
    return fail("failed");
  }
}

export async function fetchKivoIndex(
  options: Options = {},
): Promise<KivoIndexEntry[]> {
  return guarded(options, async (signal) => {
    const entries: KivoIndexEntry[] = [];
    const seen = new Set<number>();
    let pages: number | undefined;
    for (let page = 1; page <= (pages ?? 1); page++) {
      if (page > 1) await pause(signal);
      const data = await request(
        `/api/v1/data/students/?page=${page}&page_size=50`,
        1024 * 1024,
        options,
        signal,
      );
      if (
        !Number.isInteger(data.max_page) ||
        Number(data.max_page) < 1 ||
        Number(data.max_page) > 40 ||
        (pages !== undefined && pages !== data.max_page)
      )
        return fail("invalid_pagination");
      pages = data.max_page as number;
      if (
        !Array.isArray(data.students) ||
        !data.students.length ||
        data.students.length > 50 ||
        (page < pages && data.students.length !== 50)
      )
        return fail("invalid_pagination");
      for (const raw of data.students) {
        const row = record(raw);
        if (!positiveId(row.id) || seen.has(row.id))
          return fail("duplicate_or_invalid_id");
        seen.add(row.id);
        entries.push({
          id: row.id,
          name: fullName(row, "_cn"),
          japaneseName: japaneseName(row),
          skin: text(row.skin),
          avatarUrl: avatar(row.avatar),
        });
        if (entries.length > 2000) return fail("too_many_entries");
      }
    }
    return entries.sort((a, b) => a.id - b.id);
  });
}

export async function fetchKivoProfile(
  entryId: number,
  options: Options = {},
): Promise<KivoProfile> {
  if (!positiveId(entryId)) return fail("invalid_id");
  return guarded(options, async (signal) => {
    const data = await request(
      `/api/v1/data/students/${entryId}`,
      8 * 1024 * 1024,
      options,
      signal,
    );
    if (data.id !== entryId || typeof data.is_install !== "boolean")
      return fail("invalid_profile");
    let month: number | null = null,
      day: number | null = null;
    if (data.birthday !== null) {
      if (
        typeof data.birthday !== "string" ||
        !/^\d{2}-\d{2}$/.test(data.birthday)
      )
        return fail("invalid_date");
      [month, day] = data.birthday.split("-").map(Number);
    }
    date(month, day);
    if (
      !Array.isArray(data.skin_list) ||
      !Array.isArray(data.character_datas) ||
      data.character_datas.length > 100
    )
      return fail("invalid_association");
    const entryIds = idList(
      data.skin_list.map((skin) => record(skin).id),
      false,
    );
    if (!entryIds.includes(entryId)) return fail("invalid_association");
    const originals = data.skin_list
      .filter((skin) => text(record(skin).skin) === "")
      .map((skin) => record(skin).id);
    const originalEntryId = originals.length === 1 ? originals[0] : null;
    const gameIds = data.character_datas.map((raw) => record(raw).character_id);
    if (gameIds.some((id) => !Number.isSafeInteger(id) || Number(id) < 0))
      return fail("invalid_association");
    const aliases = ["", "_jp", "_cn", "_zh_tw", "_en", "_kr"]
      .map((suffix) => fullName(data, suffix))
      .filter((name): name is string => name !== null);
    return readKivoProfile({
      id: entryId,
      name: fullName(data, "_cn"),
      aliases,
      japaneseName: japaneseName(data),
      month,
      day,
      entryIds,
      gameEntryIds: [...new Set(gameIds.filter(positiveId))],
      originalEntryId,
      avatarUrl: avatar(data.avatar),
      installed: data.is_install,
    });
  });
}
