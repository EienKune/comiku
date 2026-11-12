import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeNotificationEvent,
  notificationPayloadHash,
  renderNotificationMessage,
  notificationPreviewEvent,
  NOTIFICATION_EVENT_KEYS,
} from "../src/notifications/notification-events.js";
import {
  buildHistoricalReplayText,
  renderTemplateNotificationMessage,
  notificationTemplatePreview,
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
test("event purpose controls content instead of generic state fields", () => {
  const cases = [
    ["imported", "作品已入库"],
    ["stage_joined", "已接取翻译任务"],
    ["stage_started", "开始翻译"],
    ["typeset_handoff_started", "嵌字交接已开始"],
    ["stage_left", "已退出翻译任务"],
    ["stage_assignment_updated", "翻译页码分工已调整"],
    ["stage_submitted", "翻译已提交，待校对"],
    ["proofreading_skipped", "已跳过校对，待嵌字"],
    ["stage_submission_cancelled", "翻译提交已撤回"],
    ["review_opened", "制作已暂停，原作内容待确认"],
    ["review_withdrawn", "已撤销内容审核申请，继续制作"],
    ["review_resumed", "已确认继续制作"],
    ["archived", "作品已归档"],
    ["restored", "作品已恢复"],
    ["publish_confirmed", "发布已确认"],
    ["metadata_updated", "作品资料已保存"],
    ["collaboration_mode_updated", "协作模式已调整"],
    ["stage_credit_updated", "翻译署名已更新"],
    ["stage_contribution_completed", "个人翻译分工已完成"],
    ["translation_imported", "翻译译文已导入"],
    ["typeset_version_uploaded", "成图版本已上传"],
    ["typeset_version_selected", "成图版本已选用"],
    ["typeset_version_deleted", "成图版本已删除"],
    ["typeset_version_restored", "成图版本已恢复"],
  ] as const;
  for (const [type, action] of cases) {
    const text = renderTemplateNotificationMessage(
      normalizeNotificationEvent({
        ...input,
        type,
        title: "作品",
        actorName: "小夏",
        fromWorkflowStatus: "translating",
        toWorkflowStatus: "pending_proofread",
        fromReviewStatus: "normal",
        toReviewStatus: "needs_review",
      }),
      settings,
      "https://example.test",
    );
    assert.ok(text.includes(action), `${type}: ${text}`);
    assert.doesNotMatch(
      text,
      /职责：|流程：|内容审核：|原因：|版本号：|已导入作品/,
    );
    assert.ok(text.includes("发生时间：2026-11-06 16:00:00"));
    assert.ok(text.endsWith(`/works/${input.resourceId}`));
  }
});

test("participation distinguishes claim, cooperation and unknown without leaking disabled names", () => {
  for (const [participationKind, expected] of [
    ["claim", "小夏认领了翻译"],
    ["join", "小夏加入翻译协作"],
    [undefined, "已接取翻译任务"],
  ] as const) {
    const event = normalizeNotificationEvent({
      ...input,
      type: "stage_joined",
      actorName: "小夏",
      ...(participationKind && { participationKind }),
    });
    const text = renderTemplateNotificationMessage(event, settings);
    assert.ok(text.includes(expected), text);
    assert.equal(text.split("小夏").length - 1, 1);
    for (const hidden of [
      normalizeNotificationEvent({
        ...input,
        type: "stage_joined",
        ...(participationKind && { participationKind }),
      }),
      event,
    ]) {
      const masked = renderTemplateNotificationMessage(hidden, {
        ...settings,
        actorEnabled: false,
      });
      assert.doesNotMatch(masked, /小夏|undefined|null/);
      assert.ok(
        masked.includes(
          participationKind === "claim"
            ? "已认领翻译"
            : participationKind === "join"
              ? "已加入翻译协作"
              : "已接取翻译任务",
        ),
      );
    }
  }
});

test("stage submissions describe handoff, not personal contribution or version upload", () => {
  for (const [stage, expected] of [
    ["translate", "翻译已提交，待校对"],
    ["proofread", "校对已提交，待嵌字"],
    ["typeset", "嵌字已完成，待发布"],
  ] as const) {
    const text = renderTemplateNotificationMessage(
      normalizeNotificationEvent({ ...input, stage }),
      settings,
    );
    assert.ok(text.includes(expected));
  }
  for (const type of [
    "stage_contribution_completed",
    "typeset_version_uploaded",
  ] as const) {
    const text = renderTemplateNotificationMessage(
      normalizeNotificationEvent({ ...input, type, stage: "typeset" }),
      settings,
    );
    assert.doesNotMatch(text, /嵌字已完成，待发布|整阶段已完成/);
  }
});

test("every event respects all masks and preview uses the delivery renderer", () => {
  for (const type of NOTIFICATION_EVENT_KEYS) {
    for (const titleEnabled of [false, true])
      for (const authorEnabled of [false, true])
        for (const actorEnabled of [false, true]) {
          const policy = {
            titleEnabled,
            authorEnabled,
            actorEnabled,
            note: "独立提示",
          };
          const text = renderTemplateNotificationMessage(
            normalizeNotificationEvent({
              ...input,
              type,
              title: "PRIVATE_TITLE",
              authorName: "PRIVATE_AUTHOR",
              actorName: "PRIVATE_ACTOR",
            }),
            policy,
          );
          assert.equal(
            text.split("\n")[1],
            `#12${titleEnabled ? " PRIVATE_TITLE" : ""}`,
            type,
          );
          assert.equal(text.includes("PRIVATE_TITLE"), titleEnabled, type);
          assert.equal(text.includes("PRIVATE_AUTHOR"), authorEnabled, type);
          assert.equal(text.includes("PRIVATE_ACTOR"), actorEnabled, type);
          assert.equal(
            text.split("PRIVATE_ACTOR").length - 1,
            actorEnabled ? 1 : 0,
            type,
          );
          if (type === "stage_submitted")
            assert.equal(text.includes("提交人：PRIVATE_ACTOR"), actorEnabled);
          assert.ok(text.includes("\n独立提示\n"));
          assert.equal(
            notificationTemplatePreview(type, policy, "https://example.test"),
            renderTemplateNotificationMessage(
              notificationPreviewEvent(type),
              policy,
              "https://example.test",
              true,
            ),
          );
        }
    const missing = notificationTemplatePreview(
      type,
      { ...settings, authorEnabled: true },
      undefined,
      undefined,
      true,
    );
    assert.doesNotMatch(
      missing,
      /undefined|null|标题：|作者：|操作人：|保存人：|提交人：/,
    );
    assert.equal(missing.split("\n")[1], "#1001", type);
  }
});

test("claim and join keep full action and link under every tight Unicode budget", () => {
  for (const participationKind of ["claim", "join"] as const)
    for (const pathLength of [0, 400, 700, 850]) {
      const url = "https://example.test/" + "x".repeat(pathLength);
      const event = normalizeNotificationEvent({
        ...input,
        type: "stage_joined",
        participationKind,
        title: "😀".repeat(240),
        authorName: "😀".repeat(240),
        actorName: "😀".repeat(240),
      });
      const text = renderTemplateNotificationMessage(
        event,
        { ...settings, authorEnabled: true, note: "😀".repeat(120) },
        url,
      );
      assert.ok([...buildHistoricalReplayText(text)].length <= 1000);
      assert.ok(
        text.endsWith(`${url.replace(/\/$/, "")}/works/${input.resourceId}`),
      );
      assert.match(
        text,
        participationKind === "claim"
          ? /(?:认领了|已认领)翻译/
          : /加入翻译协作/,
      );
      assert.equal(Buffer.from(text).toString("utf8"), text);
    }
});

test("import places author before action and metadata only confirms saving", () => {
  const imported = renderTemplateNotificationMessage(
    normalizeNotificationEvent({
      ...input,
      type: "imported",
      authorName: "画师",
      actorName: "小夏",
    }),
    { ...settings, authorEnabled: true },
  );
  assert.ok(imported.indexOf("作者：画师") < imported.indexOf("作品已入库"));
  const metadata = renderTemplateNotificationMessage(
    normalizeNotificationEvent({
      ...input,
      type: "metadata_updated",
      actorName: "小夏",
      fromWorkflowStatus: "pending_translate",
      toWorkflowStatus: "pending_translate",
    }),
    settings,
  );
  assert.match(metadata, /作品资料已保存/);
  assert.match(metadata, /保存人：小夏/);
  assert.doesNotMatch(metadata, /待翻译|状态：|已修改标题/);
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
  assert.ok(
    text.endsWith(`${url.replace(/\/$/, "")}/works/${input.resourceId}`),
  );
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
  assert.match(text.split("\n")[1], /^#12 😀+…$/u);
  assert.match(text, /翻译已提交，待校对/);
  assert.doesNotMatch(text, /职责：|流程：|内容审核：/);
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
