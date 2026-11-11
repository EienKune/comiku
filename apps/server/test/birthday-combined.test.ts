import assert from "node:assert/strict";
import test from "node:test";
import {
  combineBirthdayCatalog,
  type ExternalBirthdayEntry,
} from "../src/birthdays/providers/combined.js";
import {
  kivoProfileHash,
  type KivoProfile,
} from "../src/birthdays/providers/kivo.js";
import type { BirthdayPerson } from "../src/birthdays/providers/schaledb.js";

const schale = (
  id = 90001,
  patch: Partial<BirthdayPerson> = {},
): BirthdayPerson => ({
  key: `schaledb:${id}`,
  name: "合成学生",
  aliases: ["合成テスト"],
  month: 11,
  day: 11,
  originalEntryId: id,
  entryIds: [id],
  notificationEligible: true,
  ...patch,
});
const profile = (
  id = 91001,
  patch: Partial<KivoProfile> = {},
): KivoProfile => ({
  id,
  name: "合成补充",
  aliases: ["合成テスト"],
  japaneseName: "合成テスト",
  month: 11,
  day: 11,
  entryIds: [id],
  gameEntryIds: [],
  originalEntryId: id,
  avatarUrl: "https://static.kivo.wiki/images/students/synthetic/avatar.png",
  installed: false,
  ...patch,
});
const external = (
  p: KivoProfile,
  patch: Partial<ExternalBirthdayEntry> = {},
): ExternalBirthdayEntry => ({
  entryId: p.id,
  personKey: null,
  status: "confirmed",
  blockedKeys: [],
  gameEntryIds: [],
  profile: p,
  profileHash: kivoProfileHash(p),
  ...patch,
});
type Combined = ReturnType<typeof combineBirthdayCatalog>;
function persist(
  result: Combined,
  data: KivoProfile[],
): ExternalBirthdayEntry[] {
  const profiles = new Map(data.map((p) => [p.id, p]));
  return result.identities.map((identity) => {
    const p = profiles.get(identity.entryId);
    return {
      ...identity,
      profile: p ?? null,
      profileHash: p ? kivoProfileHash(p) : null,
    };
  });
}

test("raw Schale catalog objects and their internal keys remain unchanged during public projection", () => {
  const raw = [schale()];
  const initial = combineBirthdayCatalog([], [external(profile())]);
  const before = structuredClone(raw);
  const linked = profile(91001, { installed: true, gameEntryIds: [90001] });
  const result = combineBirthdayCatalog(
    raw,
    persist(initial, [linked]),
    initial.people,
  );
  assert.deepEqual(raw, before);
  assert.equal(raw[0].key, "schaledb:90001");
  assert.equal(result.people.length, 1);
  assert.equal(result.people[0].key, "kivo:91001");
  assert.equal(result.people[0].name, raw[0].name);
  assert.equal(result.people[0].originalEntryId, 90001);
});

test("only uninstalled Kivo people with known birthday publish a supplemental person", () => {
  const result = combineBirthdayCatalog([], [external(profile())]);
  assert.equal(result.people.length, 1);
  const person = result.people[0];
  assert.equal(person.key, "kivo:91001");
  assert.equal(person.notificationEligible, true);
  assert.deepEqual([person.month, person.day], [11, 11]);
  assert.equal(person.originalEntryId, null);
  assert.deepEqual(person.entryIds, []);
  assert.equal(person.birthdaySource?.source, "kivo");
  assert.equal(person.birthdaySource?.entryId, 91001);
  assert.equal(person.birthdaySource?.profileHash, kivoProfileHash(profile()));
  for (const p of [
    profile(91001, { installed: true }),
    profile(91001, { month: null, day: null }),
    profile(91001, { name: null }),
  ]) {
    assert.deepEqual(combineBirthdayCatalog([], [external(p)]).people, []);
  }
});

test("explicit skin membership deduplicates outfits and persists the group after edges disappear", () => {
  const original = profile(92002, {
    entryIds: [91001, 92002],
    originalEntryId: 92002,
    name: "合成原皮",
  });
  const outfit = profile(91001, {
    entryIds: [91001, 92002],
    originalEntryId: 92002,
    name: "合成换装",
  });
  const first = combineBirthdayCatalog(
    [],
    [external(outfit), external(original)],
  );
  assert.equal(first.people.length, 1);
  assert.equal(first.people[0].key, "kivo:92002");
  assert.equal(first.people[0].name, "合成原皮");
  assert.deepEqual(
    first.identities.map((p) => p.personKey),
    ["kivo:92002", "kivo:92002"],
  );
  const disconnected = [profile(91001), profile(92002, { name: "合成原皮" })];
  const next = combineBirthdayCatalog(
    [],
    persist(first, disconnected),
    first.people,
  );
  assert.equal(next.people.length, 1);
  assert.equal(next.people[0].key, "kivo:92002");
  assert.equal(new Set(next.identities.map((p) => p.personKey)).size, 1);
});

