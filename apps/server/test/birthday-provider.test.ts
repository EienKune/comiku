import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { fetchBirthdayCatalog } from "../src/birthdays/providers/schaledb.js";
import { reviewedRegistry } from "../src/birthdays/providers/reviewed-registry.js";
import { birthdayReminderCheckedAt } from "../src/birthdays/birthday-reminder.service.js";

const jp = (
  id: number,
  birthday = "11/11",
  alts: number[] = [],
  name = `生徒${id}`,
) => ({
  Id: id,
  Name: name,
  FamilyName: "苗字",
  PersonalName: name,
  BirthDay: birthday,
  Birthday: "localized display is never a date",
  IsReleased: [false, true],
  FavorAlts: alts,
});
const cn = (id: number, name = "测试") => ({
  Id: id,
  Name: name,
  FamilyName: "中文",
  PersonalName: name,
});
function fixture(
  entries: ReturnType<typeof jp>[],
  localized: Record<string, unknown>[] = entries.map((e) => cn(e.Id)),
) {
  const sources = {
    "/data/config.min.json": { Regions: [{ Name: "Global" }, { Name: "Jp" }] },
    "/data/jp/students.min.json": Object.fromEntries(
      entries.map((e) => [e.Id, e]),
    ),
    "/data/cn/students.min.json": Object.fromEntries(
      localized.map((e) => [e.Id, e]),
    ),
  };
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.href);
    assert.equal(url.origin, "https://schaledb.com");
    assert.equal(init?.redirect, "manual");
    assert.ok(init?.signal);
    assert.ok(url.pathname in sources, `Unexpected source: ${url.pathname}`);
    return Response.json(sources[url.pathname as keyof typeof sources]);
  };
  return { fetch: fetcher, calls };
}

test("reviewed registry merges outfits and uses CN full original name, aliases and avatar identity", async () => {
  const source = fixture(
    [
      jp(10000, "3/12", [10031], "アル"),
      jp(10031, "3/12", [10000], "アル（水着）"),
    ],
    [cn(10000, "爱露"), cn(10031, "爱露（水着）")],
  );
  const result = await fetchBirthdayCatalog(source);
  assert.equal(result.people.length, 1);
  assert.equal(result.people[0].name, "中文爱露");
  assert.equal(result.people[0].originalEntryId, 10000);
  assert.deepEqual(result.people[0].entryIds, [10000, 10031]);
  assert.ok(result.people[0].aliases.includes("陆八魔阿露"));
  assert.ok(result.people[0].aliases.includes("アル（水着）"));
  assert.equal(source.calls.length, 3);
  assert.match(result.contentHash, /^[a-f0-9]{64}$/);
  const again = await fetchBirthdayCatalog({
    ...source,
    previousPeople: result.people,
    identities: result.identities,
    previousCounts: result.sourceCounts,
  });
  assert.equal(again.contentHash, result.contentHash);
});

test("every reviewed original and outfit resolves from synthetic source data without changing permanent representatives", async () => {
  const allIds = [...new Set(reviewedRegistry.flatMap((p) => [...p.entryIds]))];
  const result = await fetchBirthdayCatalog(
    fixture(
      allIds.map((id) => jp(id)),
      allIds.map((id) =>
        id === 10100 ? { ...cn(id, "瞬"), Name: "幼女瞬" } : cn(id),
      ),
    ),
  );
  assert.equal(result.people.length, reviewedRegistry.length);
  assert.deepEqual(result.pendingEntryIds, []);
  for (const seed of reviewedRegistry) {
    const person = result.people.find((p) => p.key === seed.key)!;
    assert.equal(person.originalEntryId, seed.originalEntryId);
    assert.deepEqual(
      person.entryIds,
      [...seed.entryIds].sort((a, b) => a - b),
    );
  }
});

