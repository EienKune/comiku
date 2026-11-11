import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchKivoIndex,
  fetchKivoProfile,
  kivoProfileHash,
  readKivoProfile,
  validateKivoProfile,
} from "../src/birthdays/providers/kivo.js";

const student = (id = 9001) => ({
  id,
  family_name: "测试",
  given_name: "别名",
  family_name_cn: "测试",
  given_name_cn: "学生",
  family_name_jp: "試験",
  given_name_jp: "テスト",
  skin: "",
  avatar: "//static.kivo.wiki/images/students/synthetic/avatar.png",
});
const profile = (id = 9001) => ({
  ...student(id),
  birthday: "02-29",
  is_install: false,
  is_npc: false,
  skin_list: [
    { id, skin: "" },
    { id: id + 1, skin: "合成换装" },
  ],
  character_datas: [{ character_id: 0 }],
});
const envelope = (data: unknown) => ({ success: true, code: 2000, data });
function source(data: unknown) {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.href);
    assert.equal(url.origin, "https://api.kivo.wiki");
    assert.equal(init?.redirect, "manual");
    assert.ok(init?.signal);
    assert.equal(
      new Headers(init?.headers).get("User-Agent"),
      "Comiku-Birthday/1.0",
    );
    return Response.json(envelope(data));
  };
  return { fetch: fetcher, calls };
}

test("normalizes minimal profile without filtering non-NPC uninstalled students or treating zero as an ID", async () => {
  const fixture = source(profile());
  const result = await fetchKivoProfile(9001, fixture);
  assert.equal(result.name, "测试学生");
  assert.equal(result.japaneseName, "試験テスト");
  assert.deepEqual(result.aliases, ["测试别名", "試験テスト"]);
  assert.deepEqual(result.entryIds, [9001, 9002]);
  assert.deepEqual(result.gameEntryIds, []);
  assert.equal(result.originalEntryId, 9001);
  assert.equal(result.installed, false);
  assert.deepEqual([result.month, result.day], [2, 29]);
  assert.equal(
    result.avatarUrl,
    "https://static.kivo.wiki/images/students/synthetic/avatar.png",
  );
  assert.equal(
    fixture.calls[0],
    "https://api.kivo.wiki/api/v1/data/students/9001",
  );
  assert.deepEqual(
    Object.keys(result).sort(),
    [
      "id",
      "name",
      "aliases",
      "japaneseName",
      "month",
      "day",
      "entryIds",
      "gameEntryIds",
      "originalEntryId",
      "avatarUrl",
      "installed",
    ].sort(),
  );
});

test("missing Chinese localization stays null; unknown birthday stays null; explicit game IDs survive", async () => {
  const data: Record<string, unknown> = profile();
  delete data.given_name_cn;
  data.birthday = null;
  data.is_install = true;
  data.character_datas = [
    { character_id: 19001 },
    { character_id: 19001 },
    { character_id: 29001 },
  ];
  data.avatar = null;
  const result = await fetchKivoProfile(9001, source(data));
  assert.equal(result.name, null);
  assert.equal(result.month, null);
  assert.equal(result.day, null);
  assert.equal(result.avatarUrl, null);
  assert.equal(result.installed, true);
  assert.deepEqual(result.gameEntryIds, [19001, 29001]);
});

test("an unnamed background character does not reject a complete index or fabricate a name", async () => {
  const item = {
    id: 9001,
    family_name_cn: "",
    given_name_cn: "",
    family_name_jp: "",
    given_name_jp: " ",
    skin: "",
    avatar: null,
  };
  const index = await fetchKivoIndex({
    fetch: async () =>
      Response.json(envelope({ max_page: 1, students: [item] })),
  });
  assert.equal(index[0].name, null);
  assert.equal(index[0].japaneseName, "");
  const result = await fetchKivoProfile(
    9001,
    source({ ...profile(), ...item, birthday: null }),
  );
  assert.equal(result.name, null);
  assert.equal(result.japaneseName, "");
  assert.equal(result.month, null);
});

