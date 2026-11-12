import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type RequestListener } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createSign, generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NotificationConnectionRegistry,
  normalizeNotificationIp,
} from "../src/notifications/notification-connections.js";
import { OneBotHttpAdapter } from "../src/notifications/onebot-http.adapter.js";

const secret = "SECRET_CANARY_NEVER_EXPOSE";
const entry = (endpoint: string) => ({
  key: "test",
  name: "测试",
  endpoint,
  tokenEnv: "TEST_BOT_TOKEN",
  allowedIps: ["127.0.0.1"],
});
const registry = (endpoint: string) =>
  new NotificationConnectionRegistry({
    env: { TEST_BOT_TOKEN: secret },
    manifest: [entry(endpoint)],
  });

async function withServer(
  handler: RequestListener,
  run: (endpoint: string) => Promise<void>,
) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("manifest isolates broken config, keeps safe administration readable while disabled", () => {
  const valid = registry("http://127.0.0.1:3000");
  assert.equal(valid.enabled, false);
  assert.equal(valid.get("test")?.adapter, "onebot-http");
  assert.deepEqual(valid.safeConnections(), [
    { key: "test", name: "测试", adapter: "onebot-http", available: true },
  ]);
  assert.doesNotMatch(
    JSON.stringify(valid.safeConnections()),
    /SECRET_CANARY|127\.0\.0\.1|fingerprint/,
  );
  assert.equal(normalizeNotificationIp("::ffff:127.0.0.1"), "127.0.0.1");
  for (const endpoint of [
    "http://8.8.8.8",
    "http://user:pass@127.0.0.1",
    "http://127.0.0.1/?token=SECRET_CANARY",
    "http://169.254.169.254",
    "https://224.0.0.1",
  ]) {
    const invalid = registry(endpoint);
    assert.equal(invalid.get("test"), undefined);
    assert.doesNotMatch(
      JSON.stringify(invalid.safeConnections()) + invalid.configurationError,
      /SECRET_CANARY/,
    );
  }
  const missing = new NotificationConnectionRegistry({
    env: { NOTIFICATION_CONNECTIONS_FILE: "DOES_NOT_EXIST_SECRET_CANARY" },
  });
  assert.equal(
    missing.configurationError,
    "notification_configuration_unavailable",
  );
});

test("adapter pins destination and sends text segments with bearer token, reusing bounded pool", async () => {
  const bodies: unknown[] = [];
  const sockets = new Set<unknown>();
  await withServer(
    (req, res) => {
      sockets.add(req.socket);
      assert.equal(req.url, "/send_group_msg");
      assert.equal(req.headers.authorization, `Bearer ${secret}`);
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        bodies.push(JSON.parse(body));
        res.end(
          JSON.stringify({
            status: "ok",
            retcode: 0,
            data: { message_id: 123 },
          }),
        );
      });
    },
    async (endpoint) => {
      const adapter = new OneBotHttpAdapter();
      const connection = registry(endpoint).get("test")!;
      try {
        assert.deepEqual(
          await adapter.send(connection, "123", "[CQ:at,qq=all]"),
          {
            status: "accepted",
            providerMessageId: "123",
            sendBoundaryCrossed: true,
          },
        );
        assert.equal(
          (await adapter.send(connection, "123", "second")).status,
          "accepted",
        );
        assert.equal(sockets.size, 1);
        assert.deepEqual(bodies[0], {
          group_id: "123",
          message: [{ type: "text", data: { text: "[CQ:at,qq=all]" } }],
          auto_escape: true,
        });
      } finally {
        adapter.close();
      }
    },
  );
});