test("accepted birthday conflicts retain display facts but cannot renew reminders until explicitly reviewed", async () => {
  const now = new Date("2026-03-12T01:00:00Z");
  const source = (originalDate = "3/12") =>
    fixture([
      jp(10000, originalDate, [10031]),
      jp(10031, "3/12", [10000]),
      jp(90001, "4/4"),
    ]);
  const initial = await fetchBirthdayCatalog(source());
  assert.equal(initial.people[0].notificationEligible, true);
  const conflict = await fetchBirthdayCatalog({
    ...source("3/13"),
    previousPeople: initial.people,
    identities: initial.identities,
  });
  assert.deepEqual([conflict.people[0].month, conflict.people[0].day], [3, 12]);
  assert.equal(conflict.people[0].originalEntryId, 10000);
  assert.equal(
    conflict.identities.find((i) => i.entryId === 10000)?.status,
    "pending",
  );
  assert.equal(conflict.people[0].notificationEligible, false);
  assert.deepEqual(
    conflict.people.find((p) => p.key === "schaledb:90001"),
    initial.people.find((p) => p.key === "schaledb:90001"),
  );
  assert.equal(
    birthdayReminderCheckedAt(conflict.people[0], now, undefined, now),
    null,
  );
  const reverted = await fetchBirthdayCatalog({
    ...source(),
    previousPeople: conflict.people,
    identities: conflict.identities,
  });
  assert.equal(reverted.people[0].notificationEligible, false);
  assert.deepEqual(
    reverted.people.find((p) => p.key === "schaledb:90001"),
    initial.people.find((p) => p.key === "schaledb:90001"),
  );
  assert.equal(
    reverted.identities.find((i) => i.entryId === 10000)?.status,
    "pending",
  );
  assert.equal(
    birthdayReminderCheckedAt(reverted.people[0], now, undefined, now),
    null,
  );
  const reviewed = await fetchBirthdayCatalog({
    ...source(),
    previousPeople: reverted.people,
    identities: reverted.identities.map((identity) => ({
      ...identity,
      status: "confirmed" as const,
    })),
  });
  assert.equal(reviewed.people[0].notificationEligible, true);
  assert.equal(
    birthdayReminderCheckedAt(reviewed.people[0], now, undefined, now),
    now,
  );
});

test("an unaccepted conflicting outfit does not suspend a confirmed original's reminders", async () => {
  const initial = await fetchBirthdayCatalog(fixture([jp(10000, "3/12")]));
  const result = await fetchBirthdayCatalog({
    ...fixture([jp(10000, "3/12"), jp(90000, "3/13", [10000])]),
    previousPeople: initial.people,
    identities: initial.identities,
  });
  assert.deepEqual(result.pendingEntryIds, [90000]);
  assert.deepEqual(result.people[0].entryIds, [10000]);
  assert.equal(result.people[0].notificationEligible, true);
  const now = new Date("2026-03-12T01:00:00Z");
  assert.equal(
    birthdayReminderCheckedAt(result.people[0], now, undefined, now),
    now,
  );
});

test("JP region flag governs release; exact BirthDay preserves unknown and real leap day", async () => {
  const unreleased = jp(90002);
  unreleased.IsReleased = [true, false];
  const result = await fetchBirthdayCatalog(
    fixture([jp(90000, "-"), jp(90001, "2/29"), unreleased]),
  );
  assert.deepEqual(
    result.people.map((p) => [p.month, p.day]),
    [
      [null, null],
      [2, 29],
    ],
  );
  assert.equal(result.people[0].notificationEligible, false);
  assert.equal(result.people[1].originalEntryId, null);
  assert.deepEqual(result.sourceCounts, { jp: 2, cn: 3 });
});

test("Shun swimsuit is a reviewed exception and 10100 stays independent", async () => {
  const result = await fetchBirthdayCatalog(
    fixture(
      [
        jp(10011, "2/5", [], "シュン"),
        jp(10144, "2/5", [], "シュン（水着）"),
        jp(10100, "2/5", [10011], "シュン"),
      ],
      [
        cn(10011, "瞬"),
        cn(10144, "瞬"),
        { ...cn(10100, "瞬"), Name: "幼女瞬" },
      ],
    ),
  );
  assert.equal(result.people.length, 2);
  assert.deepEqual(
    result.people.find((p) => p.key === "schaledb:10011")?.entryIds,
    [10011, 10144],
  );
  assert.deepEqual(
    result.people.find((p) => p.key === "schaledb:10100")?.entryIds,
    [10100],
  );
});

