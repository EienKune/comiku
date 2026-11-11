import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { validate } from "class-validator";
import { ACCESS } from "../src/common/access.js";
import { BirthdaysController } from "../src/birthdays/birthdays.controller.js";
import {
  BirthdaySettingsInputDto,
  BirthdaySubscriptionInputDto,
} from "../src/birthdays/birthdays.dto.js";

test("members can read birthdays while all birthday controls require administration", () => {
  for (const route of ["summary", "calendar"] as const)
    assert.deepEqual(
      Reflect.getMetadata(ACCESS, BirthdaysController.prototype[route]),
      { permission: "dashboard:read" },
    );
  for (const route of [
    "settings",
    "updateSettings",
    "sync",
    "subscriptions",
    "updateSubscription",
    "template",
    "updateTemplate",
    "preview",
  ] as const)
    assert.deepEqual(
      Reflect.getMetadata(ACCESS, BirthdaysController.prototype[route]),
      { permission: "system:manage" },
    );
});

test("birthday schedule HTTP input rejects unsafe offsets, invalid local times and stale revision shapes", async () => {
  const valid = {
    expectedRevision: 0,
    displayEnabled: true,
    remindersEnabled: true,
    sendTime: "09:00",
    offsetDays: [0, 1, 7],
  };
  assert.deepEqual(
    await validate(Object.assign(new BirthdaySettingsInputDto(), valid)),
    [],
  );
  for (const changed of [
    { offsetDays: [2] },
    { offsetDays: [0, 0] },
    { offsetDays: [] },
    { sendTime: "24:00" },
    { sendTime: "09:00Z" },
    { expectedRevision: -1 },
    { remindersEnabled: "true" },
  ]) {
    assert.ok(
      (
        await validate(
          Object.assign(new BirthdaySettingsInputDto(), valid, changed),
        )
      ).length > 0,
    );
  }
  assert.ok(
    (
      await validate(
        Object.assign(new BirthdaySubscriptionInputDto(), {
          expectedChannelRevision: 0,
          expectedScopeRevision: -1,
          enabled: true,
        }),
      )
    ).some((error) => error.property === "expectedScopeRevision"),
  );
});