test("original Kivo entry follows unique empty skin metadata instead of the lowest entry ID", async () => {
  const data = profile();
  data.skin_list = [
    { id: 9001, skin: "合成换装" },
    { id: 9002, skin: "" },
  ];
  assert.equal(
    (await fetchKivoProfile(9001, source(data))).originalEntryId,
    9002,
  );
  for (const skins of [
    [
      { id: 9001, skin: "" },
      { id: 9002, skin: "" },
    ],
    [
      { id: 9001, skin: "合成换装" },
      { id: 9002, skin: "另一换装" },
    ],
  ]) {
    assert.equal(
      (await fetchKivoProfile(9001, source({ ...data, skin_list: skins })))
        .originalEntryId,
      null,
    );
  }
});

test("normalizes and hashes persisted minimal facts independently of object or collection ordering", async () => {
  const normalized = await fetchKivoProfile(9001, source(profile()));
  const permuted = {
    ...normalized,
    entryIds: [...normalized.entryIds].reverse(),
    aliases: [...normalized.aliases].reverse(),
  };
  assert.deepEqual(validateKivoProfile(permuted), normalized);
  assert.equal(kivoProfileHash(permuted), kivoProfileHash(normalized));
  assert.match(kivoProfileHash(normalized), /^[a-f0-9]{64}$/);
  assert.notEqual(
    kivoProfileHash({ ...normalized, day: 28 }),
    kivoProfileHash(normalized),
  );
});

test("persisted JSON enforces names, member limits, dates and trusted avatar independently of transport", async () => {
  const normalized = await fetchKivoProfile(9001, source(profile()));
  for (const patch of [
    { id: 0 },
    { installed: "false" },
    { name: "" },
    { name: "x".repeat(129) },
    { japaneseName: "bad\nname" },
    { aliases: Array(101).fill("alias") },
    { aliases: ["x".repeat(257)] },
    { aliases: [3] },
    { entryIds: [9002] },
    { entryIds: [9001, 9001] },
    { entryIds: [9001, -3] },
    { gameEntryIds: Array.from({ length: 101 }, (_, i) => i + 1) },
    { gameEntryIds: [0] },
    { month: null, day: 2 },
    { month: 2, day: 30 },
    { originalEntryId: 9999 },
    { avatarUrl: "https://evil.test/images/students/x.png" },
  ])
    assert.throws(
      () => readKivoProfile({ ...normalized, ...patch }),
      /^Error: birthday_kivo_/,
    );
});

test("rejects malformed profile fields, dates and associations", async () => {
  for (const patch of [
    { id: 9002 },
    { is_install: 1 },
    { birthday: "2-29" },
    { birthday: "02-30" },
    { birthday: "00-01" },
    { birthday: "01-00" },
    { birthday: undefined },
    { skin_list: [] },
    { skin_list: [{ id: 9001 }, { id: -1 }] },
    { skin_list: [{ id: 9002 }] },
    { character_datas: [{ character_id: -1 }] },
    { character_datas: [{ character_id: "19001" }] },
    { character_datas: [{}] },
    { given_name_cn: "bad\u0000name" },
    { given_name_jp: 123 },
  ])
    await assert.rejects(
      fetchKivoProfile(9001, source({ ...profile(), ...patch })),
      /^Error: birthday_kivo_/,
    );
  await assert.rejects(
    fetchKivoProfile(0, source(profile())),
    /birthday_kivo_invalid_id/,
  );
});

test("allows only normalized HTTPS static student avatar paths", async () => {
  for (const avatar of [
    "http://static.kivo.wiki/images/students/x.png",
    "https://static.kivo.wiki.evil.test/images/students/x.png",
    "https://user:password@static.kivo.wiki/images/students/x.png",
    "https://static.kivo.wiki/other/x.png",
    "https://static.kivo.wiki/images/students/../../x.png",
    "https://static.kivo.wiki/images/students/x.png?key=secret",
    "/images/students/x.png",
    "javascript:alert(1)",
  ])
    await assert.rejects(
      fetchKivoProfile(9001, source({ ...profile(), avatar })),
      /birthday_kivo_invalid_avatar/,
    );
});

test("fetches every bounded index page serially, preserving separate outfit IDs", async () => {
  const calls: number[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("page_size"), "50");
    const page = Number(url.searchParams.get("page"));
    calls.push(page);
    return Response.json(
      envelope({
        max_page: 2,
        students:
          page === 1
            ? Array.from({ length: 50 }, (_, i) => student(9001 + i))
            : [{ ...student(9100), skin: "合成换装" }],
      }),
    );
  };
  const result = await fetchKivoIndex({ fetch: fetcher });
  assert.deepEqual(calls, [1, 2]);
  assert.equal(result.length, 51);
  assert.equal(result[50].skin, "合成换装");
});