test("persisted people are never merged; new bridge and changed birthdays are quarantined independently", async () => {
  const first = await fetchBirthdayCatalog(
    fixture([jp(90000), jp(90001)], [cn(90000, "甲"), cn(90001, "乙")]),
  );
  const next = await fetchBirthdayCatalog({
    ...fixture(
      [
        jp(90000, "11/12"),
        jp(90001),
        jp(90002, "11/11", [90000, 90001]),
        jp(90003, "11/11", [90001]),
      ],
      [cn(90000, "甲"), cn(90001, "乙"), cn(90002), cn(90003)],
    ),
    previousPeople: first.people,
    identities: first.identities,
  });
  assert.equal(next.people.length, 2);
  assert.deepEqual(next.pendingEntryIds, [90000, 90002]);
  assert.deepEqual(
    next.people.find((p) => p.key === "schaledb:90000")?.entryIds,
    [90000],
  );
  assert.equal(next.people.find((p) => p.key === "schaledb:90000")?.day, 11);
  assert.deepEqual(
    next.people.find((p) => p.key === "schaledb:90001")?.entryIds,
    [90001, 90003],
  );
  assert.equal(
    next.identities.find((i) => i.entryId === 90000)?.status,
    "pending",
  );
  const unchanged = await fetchBirthdayCatalog({
    ...fixture(
      [jp(90000), jp(90001), jp(90002), jp(90003, "11/11", [90001])],
      [cn(90000, "甲"), cn(90001, "乙"), cn(90002), cn(90003)],
    ),
    previousPeople: next.people,
    identities: next.identities,
  });
  assert.deepEqual(unchanged.pendingEntryIds, [90000, 90002]);
});

test("disconnected duplicate names are quarantined; conflicting birthday component does not create a person", async () => {
  const first = await fetchBirthdayCatalog(
    fixture([jp(90000)], [cn(90000, "甲")]),
  );
  const result = await fetchBirthdayCatalog({
    ...fixture(
      [
        jp(90000),
        jp(90001, "11/11", [], "生徒90000"),
        jp(90002, "11/11", [90003]),
        jp(90003, "11/12"),
      ],
      [cn(90000, "甲"), cn(90001), cn(90002), cn(90003)],
    ),
    previousPeople: first.people,
  });
  assert.equal(result.people.length, 1);
  assert.deepEqual(result.pendingEntryIds, [90001, 90002, 90003]);
});

test("FavorAlts is undirected and never infers an original skin for a new person", async () => {
  const result = await fetchBirthdayCatalog(
    fixture(
      [jp(90000), jp(90001, "11/11", [90000])],
      [cn(90000, "甲"), cn(90001, "甲")],
    ),
  );
  assert.equal(result.people.length, 1);
  assert.deepEqual(result.people[0].entryIds, [90000, 90001]);
  assert.equal(result.people[0].originalEntryId, null);
});

test("CN failure rejects the complete candidate without mutating previous snapshots", async () => {
  const first = await fetchBirthdayCatalog(fixture([jp(90000)]));
  const previous = structuredClone(first.people);
  await assert.rejects(
    fetchBirthdayCatalog({
      ...fixture([jp(90000)], []),
      previousPeople: first.people,
    }),
    /chinese/,
  );
  await assert.rejects(
    fetchBirthdayCatalog({
      ...fixture([jp(90000)], [{ ...cn(90000), PersonalName: "Japanese" }]),
      previousPeople: first.people,
    }),
    /chinese/,
  );
  await assert.rejects(
    fetchBirthdayCatalog({
      ...fixture(
        [jp(90000)],
        [
          { Id: 90000, Name: "甲", PersonalName: "甲" } as ReturnType<
            typeof cn
          >,
        ],
      ),
      previousPeople: first.people,
    }),
    /chinese/,
  );
  assert.deepEqual(first.people, previous);
});

test("source declines beyond ten percent are rejected for both JP and CN", async () => {
  await assert.rejects(
    fetchBirthdayCatalog({
      ...fixture([jp(90000)]),
      previousCounts: { jp: 2, cn: 1 },
    }),
    /count_decline/,
  );
  await assert.rejects(
    fetchBirthdayCatalog({
      ...fixture([jp(90000)]),
      previousCounts: { jp: 1, cn: 2 },
    }),
    /count_decline/,
  );
  const ten = Array.from({ length: 9 }, (_, i) => jp(90000 + i));
  assert.equal(
    (
      await fetchBirthdayCatalog({
        ...fixture(ten),
        previousCounts: { jp: 10, cn: 10 },
      })
    ).people.length,
    9,
  );
});

test("invalid release flags, region and impossible birthdays reject all data", async () => {
  const badDate = fixture([jp(90000, "2/30")]);
  await assert.rejects(fetchBirthdayCatalog(badDate), /invalid_date/);
  const malformed = jp(90000);
  malformed.IsReleased = [false, 1 as unknown as boolean];
  await assert.rejects(
    fetchBirthdayCatalog(fixture([malformed])),
    /invalid_entry/,
  );
  await assert.rejects(
    fetchBirthdayCatalog({
      fetch: async () =>
        Response.json({ Regions: [{ Name: "Jp" }, { Name: "Jp" }] }),
    }),
    /invalid_regions/,
  );
});