test("server-frozen mentions use OneBot at segments while arbitrary segments never reach transport", async () => {
  const bodies: unknown[] = [];
  await withServer(
    (req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        bodies.push(JSON.parse(raw));
        res.end(
          JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 7 } }),
        );
      });
    },
    async (endpoint) => {
      const adapter = new OneBotHttpAdapter();
      const connection = registry(endpoint).get("test")!;
      const segments = [
        { type: "text", data: { text: "[CQ:at,qq=all] 待交稿 " } },
        { type: "at", data: { qq: "10001000" } },
      ];
      try {
        assert.equal(
          (
            await adapter.send(
              connection,
              "123",
              "待交稿 @合成成员",
              undefined,
              segments,
            )
          ).status,
          "accepted",
        );
        assert.deepEqual(bodies, [
          { group_id: "123", message: segments, auto_escape: true },
        ]);
        for (const invalid of [
          [],
          [{ type: "at", data: { qq: "all" } }],
          [{ type: "text", data: { text: "x", extra: "no" } }],
          [{ type: "image", data: { file: "file:///private" } }],
          [...segments, segments[1]],
          [{ type: "text", data: { text: "x".repeat(1001) } }],
          [...segments, { type: "text", data: { text: "x" }, extra: true }],
        ]) {
          const result = await adapter.send(
            connection,
            "123",
            "待交稿",
            undefined,
            invalid,
          );
          assert.equal(result.status, "failed");
          assert.equal(result.sendBoundaryCrossed, false);
        }
        assert.equal(bodies.length, 1);
      } finally {
        adapter.close();
      }
    },
  );
});

test("async, malformed, missing receipt, redirects, and 5xx become unknown without leaks", async () => {
  for (const fixture of [
    { code: 200, body: JSON.stringify({ status: "async", retcode: 1 }) },
    { code: 200, body: JSON.stringify({ status: "ok", retcode: 0, data: {} }) },
    { code: 200, body: "SECRET_CANARY" },
    { code: 302, body: "", location: "http://169.254.169.254/" },
    { code: 500, body: "SECRET_CANARY" },
    { code: 200, body: "x".repeat(65_537) },
  ]) {
    await withServer(
      (_req, res) => {
        res.statusCode = fixture.code;
        if (fixture.location) res.setHeader("location", fixture.location);
        res.end(fixture.body);
      },
      async (endpoint) => {
        const adapter = new OneBotHttpAdapter();
        try {
          const result = await adapter.send(
            registry(endpoint).get("test")!,
            "123",
            "text",
          );
          assert.equal(result.status, "unknown");
          assert.equal(result.sendBoundaryCrossed, true);
          assert.doesNotMatch(JSON.stringify(result), /SECRET_CANARY|169\.254/);
        } finally {
          adapter.close();
        }
      },
    );
  }
});

test("all DNS answers must be allowed; rejected DNS and invalid targets never send", async () => {
  let requests = 0;
  await withServer(
    (_req, res) => {
      requests++;
      res.end("{}");
    },
    async (endpoint) => {
      const connection = registry(endpoint).get("test")!;
      const adapter = new OneBotHttpAdapter({
        lookup: async () => [
          { address: "127.0.0.1", family: 4 },
          { address: "8.8.8.8", family: 4 },
        ],
      });
      try {
        assert.equal(
          (
            await adapter.send(
              {
                ...connection,
                endpoint: endpoint.replace("127.0.0.1", "bot.example"),
              },
              "123",
              "text",
            )
          ).status,
          "failed",
        );
        assert.equal(
          (await adapter.send(connection, "not-a-group", "text")).status,
          "failed",
        );
        assert.equal(requests, 0);
      } finally {
        adapter.close();
      }
    },
  );
});

test("connection refusal is safely retryable and timeout after send is unknown", async () => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const adapter = new OneBotHttpAdapter({ timeoutMs: 30 });
  try {
    const refused = await adapter.send(
      registry(`http://127.0.0.1:${address.port}`).get("test")!,
      "123",
      "text",
    );
    assert.equal(refused.status, "retryable");
    assert.equal(refused.sendBoundaryCrossed, false);
    await withServer(
      () => {},
      async (endpoint) => {
        const timed = await adapter.send(
          registry(endpoint).get("test")!,
          "123",
          "text",
        );
        assert.equal(timed.status, "unknown");
        assert.equal(timed.sendBoundaryCrossed, true);
      },
    );
  } finally {
    adapter.close();
  }
});

