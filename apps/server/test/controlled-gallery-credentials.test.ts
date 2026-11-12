import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  ControlledGalleryCredentials,
  CredentialFileError,
} from "../src/source-ingestion/adapters/gallery-dl/controlled-gallery-credentials.js";

// Windows cannot attest POSIX permissions. Only these synthetic filesystem tests
// skip that assertion; the production class refuses native Windows maintenance.
class TestStore extends ControlledGalleryCredentials {
  protected override assertPrivate(info: Stats, directory: boolean): void {
    if (process.platform !== "win32") super.assertPrivate(info, directory);
  }
  protected override async syncDirectory(path: string): Promise<void> {
    if (process.platform !== "win32") await super.syncDirectory(path);
  }
}

async function fixture(
  t: test.TestContext,
  config: object = {
    extractor: { twitter: { cookies: "cookies.txt", retries: 2 } },
    output: { mode: "null" },
  },
) {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "comiku-credentials-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configPath = join(root, "gallery.json");
  const stateDirectory = join(root, "state");
  await fs.chmod(root, 0o700);
  await fs.mkdir(stateDirectory, { mode: 0o700 });
  const configured = JSON.stringify(config).replace(
    '"cookies.txt"',
    JSON.stringify(join(root, "cookies.txt")),
  );
  await fs.writeFile(configPath, configured, { mode: 0o600 });
  await fs.writeFile(join(root, "cookies.txt"), "synthetic-old-cookie", {
    mode: 0o600,
  });
  const options = {
    stateDirectory,
    configPaths: JSON.stringify(config).includes('"pixiv"')
      ? { pixiv: configPath }
      : { x: configPath },
  };
  return {
    root,
    configPath,
    stateDirectory,
    options,
    store: new TestStore(options),
  };
}

const xInput = {
  platform: "x" as const,
  authToken: " synthetic-auth ",
  ct0: " synthetic-csrf ",
};
const errorCode = (code: string) => (error: unknown) =>
  error instanceof CredentialFileError && error.code === code;

test("mutable browser cookies and relative or expanded references cannot enter a controlled baseline", async (t) => {
  for (const options of [
    { "cookies-from-browser": ["chrome"] },
    { cookies: "relative.txt" },
    { cookies: "/private/$COOKIE_FILE" },
    { cookies: "/private/%COOKIE_FILE%" },
  ]) {
    const f = await fixture(t, { extractor: { twitter: options } });
    await assert.rejects(
      f.store.inspect("x"),
      errorCode("invalid_configuration"),
    );
  }
});

test("credential reads enforce the same aggregate budget as the platform fingerprint", async (t) => {
  const f = await fixture(t);
  const config: Record<string, object> = {};
  for (let index = 0; index < 4; index++) {
    const path = join(f.root, `cookie-${index}.txt`);
    await fs.writeFile(path, "a".repeat(1024 * 1024), { mode: 0o600 });
    config[`source-${index}`] = { cookies: path };
  }
  await fs.writeFile(
    f.configPath,
    JSON.stringify({
      extractor: { twitter: { cookies: { auth_token: "old" } }, ...config },
    }),
  );
  await assert.rejects(f.store.inspect("x"), errorCode("file_too_large"));
});

test("platforms cannot share config or referenced credential material", async (t) => {
  const f = await fixture(t);
  const same = new TestStore({
    ...f.options,
    configPaths: { x: f.configPath, pixiv: f.configPath },
  });
  await assert.rejects(same.inspect("x"), errorCode("shared_material"));
  const pixivPath = join(f.root, "pixiv.json");
  for (const reference of [join(f.root, "cookies.txt"), f.configPath]) {
    await fs.writeFile(
      pixivPath,
      JSON.stringify({
        extractor: {
          pixiv: { cookies: reference, "refresh-token": "synthetic-old" },
        },
      }),
      { mode: 0o600 },
    );
    const shared = new TestStore({
      ...f.options,
      configPaths: { x: f.configPath, pixiv: pixivPath },
    });
    await assert.rejects(shared.inspect("x"), errorCode("shared_material"));
  }
  await fs.writeFile(
    pixivPath,
    JSON.stringify({
      extractor: { pixiv: { "refresh-token": "synthetic-old" } },
    }),
  );
  const separate = new TestStore({
    ...f.options,
    configPaths: { x: f.configPath, pixiv: pixivPath },
  });
  await separate.inspect("x");
  await separate.inspect("pixiv");
});

