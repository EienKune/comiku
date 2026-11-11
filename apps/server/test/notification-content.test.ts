import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeNotificationEvent,
  notificationPayloadHash,
  renderNotificationMessage,
} from "../src/notifications/notification-events.js";
import {
  buildHistoricalReplayText,
  renderTemplateNotificationMessage,
  validateNotificationReceiptInput,
} from "../src/notifications/notification-content.js";

const input = {
  eventKey: "work-event:00000000-0000-4000-8000-000000000001",
  type: "stage_submitted" as const,
  resourceId: "00000000-0000-4000-8000-000000000002",
  aggregateVersion: 0,
  ordinal: 1,
  occurredAt: "2026-11-06T08:00:00Z",
  workNumber: 12,
  stage: "translate" as const,
};
const settings = {
  titleEnabled: true,
  authorEnabled: false,
  actorEnabled: true,
  note: "阶段提交提醒",
};
test("structured content honors independent masks, missing metadata and original facts", () => {
  const text = renderTemplateNotificationMessage(
    normalizeNotificationEvent({
      ...input,
      title: "作品",
      authorName: "PRIVATE_AUTHOR",
      actorName: "原操作人",
    }),
    settings,
    "https://example.test",
  );
  assert.match(text, /\n#12 作品 · 阶段已提交\n/);
  assert.match(text, /操作：原操作人/);
  assert.doesNotMatch(text, /PRIVATE_AUTHOR/);
  assert.match(text, /职责：翻译/);
  assert.match(text, /发生时间：2026-11-06 16:00:00/);
  assert.match(text, /阶段提交提醒/);
  const missing = renderTemplateNotificationMessage(
    normalizeNotificationEvent(input),
    settings,
  );
  assert.doesNotMatch(missing, /标题：|作者：|操作：|undefined|null/);
});

test("template time is Shanghai time across midnight and independent of host TZ", () => {
  const prior = process.env.TZ;
  try {
    for (const tz of ["UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
      process.env.TZ = tz;
      for (const [occurredAt, expected] of [
        ["2026-11-10T15:59:59.999Z", "2026-11-10 23:59:59"],
        ["2026-11-10T16:00:00.999Z", "2026-11-11 00:00:00"],
      ]) {
        const text = renderTemplateNotificationMessage(
          normalizeNotificationEvent({ ...input, occurredAt }),
          settings,
        );
        assert.ok(text.includes(`发生时间：${expected}\n`));
      }
    }
  } finally {
    if (prior === undefined) delete process.env.TZ;
    else process.env.TZ = prior;
  }
});

test("all eight masks keep title in the heading and note independent", () => {
  const event = normalizeNotificationEvent({
    ...input,
    title: "作品标题",
    authorName: "作者姓名",
    actorName: "操作姓名",
  });
  for (const titleEnabled of [false, true])
    for (const authorEnabled of [false, true])
      for (const actorEnabled of [false, true]) {
        const text = renderTemplateNotificationMessage(event, {
          titleEnabled,
          authorEnabled,
          actorEnabled,
          note: "独立提示语",
        });
        assert.equal(
          text.split("\n")[1],
          `#12${titleEnabled ? " 作品标题" : ""} · 阶段已提交`,
        );
        assert.equal(text.includes("作者：作者姓名"), authorEnabled);
        assert.equal(text.includes("操作：操作姓名"), actorEnabled);
        assert.equal(text.includes("作品标题"), titleEnabled);
        assert.ok(text.includes("\n独立提示语\n"));
        assert.doesNotMatch(text, /标题：/);
      }
  const missing = renderTemplateNotificationMessage(
    normalizeNotificationEvent(input),
    settings,
  );
  assert.equal(missing.split("\n")[1], "#12 · 阶段已提交");
});

test("template workflow shows equal states once while changes, single-sided facts and history stay intact", () => {
  for (const [patch, expected] of [
    [
      {
        fromWorkflowStatus: "pending_publish",
        toWorkflowStatus: "pending_publish",
      },
      "待发布",
    ],
    [
      { fromWorkflowStatus: "published", toWorkflowStatus: "published" },
      "已发布",
    ],
    [
      { fromWorkflowStatus: "pending_publish", toWorkflowStatus: "published" },
      "待发布 → 已发布",
    ],
    [{ fromWorkflowStatus: "pending_publish" }, "此前为待发布"],
    [{ toWorkflowStatus: "published" }, "已发布"],
  ] as const) {
    const event = normalizeNotificationEvent({
      ...input,
      type: "metadata_updated",
      ...patch,
    });
    const text = renderTemplateNotificationMessage(event, settings);
    assert.equal(
      text.split("\n").find((line) => line.startsWith("流程：")),
      `流程：${expected}`,
    );
    assert.equal(buildHistoricalReplayText(text), `【历史补发】\n${text}`);
  }
  const missing = renderTemplateNotificationMessage(
    normalizeNotificationEvent(input),
    settings,
  );
  assert.doesNotMatch(missing, /流程：/);
  const event = normalizeNotificationEvent({
    ...input,
    fromWorkflowStatus: "pending_publish",
    toWorkflowStatus: "pending_publish",
  });
  const legacy = renderNotificationMessage(event, { includeDetails: false });
  assert.match(legacy, /流程：待发布 → 待发布/);
  assert.equal(buildHistoricalReplayText(legacy), `【历史补发】\n${legacy}`);
});

test("content review suppresses equal states while retaining changes and one-sided facts", () => {
  for (const status of ["normal", "needs_review", "blocked"] as const) {
    const text = renderTemplateNotificationMessage(
      normalizeNotificationEvent({
        ...input,
        fromReviewStatus: status,
        toReviewStatus: status,
      }),
      settings,
    );
    assert.doesNotMatch(text, /审核：/);
  }
  for (const [patch, expected] of [
    [
      { fromReviewStatus: "normal", toReviewStatus: "needs_review" },
      "正常 → 待审核",
    ],
    [
      { fromReviewStatus: "needs_review", toReviewStatus: "normal" },
      "待审核 → 正常",
    ],
    [{ fromReviewStatus: "blocked" }, "此前为阻塞"],
    [{ toReviewStatus: "normal" }, "正常"],
  ] as const) {
    const text = renderTemplateNotificationMessage(
      normalizeNotificationEvent({ ...input, ...patch }),
      settings,
    );
    assert.ok(text.includes(`内容审核：${expected}\n`));
  }
});

test("legacy rendering and frozen ISO replay retain their original layout", () => {
  const event = normalizeNotificationEvent({
    ...input,
    title: "旧标题",
    fromReviewStatus: "normal",
    toReviewStatus: "normal",
  });
  const legacy = renderNotificationMessage(event, { includeDetails: true });
  assert.ok(
    legacy.startsWith(
      "【Comiku 通知】\n#12 · 阶段已提交\n发生时间：2026-11-06T08:00:00.000Z\n",
    ),
  );
  assert.match(legacy, /审核：正常 → 正常/);
  assert.match(legacy, /标题：旧标题/);
  assert.equal(buildHistoricalReplayText(legacy), `【历史补发】\n${legacy}`);
  assert.equal(
    buildHistoricalReplayText(buildHistoricalReplayText(legacy)),
    `【历史补发】\n${legacy}`,
  );
});
test("new content reserves replay budget, retains full URL and original text", () => {
  const url = "https://example.test/" + "x".repeat(400);
  const text = renderTemplateNotificationMessage(
    normalizeNotificationEvent({
      ...input,
      title: "😀".repeat(240),
      authorName: "作".repeat(240),
      actorName: "人".repeat(240),
    }),
    { ...settings, authorEnabled: true, note: "😀".repeat(120) },
    url,
  );
  const replay = buildHistoricalReplayText(text);
  assert.ok([...replay].length <= 1000);
  assert.ok(replay.includes(text));
  assert.ok(text.endsWith(`${url}/works/${input.resourceId}`));
  assert.throws(
    () => buildHistoricalReplayText("x".repeat(1000)),
    /notification_replay_too_long/,
  );
});

test("tight heading budget truncates emoji title but preserves fixed facts, suffix and URL", () => {
  const url = "https://example.test/" + "x".repeat(700);
  const event = normalizeNotificationEvent({
    ...input,
    title: "😀".repeat(240),
    fromWorkflowStatus: "translating",
    toWorkflowStatus: "pending_proofread",
    fromReviewStatus: "normal",
    toReviewStatus: "needs_review",
  });
  const text = renderTemplateNotificationMessage(event, settings, url);
  assert.match(text.split("\n")[1], /^#12 😀+… · 阶段已提交$/u);
  assert.match(
    text,
    /职责：翻译\n流程：翻译中 → 待校对\n内容审核：正常 → 待审核/,
  );
  assert.ok(text.endsWith(`登录后查看：${url}/works/${input.resourceId}`));
  assert.equal([...buildHistoricalReplayText(text)].length, 1000);
  assert.equal(Buffer.from(text).toString("utf8"), text);
  assert.throws(
    () =>
      renderTemplateNotificationMessage(
        event,
        settings,
        "https://example.test/" + "x".repeat(1000),
      ),
    /notification_message_too_long/,
  );
});

test("template links reject unsafe site URLs and synthetic messages have no work links", () => {
  const event = normalizeNotificationEvent(input);
  for (const url of [
    "ftp://example.test",
    "https://u:p@example.test",
    "https://example.test/?q=x",
    "https://example.test/#fragment",
  ])
    assert.throws(
      () => renderTemplateNotificationMessage(event, settings, url),
      /notification_site_url_invalid/,
    );
  const text = renderTemplateNotificationMessage(
    event,
    settings,
    "https://example.test",
    true,
  );
  assert.ok(text.endsWith("示例消息，不对应真实作品"));
  assert.doesNotMatch(text, /\/works\//);
});
test("receipt v1 stays strict and hash stable while v2 explicitly validates capture metadata", () => {
  const oldHash = notificationPayloadHash(input);
  assert.equal(
    oldHash,
    "d065ae6edbbe6a0b1d154d15852021b8718248fbda42b77233cbc6749e600017",
  );
  assert.equal(validateNotificationReceiptInput(input, 1).type, input.type);
  assert.throws(
    () => validateNotificationReceiptInput({ ...input, title: "name" }, 1),
    /notification_event_invalid/,
  );
  const v2 = {
    ...input,
    title: "name",
    metadataOrigin: "capture_current",
    metadataObservedAt: "2026-11-07T00:00:00.000Z",
  };
  assert.equal(validateNotificationReceiptInput(v2, 2).snapshot.title, "name");
  assert.equal(
    notificationPayloadHash(v2 as never),
    "868f201ed7e85049d8d1a7fb5eace29ceafd7e6f66f31f40281a54a3d7f967c6",
  );
  for (const bad of [
    { ...v2, metadataOrigin: "event_time" },
    { ...v2, metadataObservedAt: "bad" },
    { ...v2, internalNote: "SECRET" },
  ])
    assert.throws(
      () => validateNotificationReceiptInput(bad, 2),
      /notification_event_invalid/,
    );
  assert.equal(notificationPayloadHash(input), oldHash);
  assert.notEqual(
    notificationPayloadHash(v2 as never),
    notificationPayloadHash({
      ...v2,
      metadataObservedAt: "2026-11-08T00:00:00.000Z",
    } as never),
  );
});
