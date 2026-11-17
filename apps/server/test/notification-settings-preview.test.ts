import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { validate } from "class-validator";
import { ACCESS, type AuthRequest } from "../src/common/access.js";
import { bodyValidation } from "../src/common/http.js";
import { HEADERS_METADATA } from "@nestjs/common/constants.js";
import { WorkRemindersController } from "../src/work-reminders/work-reminders.controller.js";
import { WorkRemindersService } from "../src/work-reminders/work-reminders.service.js";
import { WorkReminderPreviewInputDto } from "../src/work-reminders/work-reminders.dto.js";
import { BirthdaysController } from "../src/birthdays/birthdays.controller.js";

type PreviewMember = {
  username: string;
  displayName: string;
  qqNumber: string | null;
};
function service(
  findUnique: (query: unknown) => Promise<PreviewMember | null> = async () =>
    null,
) {
  return new WorkRemindersService(
    {
      workReminderSettings: {
        upsert: async () => ({ note: "已保存提示语" }),
      },
      user: { findUnique },
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

test("actorless work preview remains clearly synthetic and ready messages exclude digest notes", async () => {
  const reminders = service(async () => {
    assert.fail("Actorless previews must not read account contacts");
  });
  const plain = await reminders.preview("", "digest", {
    mentionsEnabled: false,
  });
  assert.doesNotMatch(plain.text, /@/);
  const mentioned = await reminders.preview("", "digest", {
    mentionsEnabled: true,
  });
  assert.match(mentioned.text, /@示例成员/);
  assert.doesNotMatch(mentioned.text, /10001000|10000/);
  const ready = await reminders.preview("只用于定时摘要", "ready", {
    mentionsEnabled: true,
  });
  assert.match(ready.text, /@示例成员/);
  assert.doesNotMatch(ready.text, /只用于定时摘要/);
  assert.doesNotMatch(ready.text, /另一位成员|example-work-two/);
});

test("work previews read only the authenticated actor by primary key and never reuse another caller's identity", async () => {
  const users: Record<string, PreviewMember> = {
    first: {
      username: "first_user",
      displayName: "当前成员甲",
      qqNumber: "12345678",
    },
    second: {
      username: "second_user",
      displayName: "当前成员乙",
      qqNumber: "23456789",
    },
  };
  const reads: unknown[] = [];
  const reminders = service(async (query) => {
    reads.push(query);
    return users[(query as { where: { id: string } }).where.id] ?? null;
  });
  const [first, second] = await Promise.all([
    reminders.preview("", "digest", {}, "first"),
    reminders.preview("", "digest", {}, "second"),
  ]);
  assert.match(first.text, /当前成员甲/);
  assert.match(first.text, /@12345678/);
  assert.doesNotMatch(first.text, /当前成员乙|23456789|另一位成员|10001000/);
  assert.match(second.text, /当前成员乙/);
  assert.match(second.text, /@23456789/);
  assert.doesNotMatch(second.text, /当前成员甲|12345678/);
  const off = await reminders.preview(
    "",
    "digest",
    { mentionsEnabled: false },
    "first",
  );
  assert.doesNotMatch(off.text, /@|12345678/);
  const ready = await reminders.preview(
    "摘要提示不进交接",
    "ready",
    { mentionsEnabled: true },
    "first",
  );
  assert.match(ready.text, /@12345678/);
  assert.doesNotMatch(
    ready.text,
    /摘要提示不进交接|已保存提示语|example-work-two/,
  );
  assert.deepEqual(
    reads,
    ["first", "second", "first", "first"].map((id) => ({
      where: { id },
      select: { username: true, displayName: true, qqNumber: true },
    })),
  );
});

test("unbound actors preview their own platform username and explicit mention off stays off", async () => {
  const reminders = service(async () => ({
    username: "my_platform_name",
    displayName: "自己的名字",
    qqNumber: null,
  }));
  const global = await reminders.preview(undefined, "digest", {}, "self");
  assert.match(global.text, /自己的名字/);
  assert.match(global.text, /@my_platform_name/);
  assert.doesNotMatch(global.text, /10001000|10000|@示例成员|另一位成员/);
  const off = await reminders.preview(
    "",
    "digest",
    { mentionsEnabled: false },
    "self",
  );
  assert.match(off.text, /自己的名字/);
  assert.doesNotMatch(off.text, /@/);
  const ready = await reminders.preview(
    "仅供摘要的草稿",
    "ready",
    { mentionsEnabled: true },
    "self",
  );
  assert.match(ready.text, /@my_platform_name/);
  assert.doesNotMatch(
    ready.text,
    /仅供摘要的草稿|已保存提示语|example-work-two/,
  );
});

test("work preview forwards only the request actor and prevents private response caching", async () => {
  let received: unknown[] = [];
  const controller = new WorkRemindersController({
    preview: async (...args: unknown[]) => {
      received = args;
      return { text: "预览" };
    },
  } as never);
  const request = {
    actor: { userId: "session-user", sessionId: "session" },
  } as AuthRequest;
  const input = {
    kind: "ready",
    mentionsEnabled: true,
    userId: "forged-user",
  } as WorkReminderPreviewInputDto;
  await controller.preview(request, input);
  assert.deepEqual(received, [undefined, "ready", input, "session-user"]);
  assert.deepEqual(
    Reflect.getMetadata(ACCESS, WorkRemindersController.prototype.preview),
    { permission: "system:manage" },
  );
  assert.ok(
    Reflect.getMetadata(
      HEADERS_METADATA,
      WorkRemindersController.prototype.preview,
    )?.some(
      (header: { name: string; value: string }) =>
        header.name === "Cache-Control" && header.value === "private, no-store",
    ),
  );
  await assert.rejects(() =>
    bodyValidation(WorkReminderPreviewInputDto).transform(input, {
      type: "body",
      metatype: WorkReminderPreviewInputDto,
    }),
  );
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