test("IPv6 mapped destinations cannot bypass private HTTP and forbidden address rules", () => {
  assert.equal(normalizeNotificationIp("::ffff:7f00:1"), "127.0.0.1");
  for (const ip of [
    "0.0.0.0",
    "::",
    "::ffff:169.254.169.254",
    "fe80::1",
    "ff02::1",
    "224.0.0.1",
  ]) {
    const config = new NotificationConnectionRegistry({
      env: { TEST_BOT_TOKEN: secret },
      manifest: [{ ...entry(`https://[::1]`), allowedIps: [ip] }],
    });
    assert.equal(config.get("test"), undefined);
  }
});

test("explicit allowlist cannot authorize known metadata service addresses", () => {
  for (const ip of ["100.100.100.200", "fd00:ec2::254"]) {
    const host = ip.includes(":") ? `[${ip}]` : ip;
    const config = new NotificationConnectionRegistry({
      env: { TEST_BOT_TOKEN: secret },
      manifest: [{ ...entry(`https://${host}`), allowedIps: [ip] }],
    });
    assert.equal(config.get("test"), undefined);
  }
});

test("hostname connection is pinned to validated DNS without resolving its original name", async () => {
  let requests = 0;
  await withServer(
    (_req, res) => {
      requests++;
      res.end(
        JSON.stringify({
          status: "ok",
          retcode: 0,
          data: { message_id: -456 },
        }),
      );
    },
    async (endpoint) => {
      const connection = registry(
        endpoint.replace("127.0.0.1", "never-resolves.invalid"),
      ).get("test")!;
      const adapter = new OneBotHttpAdapter({
        lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      });
      try {
        assert.equal(
          (await adapter.send(connection, "123", "pin")).status,
          "accepted",
        );
        assert.equal(requests, 1);
      } finally {
        adapter.close();
      }
    },
  );
});

test("DNS time shares total deadline and cannot produce a late send", async () => {
  let requests = 0;
  await withServer(
    (_req, res) => {
      requests++;
      res.end("{}");
    },
    async (endpoint) => {
      let release!: (addresses: { address: string; family: number }[]) => void;
      const adapter = new OneBotHttpAdapter({
        timeoutMs: 10,
        lookup: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      });
      const connection = registry(
        endpoint.replace("127.0.0.1", "never-resolves.invalid"),
      ).get("test")!;
      try {
        const result = await adapter.send(connection, "123", "dns");
        assert.equal(result.status, "retryable");
        assert.equal(result.sendBoundaryCrossed, false);
        release([{ address: "127.0.0.1", family: 4 }]);
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(requests, 0);
      } finally {
        adapter.close();
      }
    },
  );
});

test("explicit provider rejection is permanent and never leaks provider text", async () => {
  for (const fixture of [
    { code: 401, body: "SECRET_CANARY" },
    {
      code: 200,
      body: JSON.stringify({
        status: "failed",
        retcode: 1404,
        wording: secret,
      }),
    },
  ]) {
    await withServer(
      (_req, res) => {
        res.statusCode = fixture.code;
        res.end(fixture.body);
      },
      async (endpoint) => {
        const adapter = new OneBotHttpAdapter();
        try {
          assert.deepEqual(
            await adapter.send(registry(endpoint).get("test")!, "123", "text"),
            {
              status: "failed",
              errorCode: "notification_provider_rejected",
              sendBoundaryCrossed: true,
            },
          );
        } finally {
          adapter.close();
        }
      },
    );
  }
});