test("redirects are manual, same HTTPS origin only and bounded", async () => {
  const source = fixture([jp(90000)]);
  let redirected = false;
  const fetcher: typeof fetch = async (url, init) => {
    if (!redirected) {
      redirected = true;
      return new Response(null, {
        status: 302,
        headers: { location: "/data/config.min.json?mirror=1" },
      });
    }
    return source.fetch(url, init);
  };
  assert.equal(
    (await fetchBirthdayCatalog({ fetch: fetcher })).people.length,
    1,
  );
  for (const target of [
    "http://schaledb.com/data",
    "https://evil.test/data",
    "https://schaledb.com:8443/data",
    "https://user:secret@schaledb.com/data",
  ]) {
    await assert.rejects(
      fetchBirthdayCatalog({
        fetch: async () =>
          new Response(null, { status: 302, headers: { location: target } }),
      }),
      /unsafe_redirect/,
    );
  }
  let calls = 0;
  await assert.rejects(
    fetchBirthdayCatalog({
      fetch: async () => {
        calls++;
        return new Response(null, {
          status: 302,
          headers: { location: "/loop" },
        });
      },
    }),
    /invalid_redirect/,
  );
  assert.equal(calls, 4);
});

test("body limit applies to headers and streamed chunks; caller cancellation covers headers and body", async () => {
  await assert.rejects(
    fetchBirthdayCatalog({
      fetch: async () =>
        new Response("{}", {
          headers: { "content-length": String(8 * 1024 * 1024 + 1) },
        }),
    }),
    /too_large/,
  );
  await assert.rejects(
    fetchBirthdayCatalog({
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(8 * 1024 * 1024));
              controller.enqueue(new Uint8Array(1));
              controller.close();
            },
          }),
        ),
    }),
    /too_large/,
  );
  const headersController = new AbortController();
  const headers = fetchBirthdayCatalog({
    signal: headersController.signal,
    fetch: async () => {
      headersController.abort(new Error("cancel headers"));
      return new Promise<Response>(() => {});
    },
  });
  await assert.rejects(headers, /source_aborted/);
  const bodyController = new AbortController();
  const body = fetchBirthdayCatalog({
    signal: bodyController.signal,
    fetch: async () =>
      new Response(
        new ReadableStream({
          pull() {
            bodyController.abort(new Error("cancel body"));
          },
        }),
      ),
  });
  await assert.rejects(body, /source_aborted/);
});

test("request and total deadlines are applied to all fetches and remain active through streamed bodies", async () => {
  const original = AbortSignal.timeout;
  const durations: number[] = [];
  const controllers: AbortController[] = [];
  AbortSignal.timeout = (duration) => {
    durations.push(duration);
    const controller = new AbortController();
    controllers.push(controller);
    return controller.signal;
  };
  try {
    await fetchBirthdayCatalog(fixture([jp(90000)]));
    assert.deepEqual(durations, [60_000, 20_000, 20_000, 20_000]);
    const fetcher: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          pull() {
            controllers
              .at(-1)!
              .abort(
                new DOMException("upstream sensitive details", "TimeoutError"),
              );
          },
        }),
      );
    await assert.rejects(
      fetchBirthdayCatalog({ fetch: fetcher }),
      /^Error: birthday_source_timeout$/,
    );
    const stalled: typeof fetch = async () => {
      controllers
        .at(-2)!
        .abort(new DOMException("total timeout", "TimeoutError"));
      return new Promise<Response>(() => {});
    };
    await assert.rejects(
      fetchBirthdayCatalog({ fetch: stalled }),
      /source_timeout/,
    );
  } finally {
    AbortSignal.timeout = original;
  }
});

test("arbitrary network and invalid JSON failures expose bounded codes without source content", async () => {
  await assert.rejects(
    fetchBirthdayCatalog({
      fetch: async () => {
        throw new Error("secret upstream URL");
      },
    }),
    /^Error: birthday_source_failed$/,
  );
  await assert.rejects(
    fetchBirthdayCatalog({
      fetch: async () => {
        throw new Error("birthday_untrusted_arbitrary_code");
      },
    }),
    /^Error: birthday_source_failed$/,
  );
  await assert.rejects(
    fetchBirthdayCatalog({
      fetch: async () => new Response("private body is invalid JSON"),
    }),
    /^Error: birthday_invalid_json$/,
  );
});

