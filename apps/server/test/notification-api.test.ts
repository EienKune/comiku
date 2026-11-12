import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { validate } from "class-validator";
import { PATH_METADATA } from "@nestjs/common/constants.js";
import { ACCESS } from "../src/common/access.js";
import { parseEnvironment } from "../src/config/environment.js";

const databaseUrl = "postgresql://fixture:fixture@127.0.0.1:1/offline_test";

test("notification environment is optional and an explicit off switch stays off", () => {
  assert.equal(
    parseEnvironment({ DATABASE_URL: databaseUrl }).notifications,
    undefined,
  );
  assert.deepEqual(
    parseEnvironment({
      DATABASE_URL: databaseUrl,
      NOTIFICATIONS_ENABLED: "false",
      NOTIFICATION_CONNECTIONS_FILE: "C:/private/bots.json",
    }).notifications,
    { enabled: false, connectionsFile: "C:/private/bots.json" },
  );
  assert.equal(
    parseEnvironment({
      DATABASE_URL: databaseUrl,
      NOTIFICATIONS_ENABLED: "true",
    }).notifications?.enabled,
    true,
  );
});

test("every notification management route is guarded by system management", async () => {
  const loaded =
    await import("../src/notifications/notifications.controller.js").catch(
      () => null,
    );
  assert.ok(loaded, "notification controller must exist and be importable");
  const controller = loaded.NotificationsController;
  assert.equal(Reflect.getMetadata(PATH_METADATA, controller), "notifications");
  for (const name of [
    "configuration",
    "createChannel",
    "updateChannel",
    "preview",
    "deliveries",
    "testChannel",
    "resolveDelivery",
  ] as const) {
    const route = controller.prototype[name];
    assert.ok(route, `missing management route ${name}`);
    assert.deepEqual(Reflect.getMetadata(ACCESS, route), {
      permission: "system:manage",
    });
  }
});

test("notification DTOs reject arbitrary targets, duplicate events and unsafe replay", async () => {
  const loaded =
    await import("../src/notifications/notifications.dto.js").catch(() => null);
  assert.ok(loaded, "notification DTOs must exist and be importable");
  const bad = Object.assign(new loaded.NotificationChannelInputDto(), {
    name: "fixture",
    connectionKey: "http://untrusted.example",
    groupId: "not-a-group",
    enabled: true,
    eventTypes: ["arbitrary.script", "arbitrary.script"],
    includeDetails: false,
  });
  const errors = await validate(bad);
  for (const field of ["connectionKey", "groupId", "eventTypes"]) {
    assert.ok(
      errors.some((error) => error.property === field),
      field,
    );
  }
  const replay = Object.assign(new loaded.NotificationResolveDto(), {
    action: "execute-script",
    expectedRevision: -1,
    idempotencyKey: "not-a-uuid",
  });
  assert.ok((await validate(replay)).length >= 3);
});

test("private connection keys accepted by the registry can be selected through the API", async () => {
  const { NotificationChannelInputDto } =
    await import("../src/notifications/notifications.dto.js");
  const { NotificationConnectionRegistry } =
    await import("../src/notifications/notification-connections.js");
  const registry = new NotificationConnectionRegistry({
    env: { FIXTURE_BOT_TOKEN: "synthetic-token" },
    manifest: [
      {
        key: "_fixture",
        name: "Synthetic",
        endpoint: "http://127.0.0.1:3001",
        tokenEnv: "FIXTURE_BOT_TOKEN",
        allowedIps: ["127.0.0.1"],
      },
    ],
  });
  assert.equal(registry.safeConnections()[0]?.available, true);
  const input = Object.assign(new NotificationChannelInputDto(), {
    name: "Synthetic group",
    connectionKey: "_fixture",
    groupId: "123456789",
    enabled: false,
    eventTypes: ["imported"],
    includeDetails: false,
  });
  assert.deepEqual(await validate(input), []);
});