test("rejects missing, duplicated, oversized or changing index pages", async () => {
  for (const data of [
    { max_page: 0, students: [student()] },
    { max_page: 41, students: [student()] },
    { max_page: 1, students: [] },
    { max_page: 2, students: [student()] },
    { max_page: 1, students: [student(), student()] },
    {
      max_page: 1,
      students: Array.from({ length: 51 }, (_, i) => student(9001 + i)),
    },
  ])
    await assert.rejects(
      fetchKivoIndex(source(data)),
      /^Error: birthday_kivo_/,
    );
  for (const second of [
    { max_page: 3, students: [student(9900)] },
    { max_page: 2, students: [student(9001)] },
    { max_page: 2, students: [] },
  ]) {
    let call = 0;
    const fetcher: typeof fetch = async () =>
      Response.json(
        envelope(
          ++call === 1
            ? {
                max_page: 2,
                students: Array.from({ length: 50 }, (_, i) =>
                  student(9001 + i),
                ),
              }
            : second,
        ),
      );
    await assert.rejects(
      fetchKivoIndex({ fetch: fetcher }),
      /^Error: birthday_kivo_/,
    );
  }
});

test("source failures expose only finite codes, including invalid envelope and JSON", async () => {
  for (const response of [
    () => new Response("private upstream body", { status: 500 }),
    () => new Response("not json"),
    () => Response.json({ success: false, code: 2000, data: profile() }),
    () => Response.json({ success: true, code: 0, data: profile() }),
  ])
    await assert.rejects(
      fetchKivoProfile(9001, { fetch: async () => response() }),
      /^Error: birthday_kivo_[a-z_]+$/,
    );
  await assert.rejects(
    fetchKivoProfile(9001, {
      fetch: async () => {
        throw new Error("https://private.example/secret");
      },
    }),
    /^Error: birthday_kivo_failed$/,
  );
});

test("bounds declared and streamed bodies and cancels oversized streams", async () => {
  for (const invoke of [
    (fetcher: typeof fetch) => fetchKivoIndex({ fetch: fetcher }),
    (fetcher: typeof fetch) => fetchKivoProfile(9001, { fetch: fetcher }),
  ])
    await assert.rejects(
      invoke(
        async () =>
          new Response("", {
            headers: { "Content-Length": String(9 * 1024 * 1024) },
          }),
      ),
      /birthday_kivo_too_large/,
    );
  let cancelled = false;
  await assert.rejects(
    fetchKivoIndex({
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(1024 * 1024 + 1));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    }),
    /birthday_kivo_too_large/,
  );
  assert.equal(cancelled, true);
});

test("external abort interrupts both uncooperative fetch and stalled body streaming", async () => {
  for (const stalledBody of [false, true]) {
    const controller = new AbortController();
    let cancelled = false;
    const fetcher: typeof fetch = async () => {
      queueMicrotask(() => controller.abort());
      return stalledBody
        ? new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
          )
        : new Promise<Response>(() => {});
    };
    await assert.rejects(
      fetchKivoProfile(9001, { fetch: fetcher, signal: controller.signal }),
      /birthday_kivo_aborted/,
    );
    if (stalledBody) assert.equal(cancelled, true);
  }
});

test("redirects stay on the fixed API origin and are bounded", async () => {
  for (const location of [
    "https://evil.test/private",
    "http://api.kivo.wiki/path",
    "https://user:secret@api.kivo.wiki/path",
  ]) {
    await assert.rejects(
      fetchKivoProfile(9001, {
        fetch: async () =>
          new Response(null, { status: 302, headers: { location } }),
      }),
      /birthday_kivo_unsafe_redirect/,
    );
  }
  let calls = 0;
  const result = await fetchKivoProfile(9001, {
    fetch: async () =>
      ++calls === 1
        ? new Response(null, {
            status: 302,
            headers: { location: "/api/v1/data/students/9001/" },
          })
        : Response.json(envelope(profile())),
  });
  assert.equal(result.id, 9001);
  assert.equal(calls, 2);
  await assert.rejects(
    fetchKivoProfile(9001, {
      fetch: async () =>
        new Response(null, { status: 302, headers: { location: "/loop" } }),
    }),
    /birthday_kivo_invalid_redirect/,
  );
});
