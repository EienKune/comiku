import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { Test } from "@nestjs/testing";
import { Reflector } from "@nestjs/core";
import { AuthGuard } from "../src/auth/auth.guard.js";
import { RateLimit } from "../src/auth/rate-limit.js";
import { NotificationsController } from "../src/notifications/notifications.controller.js";
import { NotificationsService } from "../src/notifications/notifications.service.js";
import { parseEnvironment } from "../src/config/environment.js";
import type { UsersService } from "../src/users/users.service.js";

test("status and receipts require current system management permission and validate receipt queries", async () => {
  assert.equal(
    typeof NotificationsController.prototype.status,
    "function",
    "status route must exist",
  );
  const { NotificationStatusService } =
    await import("../src/notifications/notification-status.service.js");
  let permissions: string[] = [];
  let calls = 0;
  const module = await Test.createTestingModule({
    controllers: [NotificationsController],
    providers: [
      { provide: NotificationsService, useValue: {} },
      {
        provide: NotificationStatusService,
        useValue: {
          status: async () => {
            calls++;
            return { state: "not_started" };
          },
          receipts: async (query: object) => {
            calls++;
            return { items: [], nextCursor: null, query };
          },
        },
      },
    ],
  }).compile();
  const app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix("api");
  app.useGlobalGuards(
    new AuthGuard(
      new Reflector(),
      {
        authenticate: async () => ({
          actor: { userId: "synthetic", sessionId: "synthetic" },
          user: { permissions, mustChangePassword: false },
        }),
      } as unknown as UsersService,
      parseEnvironment({
        NODE_ENV: "test",
        DATABASE_URL:
          "postgresql://synthetic:synthetic@127.0.0.1:1/unused_test",
      }),
      new RateLimit(),
    ),
  );
  try {
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();
    const request = async (path: string, authenticated = true) => {
      const response = await fetch(`${base}/api/notifications/${path}`, {
        headers: authenticated ? { cookie: "comiku_session=synthetic" } : {},
      });
      return { status: response.status, data: await response.json() };
    };
    for (const path of ["status", "receipts"]) {
      assert.equal((await request(path, false)).status, 401);
      assert.equal((await request(path)).status, 403);
    }
    assert.equal(calls, 0);
    permissions = ["system:manage"];
    assert.equal((await request("status")).status, 200);
    const page = await request("receipts?limit=5&status=invalid");
    assert.equal(page.status, 200);
    assert.deepEqual((page.data as { query: unknown }).query, {
      limit: 5,
      status: "invalid",
    });
    for (const suffix of [
      "limit=0",
      "limit=51",
      "limit=1.5",
      "status=unknown",
      "extra=secret",
      "cursor=" + "x".repeat(513),
    ])
      assert.equal((await request("receipts?" + suffix)).status, 400);
    assert.equal(calls, 2);
    permissions = [];
    assert.equal((await request("receipts")).status, 403);
    assert.equal(calls, 2);
  } finally {
    await app.close();
  }
});