test("JP and CN names reject controls, bidi overrides and line separators before trimming", async () => {
  for (const unsafe of ["\n生徒", "生\u0000徒", "\u202e生徒", "生\u2028徒"]) {
    await assert.rejects(
      fetchBirthdayCatalog(fixture([jp(90000, "11/11", [], unsafe)])),
      /invalid_name/,
    );
    await assert.rejects(
      fetchBirthdayCatalog(fixture([{ ...jp(90000), FamilyName: unsafe }])),
      /invalid_name/,
    );
    await assert.rejects(
      fetchBirthdayCatalog(
        fixture([jp(90000)], [{ ...cn(90000), Name: unsafe }]),
      ),
      /invalid_name/,
    );
    await assert.rejects(
      fetchBirthdayCatalog(
        fixture([jp(90000)], [{ ...cn(90000), PersonalName: unsafe }]),
      ),
      /invalid_name/,
    );
  }
});

test("persisted mapping to absent target is rejected", async () => {
  await assert.rejects(
    fetchBirthdayCatalog({
      ...fixture([jp(90000)]),
      identities: [
        {
          entryId: 90000,
          personKey: "missing",
          originalEntryId: null,
          status: "confirmed",
        },
      ],
    }),
    /persisted_identity/,
  );
});

test("new untranslated identities are held separately and recover automatically after CN localization", async () => {
  const jpEntries = [
    jp(90000, "11/11", [], "既有人物"),
    jp(90001, "6/13", [90002], "カナ"),
    jp(90002, "6/13", [], "カナ（水着）"),
  ];
  const first = await fetchBirthdayCatalog(
    fixture(jpEntries, [cn(90000, "甲"), cn(90001, "カナ"), cn(90002, "カナ")]),
  );
  assert.deepEqual(
    first.people.map((p) => p.key),
    ["schaledb:90000"],
  );
  assert.deepEqual(first.pendingEntryIds, [90001, 90002]);
  assert.ok(
    first.identities
      .filter((i) => i.entryId !== 90000)
      .every(
        (i) =>
          i.status === "unlocalized" &&
          i.personKey === "schaledb:90001" &&
          i.originalEntryId === null,
      ),
  );
  const stillHeld = await fetchBirthdayCatalog({
    ...fixture(jpEntries, [
      cn(90000, "甲"),
      cn(90001, "カナ"),
      cn(90002, "カナ"),
    ]),
    previousPeople: first.people,
    identities: first.identities,
  });
  assert.equal(stillHeld.contentHash, first.contentHash);
  const recovered = await fetchBirthdayCatalog({
    ...fixture(jpEntries, [
      cn(90000, "甲"),
      cn(90001, "新学生"),
      cn(90002, "新学生"),
    ]),
    previousPeople: stillHeld.people,
    identities: stillHeld.identities,
  });
  assert.equal(recovered.people.length, 2);
  assert.equal(
    recovered.people.find((p) => p.key === "schaledb:90001")?.name,
    "中文新学生",
  );
  assert.deepEqual(recovered.pendingEntryIds, []);
  assert.ok(recovered.identities.every((i) => i.status === "confirmed"));
  const permanentReview = first.identities.map((i) =>
    i.status === "unlocalized"
      ? { ...i, personKey: "", status: "pending" as const }
      : i,
  );
  const remainsPending = await fetchBirthdayCatalog({
    ...fixture(jpEntries),
    previousPeople: first.people,
    identities: permanentReview,
  });
  assert.equal(remainsPending.people.length, 1);
  assert.deepEqual(remainsPending.pendingEntryIds, [90001, 90002]);
});

test("loss of Chinese localization for a published or reviewed-registry person rejects the candidate", async () => {
  const published = await fetchBirthdayCatalog(fixture([jp(90000)]));
  await assert.rejects(
    fetchBirthdayCatalog({
      ...fixture([jp(90000)], [cn(90000, "カナ")]),
      previousPeople: published.people,
      identities: published.identities,
    }),
    /invalid_chinese_name/,
  );
  await assert.rejects(
    fetchBirthdayCatalog(fixture([jp(10000)], [cn(10000, "カナ")])),
    /invalid_chinese_name/,
  );
});