test("preparation preserves options and referenced old cookies, promotion replays after restart", async (t) => {
  const f = await fixture(t);
  const before = await fs.readFile(f.configPath, "utf8");
  const baseline = await f.store.inspect("x");
  const id = randomUUID();
  const prepared = await f.store.prepare(
    id,
    "x",
    baseline.baselineDigest,
    xInput,
  );
  assert.equal(await fs.readFile(f.configPath, "utf8"), before);
  assert.equal(prepared.materialRef, id);
  assert.match(prepared.targetDigest, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(prepared).includes("synthetic"));
  assert.ok(!JSON.stringify(baseline).includes(f.root));
  const materialText = (
    await Promise.all(
      (await fs.readdir(f.stateDirectory)).map((p) =>
        fs.readFile(join(f.stateDirectory, p), "utf8"),
      ),
    )
  ).join("");
  assert.ok(
    materialText.includes(
      Buffer.from("synthetic-old-cookie").toString("base64"),
    ),
  );
  assert.equal((await new TestStore(f.options).recover(id)).state, "baseline");
  await new TestStore(f.options).promote(id);
  assert.deepEqual(JSON.parse(await fs.readFile(f.configPath, "utf8")), {
    extractor: {
      twitter: {
        cookies: { auth_token: "synthetic-auth", ct0: "synthetic-csrf" },
        retries: 2,
      },
    },
    output: { mode: "null" },
  });
  assert.equal((await f.store.recover(id)).state, "promoted");
  assert.deepEqual(
    await f.store.prepare(id, "x", baseline.baselineDigest, xInput),
    prepared,
  );
  assert.deepEqual(await f.store.promote(id), prepared);
  await assert.rejects(
    f.store.prepare(id, "x", baseline.baselineDigest, {
      ...xInput,
      ct0: "different",
    }),
    errorCode("operation_conflict"),
  );
});

test("Pixiv only replaces refresh token and preserves existing inline cookies", async (t) => {
  const f = await fixture(t, {
    extractor: {
      pixiv: {
        "refresh-token": "old",
        cookies: { PHPSESSID: "synthetic" },
        ugoira: false,
      },
      twitter: { cookies: { auth_token: "other" } },
    },
  });
  const baseline = await f.store.inspect("pixiv");
  const prepared = await f.store.prepare(
    randomUUID(),
    "pixiv",
    baseline.baselineDigest,
    { platform: "pixiv", refreshToken: " new-refresh " },
  );
  await f.store.promote(prepared.materialRef);
  assert.deepEqual(
    JSON.parse(await fs.readFile(f.configPath, "utf8")).extractor.pixiv,
    {
      "refresh-token": "new-refresh",
      cookies: { PHPSESSID: "synthetic" },
      ugoira: false,
    },
  );
});

test("X credential replacement discards ancillary cookies from the previous account", async (t) => {
  const f = await fixture(t, {
    extractor: {
      twitter: {
        cookies: {
          auth_token: "old-account",
          ct0: "old-csrf",
          twid: "old-account-id",
          lang: "en",
        },
        retries: 3,
      },
    },
  });
  const baseline = await f.store.inspect("x");
  const prepared = await f.store.prepare(
    randomUUID(),
    "x",
    baseline.baselineDigest,
    xInput,
  );
  await f.store.promote(prepared.materialRef);
  assert.deepEqual(
    JSON.parse(await fs.readFile(f.configPath, "utf8")).extractor.twitter,
    {
      cookies: { auth_token: "synthetic-auth", ct0: "synthetic-csrf" },
      retries: 3,
    },
  );
});