test("a later explicit game bridge keeps the original Kivo public key and survives dropped upstream game edges", () => {
  const first = combineBirthdayCatalog([], [external(profile())]);
  const linked = profile(91001, { installed: true, gameEntryIds: [90001] });
  const second = combineBirthdayCatalog(
    [schale()],
    persist(first, [linked]),
    first.people,
  );
  assert.deepEqual(
    second.people.map((p) => p.key),
    ["kivo:91001"],
  );
  assert.deepEqual(second.identities[0].gameEntryIds, [90001]);
  const third = combineBirthdayCatalog(
    [schale()],
    persist(second, [profile(91001, { installed: true })]),
    second.people,
  );
  assert.deepEqual(
    third.people.map((p) => p.key),
    ["kivo:91001"],
  );
  assert.deepEqual(third.identities[0].gameEntryIds, [90001]);
});

test("an already published Schale person accepts matching explicit Kivo entries without changing its key", () => {
  const raw = [schale()];
  const result = combineBirthdayCatalog(
    raw,
    [external(profile(91001, { gameEntryIds: [90001], installed: true }))],
    raw,
  );
  assert.deepEqual(result.people, raw);
  assert.equal(result.identities[0].personKey, "schaledb:90001");
  assert.equal(result.identities[0].status, "confirmed");
});

test("different game outfit IDs already confirmed as one Schale person deduplicate disconnected Kivo entries", () => {
  const raw = schale(90001, { entryIds: [90001, 90002] });
  const result = combineBirthdayCatalog(
    [raw],
    [
      external(profile(91001, { gameEntryIds: [90001], installed: true })),
      external(profile(92001, { gameEntryIds: [90002], installed: true })),
    ],
    [raw],
  );
  assert.deepEqual(result.people, [raw]);
  assert.deepEqual(
    result.identities.map((p) => p.personKey),
    ["schaledb:90001", "schaledb:90001"],
  );
  assert.deepEqual(
    result.identities.map((p) => p.gameEntryIds),
    [
      [90001, 90002],
      [90001, 90002],
    ],
  );
});

test("names alone never merge two Kivo people", () => {
  const result = combineBirthdayCatalog(
    [],
    [external(profile(91001)), external(profile(92001))],
  );
  assert.deepEqual(
    result.people.map((p) => p.key),
    ["kivo:91001", "kivo:92001"],
  );
  assert.deepEqual(
    result.identities.map((p) => p.personKey),
    ["kivo:91001", "kivo:92001"],
  );
});

test("a suspicious new Schale name is persistently blocked until an explicit bridge releases the hold", () => {
  const first = combineBirthdayCatalog([], [external(profile())]);
  const second = combineBirthdayCatalog(
    [schale()],
    persist(first, [profile()]),
    first.people,
  );
  assert.deepEqual(
    second.people.map((p) => p.key),
    ["kivo:91001"],
  );
  assert.deepEqual(second.identities[0].blockedKeys, ["schaledb:90001"]);
  assert.deepEqual(second.identities[0].gameEntryIds, []);
  const renamedRaw = schale(90001, {
    name: "另一个新译名",
    aliases: ["別名変更"],
  });
  const third = combineBirthdayCatalog(
    [renamedRaw],
    persist(second, [profile()]),
    second.people,
  );
  assert.deepEqual(
    third.people.map((p) => p.key),
    ["kivo:91001"],
  );
  assert.deepEqual(third.identities[0].blockedKeys, ["schaledb:90001"]);
  const fourth = combineBirthdayCatalog(
    [renamedRaw],
    persist(third, [
      profile(91001, { gameEntryIds: [90001], installed: true }),
    ]),
    third.people,
  );
  assert.deepEqual(
    fourth.people.map((p) => p.key),
    ["kivo:91001"],
  );
  assert.equal(fourth.people[0].name, renamedRaw.name);
  assert.deepEqual(fourth.identities[0].blockedKeys, []);
});

test("an explicit skin edge between two previously published Kivo keys quarantines both and remains pending", () => {
  const first = combineBirthdayCatalog(
    [],
    [
      external(profile(91001)),
      external(profile(92001, { name: "合成第二人" })),
    ],
  );
  const linked = [
    profile(91001, { entryIds: [91001, 92001] }),
    profile(92001, { entryIds: [91001, 92001] }),
  ];
  const second = combineBirthdayCatalog(
    [],
    persist(first, linked),
    first.people,
  );
  assert.deepEqual(
    second.identities.map((p) => p.status),
    ["pending", "pending"],
  );
  assert.deepEqual(
    second.identities.map((p) => p.personKey),
    ["kivo:91001", "kivo:92001"],
  );
  assert.equal(second.pendingGroups.length, 1);
  const third = combineBirthdayCatalog(
    [],
    persist(second, [profile(91001), profile(92001)]),
    second.people,
  );
  assert.ok(third.identities.every((p) => p.status === "pending"));
});