const localizationGaps = [
  () => undefined,
  (id: number) => ({ ...cn(id), FamilyName: null }),
  (id: number) => ({ Id: id, Name: "新学生", PersonalName: "新学生" }),
  (id: number) => ({ ...cn(id), PersonalName: null }),
  (id: number) => ({ ...cn(id), PersonalName: "" }),
  (id: number) => ({ ...cn(id), PersonalName: "  " }),
  (id: number) => ({ Id: id, Name: "新学生", FamilyName: "中文" }),
];

test("new localization gaps retain the published catalog and recover under the same held key", async () => {
  const published = await fetchBirthdayCatalog(fixture([jp(90000)]));
  const entries = [jp(90000), jp(90001, "6/13", [], "カナ")];
  for (const gap of localizationGaps) {
    const missing = gap(90001);
    const source = fixture(entries, [cn(90000), ...(missing ? [missing] : [])]);
    const first = await fetchBirthdayCatalog({
      ...source,
      previousPeople: published.people,
      identities: published.identities,
    });
    assert.deepEqual(first.people, published.people);
    assert.deepEqual(first.pendingEntryIds, [90001]);
    assert.deepEqual(
      first.identities.find((identity) => identity.entryId === 90001),
      {
        entryId: 90001,
        personKey: "schaledb:90001",
        originalEntryId: null,
        status: "unlocalized",
      },
    );
    const held = await fetchBirthdayCatalog({
      ...source,
      previousPeople: first.people,
      identities: first.identities,
    });
    assert.equal(held.contentHash, first.contentHash);
    const recovered = await fetchBirthdayCatalog({
      ...fixture(entries, [cn(90000), cn(90001, "新学生")]),
      previousPeople: held.people,
      identities: held.identities,
    });
    assert.equal(recovered.people.length, 2);
    assert.equal(
      recovered.people.find((person) => person.key === "schaledb:90001")?.name,
      "中文新学生",
    );
    assert.deepEqual(recovered.pendingEntryIds, []);
    assert.equal(
      recovered.identities.find((identity) => identity.entryId === 90001)
        ?.status,
      "confirmed",
    );
  }
});

test("the same localization gaps still reject published and registry people", async () => {
  const published = await fetchBirthdayCatalog(fixture([jp(90000)]));
  for (const gap of localizationGaps) {
    for (const id of [90000, 10000]) {
      const missing = gap(id);
      await assert.rejects(
        fetchBirthdayCatalog({
          ...fixture(
            [jp(id), jp(90002)],
            [cn(90002), ...(missing ? [missing] : [])],
          ),
          ...(id === 90000
            ? {
                previousPeople: published.people,
                identities: published.identities,
              }
            : {}),
        }),
        /birthday_(missing_chinese_name|invalid_name)/,
      );
    }
  }
});

test("a new localization gap never absorbs malformed field types or unsafe text", async () => {
  for (const bad of [
    { Id: 90001, Name: "新学生", PersonalName: "\u202e新学生" },
    { Id: 90001, Name: "新学生", PersonalName: 1 },
    { Id: 90001, Name: "新学生", FamilyName: 1, PersonalName: "" },
  ]) {
    await assert.rejects(
      fetchBirthdayCatalog(fixture([jp(90000), jp(90001)], [cn(90000), bad])),
      /birthday_invalid_name/,
    );
  }
});

test("localization recovery retains its canonical boundary when FavorAlts points to an existing person", async () => {
  const first = await fetchBirthdayCatalog(
    fixture([jp(90000), jp(90001)], [cn(90000, "カナ"), cn(90001, "甲")]),
  );
  const result = await fetchBirthdayCatalog({
    ...fixture(
      [jp(90000, "11/11", [90001]), jp(90001)],
      [cn(90000, "新学生"), cn(90001, "甲")],
    ),
    previousPeople: first.people,
    identities: first.identities,
  });
  assert.deepEqual(
    result.people.map((p) => [p.key, p.entryIds]),
    [["schaledb:90001", [90001]]],
  );
  assert.deepEqual(result.pendingEntryIds, [90000]);
  assert.equal(
    result.identities.find((i) => i.entryId === 90000)?.personKey,
    "schaledb:90000",
  );
  assert.equal(
    result.identities.find((i) => i.entryId === 90000)?.status,
    "pending",
  );
  const retried = await fetchBirthdayCatalog({
    ...fixture([jp(90000), jp(90001)], [cn(90000, "新学生"), cn(90001, "甲")]),
    previousPeople: result.people,
    identities: result.identities,
  });
  assert.deepEqual(
    retried.people.map((p) => p.key),
    ["schaledb:90001"],
  );
  assert.deepEqual(retried.identities, result.identities);
});