test("external JSON or legacy cookie changes refuse prepare and promote without overwriting", async (t) => {
  for (const target of ["gallery.json", "cookies.txt"]) {
    const f = await fixture(t);
    const baseline = await f.store.inspect("x");
    const prepared = await f.store.prepare(
      randomUUID(),
      "x",
      baseline.baselineDigest,
      xInput,
    );
    await fs.writeFile(join(f.root, target), "external-change");
    await assert.rejects(
      f.store.promote(prepared.materialRef),
      errorCode("baseline_changed"),
    );
    assert.equal(
      (await f.store.recover(prepared.materialRef)).state,
      "conflict",
    );
    assert.equal(
      await fs.readFile(join(f.root, target), "utf8"),
      "external-change",
    );
    await assert.rejects(
      f.store.prepare(randomUUID(), "x", baseline.baselineDigest, xInput),
    );
  }
});

test("malformed, oversized, unknown fields and path-like operation IDs never create material", async (t) => {
  const f = await fixture(t);
  const baseline = await f.store.inspect("x");
  for (const input of [
    { ...xInput, authToken: "bad\nvalue" },
    { ...xInput, ct0: "" },
    { ...xInput, authToken: "a".repeat(8193) },
    { ...xInput, cookies: "path" },
    { platform: "pixiv", refreshToken: "other-platform" },
  ])
    await assert.rejects(
      f.store.prepare(
        randomUUID(),
        "x",
        baseline.baselineDigest,
        input as typeof xInput,
      ),
      errorCode("invalid_input"),
    );
  await assert.rejects(
    f.store.prepare("../escape", "x", baseline.baselineDigest, xInput),
    errorCode("invalid_operation"),
  );
  assert.deepEqual(await fs.readdir(f.stateDirectory), []);
  await fs.writeFile(f.configPath, "a".repeat(1024 * 1024 + 1));
  await assert.rejects(f.store.inspect("x"), errorCode("file_too_large"));
});

test("GET-style inspect and recover never write and symlinks are refused", async (t) => {
  const f = await fixture(t);
  await f.store.inspect("x");
  assert.deepEqual(await fs.readdir(f.stateDirectory), []);
  await assert.rejects(
    f.store.recover(randomUUID()),
    errorCode("material_missing"),
  );
  assert.deepEqual(await fs.readdir(f.stateDirectory), []);
  // Junctions do not require Windows developer-mode symlink privileges.
  const linked = join(f.root, "linked");
  await fs.symlink(
    f.stateDirectory,
    linked,
    process.platform === "win32" ? "junction" : "dir",
  );
  const store = new TestStore({ ...f.options, stateDirectory: linked });
  await assert.rejects(store.inspect("x"), errorCode("unsafe_path"));
});

test("rename failure retains baseline and durable material for explicit replay", async (t) => {
  const f = await fixture(t);
  const baseline = await f.store.inspect("x");
  const prepared = await f.store.prepare(
    randomUUID(),
    "x",
    baseline.baselineDigest,
    xInput,
  );
  const faulty = new TestStore({
    ...f.options,
    io: {
      ...fs,
      rename: async () => {
        throw new Error("synthetic secret path");
      },
    },
  });
  await assert.rejects(
    faulty.promote(prepared.materialRef),
    (error: unknown) =>
      errorCode("io_failure")(error) &&
      !String(error).includes("synthetic secret"),
  );
  assert.equal((await f.store.recover(prepared.materialRef)).state, "baseline");
  await f.store.promote(prepared.materialRef);
  assert.equal((await f.store.recover(prepared.materialRef)).state, "promoted");
});

