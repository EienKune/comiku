import {
  kivoProfileHash,
  validateKivoProfile,
  type KivoProfile,
} from "./kivo.js";
import type { BirthdayPerson } from "./schaledb.js";

export interface ExternalBirthdayEntry {
  entryId: number;
  personKey: string | null;
  status: string;
  blockedKeys: string[];
  gameEntryIds: number[];
  profile: unknown;
  profileHash: string | null;
}
export interface ExternalBirthdayIdentity {
  entryId: number;
  personKey: string | null;
  status: "confirmed" | "pending";
  blockedKeys: string[];
  gameEntryIds: number[];
}
const numbers = (values: number[]) =>
  [...new Set(values)].sort((a, b) => a - b);
const strings = (values: string[]) =>
  [...new Set(values)].filter(Boolean).sort();
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
const sameBirthday = (
  a: Pick<BirthdayPerson, "month" | "day">,
  b: Pick<BirthdayPerson, "month" | "day">,
) => a.month === b.month && a.day === b.day;

/** Pure, bounded composition. SchaleDB's raw registry and historical keys stay untouched. */
export function combineBirthdayCatalog(
  schale: BirthdayPerson[],
  external: ExternalBirthdayEntry[],
  previous: BirthdayPerson[] = [],
) {
  if (external.length > 2000 || schale.length > 2000 || previous.length > 2000)
    throw new Error("birthday_external_limit");
  const oldPeople = new Map(previous.map((p) => [p.key, p]));
  const rawPeople = new Map(schale.map((p) => [p.key, p]));
  const byGameId = new Map(
    schale.flatMap((p) => p.entryIds.map((id) => [id, p] as const)),
  );
  const identities = new Map<number, ExternalBirthdayIdentity>();
  const profiles = new Map<number, KivoProfile>();
  const parents = new Map<number, number>();
  const ensure = (id: number) => {
    if (!positive(id) || (parents.size >= 2000 && !parents.has(id)))
      throw new Error("birthday_external_invalid_identity");
    if (!parents.has(id)) parents.set(id, id);
    if (!identities.has(id))
      identities.set(id, {
        entryId: id,
        personKey: null,
        status: "confirmed",
        blockedKeys: [],
        gameEntryIds: [],
      });
  };
  const find = (id: number): number => {
    ensure(id);
    const parent = parents.get(id)!;
    if (parent !== id) parents.set(id, find(parent));
    return parents.get(id)!;
  };
  const union = (a: number, b: number) => {
    const x = find(a),
      y = find(b);
    if (x !== y) parents.set(Math.max(x, y), Math.min(x, y));
  };
  const savedKeys = new Map<string, number>();
  for (const row of external) {
    if (
      identities.has(row.entryId) ||
      !["confirmed", "pending"].includes(row.status) ||
      row.blockedKeys.length > 100 ||
      row.gameEntryIds.length > 100 ||
      row.gameEntryIds.some((id) => !positive(id))
    )
      throw new Error("birthday_external_invalid_identity");
    ensure(row.entryId);
    identities.set(row.entryId, {
      entryId: row.entryId,
      personKey: row.personKey,
      status: row.status as "confirmed" | "pending",
      blockedKeys: strings(row.blockedKeys),
      gameEntryIds: numbers(row.gameEntryIds),
    });
    if (row.profile !== null) {
      const profile = validateKivoProfile(row.profile);
      if (
        profile.id !== row.entryId ||
        kivoProfileHash(profile) !== row.profileHash
      )
        throw new Error("birthday_external_invalid_profile");
      profiles.set(row.entryId, profile);
    }
    if (row.personKey) {
      const prior = savedKeys.get(row.personKey);
      if (prior !== undefined) union(prior, row.entryId);
      else savedKeys.set(row.personKey, row.entryId);
    }
  }
  const gameGroups = new Map<string, number>();
  for (const [id, identity] of [...identities]) {
    const profile = profiles.get(id);
    for (const member of profile?.entryIds ?? []) union(id, member);
    for (const gameId of [
      ...identity.gameEntryIds,
      ...(profile?.gameEntryIds ?? []),
    ]) {
      const person = byGameId.get(gameId);
      if (!person) continue; // An absent game ID cannot prove an identity.
      const prior = gameGroups.get(person.key);
      if (prior !== undefined) union(prior, id);
      else gameGroups.set(person.key, id);
    }
  }
  const groups = new Map<number, number[]>();
  for (const id of parents.keys()) {
    const key = find(id);
    groups.set(key, [...(groups.get(key) ?? []), id]);
  }
  // Accepted bridges are durable even if upstream later drops a skin/game edge.
  const projections = new Map<string, string>();
  for (const identity of identities.values()) {
    if (!identity.personKey) continue;
    for (const id of identity.gameEntryIds) {
      const raw = byGameId.get(id);
      if (!raw) continue;
      const old = projections.get(raw.key);
      if (old && old !== identity.personKey)
        throw new Error("birthday_external_identity_conflict");
      projections.set(raw.key, identity.personKey);
    }
  }
  const supplemental = new Map<string, BirthdayPerson>();
  const blocked = new Set<string>();
  const pendingGroups: number[] = [];
  for (const members of groups.values()) {
    members.sort((a, b) => a - b);
    const rows = members.map((id) => identities.get(id)!);
    const data = members.flatMap((id) =>
      profiles.has(id) ? [profiles.get(id)!] : [],
    );
    const keys = strings(
      rows.flatMap((row) => (row.personKey ? [row.personKey] : [])),
    );
    const gameIds = numbers(data.flatMap((p) => p.gameEntryIds));
    const targets = strings(
      [...rows.flatMap((r) => r.gameEntryIds), ...gameIds].flatMap((id) =>
        byGameId.has(id) ? [byGameId.get(id)!.key] : [],
      ),
    );
    const dates = data.filter((p) => p.month !== null);
    const representative = [...data].sort(
      (a, b) =>
        Number(b.originalEntryId === b.id) -
          Number(a.originalEntryId === a.id) || a.id - b.id,
    )[0];
    let canonical =
      keys[0] ??
      (targets.length === 1
        ? (projections.get(targets[0]) ?? targets[0])
        : undefined);
    const previousPerson = canonical ? oldPeople.get(canonical) : undefined;
    const dateConflict =
      dates.length > 0 && dates.some((p) => !sameBirthday(p, dates[0]));
    const targetConflict = targets.some((key) =>
      dates.some((p) => !sameBirthday(p, rawPeople.get(key)!)),
    );
    const changedBirthday =
      previousPerson &&
      previousPerson.birthdaySource?.source === "kivo" &&
      dates.length > 0 &&
      !sameBirthday(previousPerson, dates[0]);
    const publishedTargetConflict =
      canonical &&
      targets.some(
        (key) =>
          oldPeople.has(projections.get(key) ?? key) &&
          (projections.get(key) ?? key) !== canonical,
      );
    const conflict =
      keys.length > 1 ||
      targets.length > 1 ||
      dateConflict ||
      targetConflict ||
      Boolean(changedBirthday) ||
      Boolean(publishedTargetConflict) ||
      rows.some((row) => row.status === "pending");
    for (const row of rows) for (const key of row.blockedKeys) blocked.add(key);
    if (conflict) {
      for (const row of rows) row.status = "pending";
      pendingGroups.push(members[0]);
      // A failed new bridge never renumbers an existing supplemental person or
      // publishes the newly overlapping SchaleDB person under a second identity.
      for (const target of targets)
        if (!oldPeople.has(projections.get(target) ?? target)) {
          blocked.add(target);
          for (const row of rows)
            row.blockedKeys = strings([...row.blockedKeys, target]);
        }
      for (const key of keys) {
        const prior = oldPeople.get(key);
        if (prior?.birthdaySource?.source === "kivo")
          supplemental.set(prior.key, {
            ...prior,
            notificationEligible: false,
          });
      }
      continue;
    }
    if (!representative) continue;
    if (!canonical) {
      if (
        !dates.length ||
        !representative.name ||
        data.every((p) => p.installed)
      )
        continue;
      canonical = `kivo:${representative.originalEntryId ?? members[0]}`;
    }
    const acceptedIds = numbers([
      ...rows.flatMap((r) => r.gameEntryIds),
      ...gameIds.filter((id) => byGameId.has(id)),
    ]);
    if (targets.length === 1) projections.set(targets[0], canonical);
    for (const row of rows) {
      row.personKey = canonical;
      row.gameEntryIds = acceptedIds;
    }
    if (targets.length) continue;
    const withDate =
      data.find((p) => p.id === representative.id && p.month !== null) ??
      dates[0];
    const name = representative.name ?? previousPerson?.name;
    if (!withDate || !name) continue;
    const profileHash = kivoProfileHash(withDate);
    supplemental.set(canonical, {
      key: canonical,
      name,
      aliases: strings([
        ...data.flatMap((p) => [
          ...p.aliases,
          p.japaneseName,
          ...(p.name ? [p.name] : []),
        ]),
        ...(previousPerson?.aliases ?? []),
        ...(previousPerson ? [previousPerson.name] : []),
      ]).filter((alias) => alias !== name),
      month: withDate.month,
      day: withDate.day,
      originalEntryId: null,
      entryIds: [],
      notificationEligible: true,
      avatarUrl: representative.avatarUrl,
      birthdaySource: { source: "kivo", entryId: withDate.id, profileHash },
    });
  }
  // A source can publish a new playable entry before Kivo publishes its numeric bridge.
  // Names are only a conservative duplicate warning, never authority to merge people.
  for (const person of supplemental.values()) {
    const matches = schale.filter(
      (p) =>
        !projections.has(p.key) &&
        !oldPeople.has(p.key) &&
        [p.name, ...p.aliases].some(
          (name) => person.aliases.includes(name) || name === person.name,
        ),
    );
    for (const match of matches) {
      blocked.add(match.key);
      for (const row of identities.values())
        if (row.personKey === person.key)
          row.blockedKeys = strings([...row.blockedKeys, match.key]);
    }
  }
  // Resolved, explicit ID bridges release duplicate holds without changing the person key.
  for (const row of identities.values())
    row.blockedKeys = row.blockedKeys.filter(
      (key) => projections.get(key) !== row.personKey,
    );
  for (const [key, canonical] of projections)
    if (
      [...identities.values()].some(
        (row) =>
          row.personKey === canonical &&
          row.gameEntryIds.some((id) => byGameId.get(id)?.key === key),
      )
    )
      blocked.delete(key);
  const people = new Map(supplemental);
  for (const p of schale) {
    if (blocked.has(p.key)) continue;
    const key = projections.get(p.key) ?? p.key;
    if (people.has(key)) throw new Error("birthday_external_identity_conflict");
    const prior = oldPeople.get(key);
    people.set(
      key,
      key === p.key
        ? { ...p }
        : {
            ...p,
            key,
            aliases: strings([
              ...p.aliases,
              ...(prior?.aliases ?? []),
              ...(prior ? [prior.name] : []),
            ]).filter((name) => name !== p.name),
          },
    );
  }
  return {
    people: [...people.values()].sort((a, b) => a.key.localeCompare(b.key)),
    identities: [...identities.values()].sort((a, b) => a.entryId - b.entryId),
    pendingGroups,
  };
}
