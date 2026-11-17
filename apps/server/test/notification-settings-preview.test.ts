import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { validate } from "class-validator";
import { ACCESS } from "../src/common/access.js";
import { WorkRemindersService } from "../src/work-reminders/work-reminders.service.js";
import { WorkReminderPreviewInputDto } from "../src/work-reminders/work-reminders.dto.js";
import { BirthdaysController } from "../src/birthdays/birthdays.controller.js";

function service() {
  return new WorkRemindersService(
    {
      workReminderSettings: {
        upsert: async () => ({ note: "已保存提示语" }),
      },
    } as never,
    {} as never,
  );
}

test("work preview applies draft subscriptions without changing persisted settings", async () => {
  const reminders = service();
  const full = await reminders.preview("草稿提示语", "digest", {});
  assert.match(full.text, /翻译：8/);
  assert.match(full.text, /超过72小时未交稿：1/);
  assert.match(full.text, /草稿提示语/);
  const overdueOnly = await reminders.preview("", "digest", {
    digestEnabled: false,
    overdueEnabled: true,
  });
  assert.match(overdueOnly.text, /翻译：0/);
  assert.match(overdueOnly.text, /超过72小时未交稿：1/);
  const digestOnly = await reminders.preview("", "digest", {
    overdueEnabled: false,
  });
  assert.match(digestOnly.text, /翻译：8/);
  assert.doesNotMatch(digestOnly.text, /超过72小时未交稿|另一部示例作品/);
  const off = await reminders.preview("", "digest", {
    digestEnabled: false,
    overdueEnabled: false,
  });
  assert.equal(off.text, "本群未开启定时提醒内容。");
  assert.match((await reminders.preview()).text, /已保存提示语/);
});

test("work preview represents synthetic mentions without exposing contact numbers or digest notes in ready messages", async () => {
  const reminders = service();
  const plain = await reminders.preview("", "digest", {
    mentionsEnabled: false,
  });
  assert.doesNotMatch(plain.text, /@/);
  const mentioned = await reminders.preview("", "digest", {
    mentionsEnabled: true,
  });
  assert.match(mentioned.text, /@另一位成员/);
  assert.doesNotMatch(mentioned.text, /10001000/);
  const ready = await reminders.preview("只用于定时摘要", "ready", {
    mentionsEnabled: true,
  });
  assert.match(ready.text, /@另一位成员/);
  assert.doesNotMatch(ready.text, /只用于定时摘要/);
});

test("draft preview flags require actual booleans and birthday drafts use an admin-only POST body", async () => {
  const invalid = Object.assign(new WorkReminderPreviewInputDto(), {
    digestEnabled: "false",
    overdueEnabled: 1,
    mentionsEnabled: "true",
  });
  const invalidFields = (await validate(invalid)).map(
    (error) => error.property,
  );
  assert.deepEqual(invalidFields.sort(), [
    "digestEnabled",
    "mentionsEnabled",
    "overdueEnabled",
  ]);
  assert.deepEqual(
    Reflect.getMetadata(ACCESS, BirthdaysController.prototype.previewDraft),
    { permission: "system:manage" },
  );
  let received: unknown[] = [];
  const controller = new BirthdaysController(
    {} as never,
    {
      preview: async (...args: unknown[]) => {
        received = args;
        return { text: "合成生日预览" };
      },
    } as never,
  );
  assert.deepEqual(
    await controller.previewDraft({ offsetDays: 7, note: "生日草稿" }),
    { text: "合成生日预览" },
  );
  assert.deepEqual(received, [7, "生日草稿"]);
  const { BirthdayPreviewInputDto } =
    await import("../src/birthdays/birthdays.dto.js");
  assert.equal(
    (
      await validate(
        Object.assign(new BirthdayPreviewInputDto(), { offsetDays: 2 }),
      )
    ).some((e) => e.property === "offsetDays"),
    true,
  );
  assert.deepEqual(
    await validate(
      Object.assign(new BirthdayPreviewInputDto(), { offsetDays: 0, note: "" }),
    ),
    [],
  );
});