test("one Kivo group mapping to two distinct Schale people is quarantined rather than merged", () => {
  const raw = [schale(), schale(90002, { name: "合成第二人" })];
  const result = combineBirthdayCatalog(
    raw,
    [
      external(
        profile(91001, { gameEntryIds: [90001, 90002], installed: true }),
      ),
    ],
    raw,
  );
  assert.deepEqual(result.people, raw);
  assert.equal(result.identities[0].status, "pending");
  assert.equal(result.identities[0].personKey, null);
  assert.deepEqual(result.pendingGroups, [91001]);
});

test("a changed Kivo birthday freezes previous visible facts, disables reminders and stays pending after reversion", () => {
  const first = combineBirthdayCatalog([], [external(profile())]);
  const second = combineBirthdayCatalog(
    [],
    persist(first, [profile(91001, { day: 12 })]),
    first.people,
  );
  assert.equal(second.people[0].key, first.people[0].key);
  assert.equal(second.people[0].day, 11);
  assert.equal(second.people[0].notificationEligible, false);
  assert.equal(second.identities[0].status, "pending");
  const third = combineBirthdayCatalog(
    [],
    persist(second, [profile()]),
    second.people,
  );
  assert.equal(third.identities[0].status, "pending");
  assert.equal(third.people[0].notificationEligible, false);
});

test("corrupted cached facts and mismatched cache IDs are rejected before publishing", () => {
  const cached = external(profile());
  for (const patch of [
    { profileHash: "0".repeat(64) },
    { profile: { ...profile(), day: 12 } },
    { profile: { ...profile(), name: "bad\nname" } },
    { profile: profile(92001), profileHash: kivoProfileHash(profile(92001)) },
  ])
    assert.throws(
      () => combineBirthdayCatalog([], [{ ...cached, ...patch }]),
      /birthday_(external|kivo)_/,
    );
});

test("unfetched entries stay unknown while explicit skin members retain only their proven identity", () => {
  const unknown: ExternalBirthdayEntry = {
    entryId: 92001,
    personKey: null,
    status: "confirmed",
    blockedKeys: [],
    gameEntryIds: [],
    profile: null,
    profileHash: null,
  };
  const alone = combineBirthdayCatalog([], [unknown]);
  assert.deepEqual(alone.people, []);
  assert.equal(alone.identities[0].personKey, null);
  const partial = combineBirthdayCatalog(
    [],
    [external(profile(91001, { entryIds: [91001, 92001] })), unknown],
  );
  assert.deepEqual(
    partial.people.map((p) => p.key),
    ["kivo:91001"],
  );
  assert.deepEqual(
    partial.identities.map((p) => p.personKey),
    ["kivo:91001", "kivo:91001"],
  );
  const birthdaySource = partial.people[0].birthdaySource;
  assert.equal(birthdaySource?.source, "kivo");
  if (birthdaySource?.source === "kivo")
    assert.equal(birthdaySource.entryId, 91001);
});

test("an absent game ID is not proof of a published Schale identity", () => {
  const result = combineBirthdayCatalog(
    [],
    [external(profile(91001, { installed: true, gameEntryIds: [90001] }))],
  );
  assert.deepEqual(result.people, []);
  assert.equal(result.identities[0].personKey, null);
  assert.deepEqual(result.identities[0].gameEntryIds, []);
});

test("a bridge between two existing published public keys requires review instead of silently retiring a key", () => {
  const raw = schale();
  const first = combineBirthdayCatalog([], [external(profile())]);
  const previous = [...first.people, raw];
  const result = combineBirthdayCatalog(
    [raw],
    persist(first, [
      profile(91001, { installed: true, gameEntryIds: [90001] }),
    ]),
    previous,
  );
  assert.equal(result.identities[0].status, "pending");
  assert.equal(result.identities[0].personKey, "kivo:91001");
  assert.equal(result.pendingGroups.length, 1);
});

test("a new conflicting birthday bridge cannot replace a published Kivo key with an unreviewed Schale key", () => {
  const first = combineBirthdayCatalog([], [external(profile())]);
  const result = combineBirthdayCatalog(
    [schale(90001, { day: 12 })],
    persist(first, [
      profile(91001, { gameEntryIds: [90001], installed: true }),
    ]),
    first.people,
  );
  assert.equal(result.identities[0].status, "pending");
  assert.ok(
    result.people.some(
      (p) => p.key === "kivo:91001" && p.day === 11 && !p.notificationEligible,
    ),
  );
  assert.ok(!result.people.some((p) => p.key === "schaledb:90001"));
});