test("localization recovery retains group membership and canonical key after association edges disappear", async () => {
  const first = await fetchBirthdayCatalog(
    fixture(
      [jp(90000, "11/11", [90002]), jp(90002)],
      [cn(90000, "カナ"), cn(90002, "カナ")],
    ),
  );
  const result = await fetchBirthdayCatalog({
    ...fixture(
      [jp(90000), jp(90002)],
      [cn(90000, "新学生"), cn(90002, "新学生")],
    ),
    previousPeople: first.people,
    identities: first.identities,
  });
  assert.equal(result.people.length, 1);
  assert.equal(result.people[0].key, "schaledb:90000");
  assert.deepEqual(result.people[0].entryIds, [90000, 90002]);
  assert.deepEqual(result.pendingEntryIds, []);
});

test("separately held identities cannot merge through a later association and stay pending after it disappears", async () => {
  const first = await fetchBirthdayCatalog(
    fixture([jp(90000), jp(90001)], [cn(90000, "カナ"), cn(90001, "ラナ")]),
  );
  const source = fixture(
    [jp(90000, "11/11", [90001]), jp(90001)],
    [cn(90000, "甲"), cn(90001, "乙")],
  );
  const conflict = await fetchBirthdayCatalog({
    ...source,
    previousPeople: first.people,
    identities: first.identities,
  });
  assert.deepEqual(conflict.people, []);
  assert.deepEqual(
    conflict.identities.map((i) => [i.personKey, i.status]),
    [
      ["schaledb:90000", "pending"],
      ["schaledb:90001", "pending"],
    ],
  );
  const disconnected = await fetchBirthdayCatalog({
    ...fixture([jp(90000), jp(90001)], [cn(90000, "甲"), cn(90001, "乙")]),
    previousPeople: conflict.people,
    identities: conflict.identities,
  });
  assert.deepEqual(disconnected.people, []);
  assert.deepEqual(disconnected.identities, conflict.identities);
  assert.deepEqual(disconnected.pendingEntryIds, [90000, 90001]);
});

test("a held group's conflicting birthdays require review without reviving its members", async () => {
  const first = await fetchBirthdayCatalog(
    fixture(
      [jp(90000, "11/11", [90002]), jp(90002)],
      [cn(90000, "カナ"), cn(90002, "カナ")],
    ),
  );
  const conflict = await fetchBirthdayCatalog({
    ...fixture([jp(90000), jp(90002, "11/12")]),
    previousPeople: first.people,
    identities: first.identities,
  });
  assert.deepEqual(conflict.people, []);
  assert.ok(
    conflict.identities.every(
      (i) => i.status === "pending" && i.personKey === "schaledb:90000",
    ),
  );
  const retried = await fetchBirthdayCatalog({
    ...fixture([jp(90000), jp(90002)]),
    previousPeople: conflict.people,
    identities: conflict.identities,
  });
  assert.deepEqual(retried.people, []);
  assert.deepEqual(retried.identities, conflict.identities);
});

test("new outfits can join a held identity without changing its canonical key", async () => {
  const first = await fetchBirthdayCatalog(
    fixture([jp(90000)], [cn(90000, "カナ")]),
  );
  const extended = await fetchBirthdayCatalog({
    ...fixture(
      [jp(90000), jp(90002, "11/11", [90000])],
      [cn(90000, "カナ"), cn(90002)],
    ),
    previousPeople: first.people,
    identities: first.identities,
  });
  assert.deepEqual(extended.people, []);
  assert.ok(
    extended.identities.every(
      (i) => i.personKey === "schaledb:90000" && i.status === "unlocalized",
    ),
  );
  const recovered = await fetchBirthdayCatalog({
    ...fixture([jp(90000), jp(90002)]),
    previousPeople: extended.people,
    identities: extended.identities,
  });
  assert.deepEqual(
    recovered.people.map((p) => [p.key, p.entryIds, p.originalEntryId]),
    [["schaledb:90000", [90000, 90002], null]],
  );
});