test("simultaneous preparation with the same identity cannot replace the first material", async (t) => {
  const f = await fixture(t);
  const baseline = await f.store.inspect("x");
  const id = randomUUID();
  const outputs = await Promise.all(
    Array.from({ length: 5 }, () =>
      f.store.prepare(id, "x", baseline.baselineDigest, xInput),
    ),
  );
  for (const result of outputs) assert.deepEqual(result, outputs[0]);
  assert.deepEqual(await fs.readdir(f.stateDirectory), [`${id}.json`]);
});

test("a crash leaving the atomic publication hardlink can still recover the original material", async (t) => {
  const f = await fixture(t);
  const baseline = await f.store.inspect("x");
  const id = randomUUID();
  const faulty = new TestStore({
    ...f.options,
    io: {
      ...fs,
      unlink: async () => {
        throw new Error("simulated shutdown");
      },
    },
  });
  await assert.rejects(
    faulty.prepare(id, "x", baseline.baselineDigest, xInput),
    errorCode("io_failure"),
  );
  assert.equal((await f.store.recover(id)).state, "baseline");
  await f.store.promote(id);
  assert.equal((await f.store.recover(id)).state, "promoted");
});

for (const failure of ["writeFile", "sync"] as const) {
  test(`${failure} failure never changes the active file and explicit retry uses the original operation`, async (t) => {
    const f = await fixture(t);
    const baseline = await f.store.inspect("x");
    const prepared = await f.store.prepare(
      randomUUID(),
      "x",
      baseline.baselineDigest,
      xInput,
    );
    const faulty = new TestStore({
      ...f.options,
      io: {
        ...fs,
        open: async (...args: Parameters<typeof fs.open>) => {
          const handle = await fs.open(...args);
          return new Proxy(handle, {
            get(target, key) {
              if (key === failure)
                return async () => {
                  throw new Error("synthetic path and token");
                };
              const value = Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        },
      },
    });
    await assert.rejects(
      faulty.promote(prepared.materialRef),
      errorCode("io_failure"),
    );
    assert.equal(
      (await f.store.recover(prepared.materialRef)).state,
      "baseline",
    );
    await f.store.promote(prepared.materialRef);
    assert.equal(
      (await f.store.recover(prepared.materialRef)).state,
      "promoted",
    );
  });
}

test("lost receipt after rename recovers promoted without writing during status query", async (t) => {
  const f = await fixture(t);
  const baseline = await f.store.inspect("x");
  const prepared = await f.store.prepare(
    randomUUID(),
    "x",
    baseline.baselineDigest,
    xInput,
  );
  class LostReceipt extends TestStore {
    protected override async syncDirectory(path: string): Promise<void> {
      if (path === f.root) throw new Error("simulated crash after rename");
      await super.syncDirectory(path);
    }
  }
  await assert.rejects(
    new LostReceipt(f.options).promote(prepared.materialRef),
    errorCode("io_failure"),
  );
  const before = await fs.stat(f.configPath);
  assert.equal((await f.store.recover(prepared.materialRef)).state, "promoted");
  await assert.rejects(
    new LostReceipt(f.options).promote(prepared.materialRef),
    errorCode("io_failure"),
  );
  await f.store.promote(prepared.materialRef);
  const after = await fs.stat(f.configPath);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  await fs.writeFile(f.configPath, "external replacement after promotion");
  await assert.rejects(
    f.store.promote(prepared.materialRef),
    errorCode("baseline_changed"),
  );
});

test(
  "private POSIX directory/file modes are mandatory",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    await fs.chmod(f.configPath, 0o644);
    await assert.rejects(f.store.inspect("x"), errorCode("unsafe_permissions"));
    await fs.chmod(f.configPath, 0o600);
    await fs.chmod(f.stateDirectory, 0o755);
    await assert.rejects(f.store.inspect("x"), errorCode("unsafe_permissions"));
  },
);

test(
  "native Windows fails closed because POSIX mode cannot prove a private ACL",
  { skip: process.platform !== "win32" },
  async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      new ControlledGalleryCredentials(f.options).inspect("x"),
      errorCode("unsupported_filesystem"),
    );
  },
);
