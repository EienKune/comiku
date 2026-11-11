import type {
  WorkStage,
  WorkflowStatus,
  ReviewStatus,
} from "../generated/prisma/client.js";
import type {
  NotificationEventInput,
  NotificationEventType,
  NormalizedNotificationEvent,
} from "./notifications.contracts.js";
import type { NotificationTemplateSettings } from "./notification-template-policy.js";
import {
  normalizeNotificationEvent,
  notificationPreviewEvent,
  NOTIFICATION_EVENT_TYPES,
} from "./notification-events.js";

const REPLAY_MARKER = "【历史补发】\n";
const messageTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const stageLabels: Record<WorkStage, string> = {
  translate: "翻译",
  proofread: "校对",
  typeset: "嵌字",
  publish: "发布",
};
const workflowLabels: Record<WorkflowStatus, string> = {
  pending_translate: "待翻译",
  translating: "翻译中",
  pending_proofread: "待校对",
  proofreading: "校对中",
  pending_typeset: "待嵌字",
  typesetting: "嵌字中",
  pending_publish: "待发布",
  published: "已发布",
  archived: "已归档",
};
const reviewLabels: Record<ReviewStatus, string> = {
  normal: "正常",
  needs_review: "待审核",
  blocked: "阻塞",
};

function transition<T extends string>(
  from: T | undefined,
  to: T | undefined,
  names: Record<T, string>,
): string | null {
  return from && to
    ? `${names[from]} → ${names[to]}`
    : to
      ? names[to]
      : from
        ? `此前为${names[from]}`
        : null;
}

function truncate(text: string, budget: number): string {
  const chars = [...text];
  return chars.length <= budget
    ? text
    : chars.slice(0, Math.max(0, budget - 1)).join("") + "…";
}
const sourceKeys = [
  "eventKey",
  "type",
  "resourceId",
  "workNumber",
  "aggregateVersion",
  "ordinal",
  "occurredAt",
  "stage",
  "fromWorkflowStatus",
  "toWorkflowStatus",
  "fromReviewStatus",
  "toReviewStatus",
];
export function validateNotificationReceiptInput(
  value: unknown,
  version: number,
): NormalizedNotificationEvent {
  const keys = new Set([
    ...sourceKeys,
    ...(version === 2
      ? [
          "title",
          "authorName",
          "actorName",
          "metadataOrigin",
          "metadataObservedAt",
        ]
      : []),
  ]);
  if (
    (version !== 1 && version !== 2) ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.has(key))
  )
    throw new Error("notification_event_invalid");
  const input = value as NotificationEventInput;
  if (
    version === 2 &&
    (input.metadataOrigin !== "capture_current" ||
      typeof input.metadataObservedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
        input.metadataObservedAt,
      ) ||
      !Number.isFinite(Date.parse(input.metadataObservedAt)))
  )
    throw new Error("notification_event_invalid");
  return normalizeNotificationEvent(input);
}

/** Original body is immutable; never reconstruct historical deliveries from live settings. */
export function buildHistoricalReplayText(originalText: string): string {
  if (
    originalText.startsWith(REPLAY_MARKER) ||
    originalText.startsWith("【Comiku 历史补发】\n")
  ) {
    if ([...originalText].length > 1000)
      throw new Error("notification_replay_too_long");
    return originalText;
  }
  if ([...originalText].length + [...REPLAY_MARKER].length > 1000)
    throw new Error("notification_replay_too_long");
  return REPLAY_MARKER + originalText;
}

export function renderTemplateNotificationMessage(
  event: NormalizedNotificationEvent,
  template: NotificationTemplateSettings,
  siteUrl?: string,
  synthetic = false,
): string {
  const snapshot = event.snapshot;
  const identity =
    snapshot.workNumber == null ? "通知" : `#${snapshot.workNumber}`;
  const label =
    NOTIFICATION_EVENT_TYPES.find((item) => item.type === event.type)?.label ??
    "事件";
  const heading = (title = "") =>
    `${identity}${title ? ` ${title}` : ""} · ${label}`;
  const parts = Object.fromEntries(
    messageTime
      .formatToParts(event.occurredAt)
      .map(({ type, value }) => [type, value]),
  );
  const facts = [
    `发生时间：${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`,
  ];
  if (snapshot.stage) facts.push(`职责：${stageLabels[snapshot.stage]}`);
  const workflow = transition(
    snapshot.fromWorkflowStatus,
    snapshot.toWorkflowStatus,
    workflowLabels,
  );
  if (workflow) facts.push(`流程：${workflow}`);
  if (snapshot.fromReviewStatus !== snapshot.toReviewStatus) {
    const review = transition(
      snapshot.fromReviewStatus,
      snapshot.toReviewStatus,
      reviewLabels,
    );
    if (review) facts.push(`内容审核：${review}`);
  }
  let base = "";
  if (siteUrl) {
    const parsed = new URL(siteUrl);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      throw new Error("notification_site_url_invalid");
    base = parsed.origin + parsed.pathname.replace(/\/$/, "");
  }
  const link =
    event.type === "notification.test"
      ? "连接测试消息，不对应真实作品"
      : synthetic
        ? "示例消息，不对应真实作品"
        : `登录后查看：${base}/works/${encodeURIComponent(event.resourceId)}`;
  // Reserve immutable facts, the complete link and a future replay prefix before optional metadata.
  let budget =
    1000 -
    [...REPLAY_MARKER].length -
    [...["【Comiku 通知】", heading(), ...facts, link].join("\n")].length;
  if (budget < 0) throw new Error("notification_message_too_long");
  let title = "";
  if (template.titleEnabled && snapshot.title && budget > 1) {
    title = truncate(snapshot.title, budget - 1);
    budget -= [...title].length + 1;
  }
  const lines = ["【Comiku 通知】", heading(title), ...facts];
  const optional = [
    template.authorEnabled && event.snapshot.authorName
      ? `作者：${event.snapshot.authorName}`
      : "",
    template.actorEnabled && event.snapshot.actorName
      ? `操作：${event.snapshot.actorName}`
      : "",
    template.note,
  ]
    .filter(Boolean)
    .join("\n");
  if (optional && budget > 1) {
    lines.push(truncate(optional, budget - 1));
  }
  return [...lines, link].join("\n");
}

export function notificationTemplatePreview(
  type: NotificationEventType,
  template: NotificationTemplateSettings,
  siteUrl?: string,
  stage?: WorkStage,
  missingMetadata = false,
): string {
  return renderTemplateNotificationMessage(
    notificationPreviewEvent(type, stage, missingMetadata),
    template,
    siteUrl,
    true,
  );
}