test("persisted localization holds require a complete nonregistry canonical group and an allowlisted status", async () => {
  const base = {
    entryId: 90000,
    personKey: "schaledb:90000",
    originalEntryId: null,
    status: "unlocalized" as const,
  };
  for (const identity of [
    { ...base, status: "unknown" },
    { ...base, personKey: "schaledb:90001" },
    { ...base, originalEntryId: 90000 },
    { ...base, entryId: 10000, personKey: "schaledb:10000" },
  ]) {
    await assert.rejects(
      fetchBirthdayCatalog({
        ...fixture([jp(90000)]),
        identities: [identity as typeof base],
      }),
      /invalid_persisted_identity/,
    );
  }
});

test("an untranslated new outfit does not hide its already localized reviewed person", async () => {
  const result = await fetchBirthdayCatalog(
    fixture(
      [jp(10000), jp(90000, "11/11", [10000])],
      [cn(10000, "爱露"), cn(90000, "アル（レーシング）")],
    ),
  );
  assert.equal(result.people.length, 1);
  assert.equal(result.people[0].name, "中文爱露");
  assert.equal(result.people[0].originalEntryId, 10000);
  assert.deepEqual(result.people[0].entryIds, [10000, 90000]);
  assert.deepEqual(result.pendingEntryIds, []);
});

test("an association to a wholly absent held group cannot publish a replacement under its key", async () => {
  const first = await fetchBirthdayCatalog(
    fixture([jp(90000)], [cn(90000, "カナ")]),
  );
  const result = await fetchBirthdayCatalog({
    ...fixture([jp(90001, "11/11", [90000])]),
    previousPeople: first.people,
    identities: first.identities,
  });
  assert.deepEqual(result.people, []);
  assert.deepEqual(result.identities[0], first.identities[0]);
  assert.equal(result.identities[1].personKey, "");
  assert.equal(result.identities[1].status, "pending");
});

test("a confirmed persisted review promotes a discovered original and survives future refreshes", async () => {
  const source = fixture(
    [jp(90000), jp(90001, "11/11", [90000])],
    [cn(90000, "甲"), cn(90001, "乙")],
  );
  const discovered = await fetchBirthdayCatalog(source);
  assert.equal(discovered.people[0].originalEntryId, null);
  const reviewed = await fetchBirthdayCatalog({
    ...source,
    previousPeople: discovered.people,
    identities: discovered.identities.map((i) =>
      i.entryId === 90001 ? { ...i, originalEntryId: 90001 } : i,
    ),
  });
  assert.equal(reviewed.people[0].originalEntryId, 90001);
  assert.equal(reviewed.people[0].name, "中文乙");
  assert.ok(reviewed.identities.every((i) => i.originalEntryId === 90001));
  assert.equal(discovered.people[0].originalEntryId, null);
  const refreshed = await fetchBirthdayCatalog({
    ...source,
    previousPeople: reviewed.people,
    identities: reviewed.identities,
  });
  assert.equal(refreshed.people[0].originalEntryId, 90001);
  assert.equal(refreshed.contentHash, reviewed.contentHash);
});

test("pending, foreign and conflicting original reviews cannot replace permanent identity facts", async () => {
  const source = fixture(
    [jp(90000), jp(90001)],
    [cn(90000, "甲"), cn(90001, "乙")],
  );
  const discovered = await fetchBirthdayCatalog(source);
  const pending = await fetchBirthdayCatalog({
    ...source,
    previousPeople: discovered.people,
    identities: discovered.identities.map((i) =>
      i.entryId === 90000
        ? { ...i, status: "pending", originalEntryId: 90000 }
        : i,
    ),
  });
  assert.equal(
    pending.people.find((p) => p.key === "schaledb:90000")?.originalEntryId,
    null,
  );
  assert.equal(
    pending.identities.find((i) => i.entryId === 90000)?.originalEntryId,
    90000,
  );
  await assert.rejects(
    fetchBirthdayCatalog({
      ...source,
      previousPeople: discovered.people,
      identities: discovered.identities.map((i) =>
        i.entryId === 90000 ? { ...i, originalEntryId: 90001 } : i,
      ),
    }),
    /original_identity_conflict/,
  );
  const grouped = await fetchBirthdayCatalog(
    fixture([jp(90000), jp(90001, "11/11", [90000])]),
  );
  await assert.rejects(
    fetchBirthdayCatalog({
      ...fixture([jp(90000), jp(90001, "11/11", [90000])]),
      previousPeople: grouped.people,
      identities: grouped.identities.map((i) => ({
        ...i,
        originalEntryId: i.entryId,
      })),
    }),
    /original_identity_conflict/,
  );
});
