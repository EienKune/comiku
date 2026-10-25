import "reflect-metadata";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { Resolver } from "node:dns/promises";
import { checkServerIdentity } from "node:tls";
import type { PeerCertificate } from "node:tls";
import { brotliCompressSync } from "node:zlib";
import { test } from "node:test";
import { Body, Controller, Post } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { configureApplication } from "../src/application.js";

// Compatibility checks only: synthetic loopback traffic, no exploit payloads,
// external DNS, real source accounts or storage credentials.
test("fetch decodes Brotli responses and rejects invalid compressed bodies without poisoning subsequent requests", async () => {
  const expected = { message: "本地压缩响应" };
  const server = createServer((request, response) => {
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Encoding": "br",
    });
    response.end(
      request.url === "/invalid"
        ? Buffer.from([255, 255, 255])
        : brotliCompressSync(JSON.stringify(expected)),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    for (const path of ["/first", "/invalid", "/after"]) {
      const response = await fetch(url + path, {
        signal: AbortSignal.timeout(5000),
      });
      if (path === "/invalid") await assert.rejects(response.json());
      else assert.deepEqual(await response.json(), expected);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

@Controller("runtime-probe")
class RuntimeProbe {
  @Post()
  echo(@Body() body: { message: string }) {
    return body;
  }
}

test("Nest request parsing accepts normal Brotli JSON and rejects malformed compression", async () => {
  const module = await Test.createTestingModule({
    controllers: [RuntimeProbe],
  }).compile();
  const app = module.createNestApplication({ logger: false });
  configureApplication(app);
  try {
    await app.listen(0, "127.0.0.1");
    const url = (await app.getUrl()) + "/api/runtime-probe";
    const expected = { message: "译文保存" };
    for (const valid of [true, false, true]) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Encoding": "br",
        },
        body: valid
          ? new Uint8Array(brotliCompressSync(JSON.stringify(expected)))
          : new Uint8Array([255, 255, 255]),
        signal: AbortSignal.timeout(5000),
      });
      if (valid) {
        assert.equal(response.status, 201);
        assert.deepEqual(await response.json(), expected);
      } else {
        assert.ok(response.status >= 400 && response.status < 600);
        await response.body?.cancel();
      }
    }
  } finally {
    await app.close();
  }
});

test("TLS identity checks retain hostname/IP SAN validation and DNS rejects embedded NUL before lookup", async () => {
  const certificate = {
    subjectaltname: "DNS:api.fixture.test, IP Address:127.0.0.1",
  } as PeerCertificate;
  assert.equal(checkServerIdentity("api.fixture.test", certificate), undefined);
  assert.equal(checkServerIdentity("127.0.0.1", certificate), undefined);
  assert.ok(checkServerIdentity("other.fixture.test", certificate));
  assert.ok(checkServerIdentity("127.0.0.2", certificate));
  assert.ok(
    checkServerIdentity("127.1", {
      subjectaltname: "DNS:127.1",
    } as PeerCertificate),
  );
  // No configured servers: this check must fail locally on the NUL input.
  const resolver = new Resolver();
  resolver.setServers([]);
  await assert.rejects(
    async () => resolver.resolve4("api.fixture.test\0.invalid"),
    {
      code: "ERR_INVALID_ARG_VALUE",
    },
  );
});