test("private manifest reads are bounded and one broken connection leaves healthy peers available", () => {
  const dir = mkdtempSync(join(tmpdir(), "comiku-notification-"));
  const path = join(dir, "connections.json");
  try {
    writeFileSync(path, " ".repeat(65_537));
    assert.equal(
      new NotificationConnectionRegistry({
        env: { NOTIFICATION_CONNECTIONS_FILE: path },
      }).configurationError,
      "notification_configuration_unavailable",
    );
    writeFileSync(
      path,
      JSON.stringify({
        connections: [
          entry("http://127.0.0.1:3000"),
          {
            ...entry("http://127.0.0.1:3001"),
            key: "broken",
            tokenEnv: "MISSING",
          },
        ],
      }),
    );
    const config = new NotificationConnectionRegistry({
      env: { NOTIFICATION_CONNECTIONS_FILE: path, TEST_BOT_TOKEN: secret },
    });
    assert.ok(config.get("test"));
    assert.equal(config.get("broken"), undefined);
    assert.deepEqual(
      config.safeConnections().map((c) => c.available),
      [true, false],
    );
    assert.equal(
      config.configurationError,
      "notification_configuration_invalid",
    );
    const changed = new NotificationConnectionRegistry({
      env: { TEST_BOT_TOKEN: "rotated-token" },
      manifest: [entry("http://127.0.0.1:3000")],
    });
    assert.notEqual(
      config.get("test")!.fingerprint,
      changed.get("test")!.fingerprint,
    );
    const excessive = new NotificationConnectionRegistry({
      manifest: Array.from({ length: 9 }, (_, i) => ({
        ...entry("http://127.0.0.1"),
        key: `bot${i}`,
      })),
    });
    assert.deepEqual(excessive.safeConnections(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Pure Node synthetic certificate: no fixture private key, local trust-store edits, openssl, or network.
function syntheticTlsCertificate() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const der = (tag: number, ...values: Buffer[]): Buffer => {
    const content = Buffer.concat(values);
    const size =
      content.length < 128
        ? Buffer.from([content.length])
        : content.length < 256
          ? Buffer.from([0x81, content.length])
          : Buffer.from([0x82, content.length >>> 8, content.length & 255]);
    return Buffer.concat([Buffer.from([tag]), size, content]);
  };
  const sequence = (...values: Buffer[]) => der(0x30, ...values);
  const algorithm = Buffer.from("300d06092a864886f70d01010b0500", "hex");
  const name = sequence(
    der(
      0x31,
      sequence(
        der(0x06, Buffer.from("550403", "hex")),
        der(0x0c, Buffer.from("never-resolves.invalid")),
      ),
    ),
  );
  const validity = sequence(
    der(0x17, Buffer.from("250101000000Z")),
    der(0x17, Buffer.from("491231235959Z")),
  );
  const tbs = sequence(
    der(0x02, Buffer.from([1])),
    algorithm,
    name,
    validity,
    name,
    publicKey.export({ format: "der", type: "spki" }),
  );
  const signature = createSign("RSA-SHA256").update(tbs).sign(privateKey);
  const cert = sequence(tbs, algorithm, der(0x03, Buffer.from([0]), signature));
  return {
    key: privateKey.export({ format: "pem", type: "pkcs8" }),
    cert: `-----BEGIN CERTIFICATE-----\n${cert
      .toString("base64")
      .match(/.{1,64}/g)!
      .join("\n")}\n-----END CERTIFICATE-----`,
  };
}

test("HTTPS retains certificate verification while pinning DNS and never sends HTTP over bad TLS", async () => {
  let requests = 0;
  const server = createHttpsServer(syntheticTlsCertificate(), (_req, res) => {
    requests++;
    res.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const connection = registry(`https://127.0.0.1:${address.port}`).get("test")!;
  const adapter = new OneBotHttpAdapter();
  try {
    const result = await adapter.send(connection, "123", "tls");
    assert.equal(result.status, "failed");
    assert.equal(result.sendBoundaryCrossed, false);
    assert.equal(result.errorCode, "notification_tls_rejected");
    assert.equal(requests, 0);
  } finally {
    adapter.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
