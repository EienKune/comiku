import { createHash } from "node:crypto";
import {
  WorkStage,
  WorkflowStatus,
  ReviewStatus,
} from "../generated/prisma/enums.js";
import type {
  NotificationEventInput,
  NotificationEventType,
  NormalizedNotificationEvent,
  NotificationWorkEventType,
} from "./notifications.contracts.js";

export const NOTIFICATION_EVENT_TYPES: readonly {
  type: NotificationEventType;
  label: string;
}[] = Object.freeze([
  { type: "imported", label: "已导入" },
  { type: "stage_joined", label: "已加入阶段" },
  { type: "stage_left", label: "已退出阶段" },
  { type: "stage_assignment_updated", label: "阶段分工已调整" },
  { type: "stage_submitted", label: "阶段已提交" },
  { type: "proofreading_skipped", label: "已跳过校对" },
  { type: "stage_submission_cancelled", label: "阶段提交已撤销" },
  { type: "review_opened", label: "审核已开启" },
  { type: "review_withdrawn", label: "审核已撤回" },
  { type: "review_resumed", label: "审核已恢复" },
  { type: "archived", label: "已归档" },
  { type: "restored", label: "已恢复" },
  { type: "publish_confirmed", label: "发布已确认" },
  { type: "notification.test", label: "通知测试" },
]);
export const NOTIFICATION_EVENT_KEYS: readonly NotificationWorkEventType[] =
  Object.freeze(
    NOTIFICATION_EVENT_TYPES.map((item) => item.type).filter(
      (type): type is NotificationWorkEventType => type !== "notification.test",
    ),
  );
const labels = new Map(
  NOTIFICATION_EVENT_TYPES.map((item) => [item.type, item.label]),
);
const stageLabels: Record<WorkStage, string> = {
  [WorkStage.translate]: "翻译",
  [WorkStage.proofread]: "校对",
  [WorkStage.typeset]: "嵌字",
  [WorkStage.publish]: "发布",
};
const workflowLabels: Record<WorkflowStatus, string> = {
  [WorkflowStatus.pending_translate]: "待翻译",
  [WorkflowStatus.translating]: "翻译中",
  [WorkflowStatus.pending_proofread]: "待校对",
  [WorkflowStatus.proofreading]: "校对中",
  [WorkflowStatus.pending_typeset]: "待嵌字",
  [WorkflowStatus.typesetting]: "嵌字中",
  [WorkflowStatus.pending_publish]: "待发布",
  [WorkflowStatus.published]: "已发布",
  [WorkflowStatus.archived]: "已归档",
};
const reviewLabels: Record<ReviewStatus, string> = {
  [ReviewStatus.normal]: "正常",
  [ReviewStatus.needs_review]: "待审核",
  [ReviewStatus.blocked]: "阻塞",
};
const stages = new Set<string>(Object.values(WorkStage));
const workflowStatuses = new Set<string>(Object.values(WorkflowStatus));
const reviewStatuses = new Set<string>(Object.values(ReviewStatus));
const safeText = (value: string | null | undefined) =>
  value == null
    ? null
    : [...value.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, " ").trim()]
        .slice(0, 240)
        .join("") || null;

export function normalizeNotificationEvent(
  input: NotificationEventInput,
): NormalizedNotificationEvent {
  if (
    !input ||
    typeof input !== "object" ||
    !(
      input.occurredAt instanceof Date ||
      (typeof input.occurredAt === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
          input.occurredAt,
        ))
    )
  )
    throw new Error("notification_event_invalid");
  const occurredAt = new Date(input.occurredAt);
  if (
    !labels.has(input.type) ||
    typeof input.eventKey !== "string" ||
    !input.eventKey.trim() ||
    input.eventKey.length > 200 ||
    /\p{Cc}/u.test(input.eventKey) ||
    typeof input.resourceId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      input.resourceId,
    ) ||
    !Number.isInteger(input.aggregateVersion) ||
    input.aggregateVersion < 0 ||
    input.aggregateVersion > 2_147_483_647 ||
    !Number.isInteger(input.ordinal ?? 0) ||
    (input.ordinal ?? 0) < 0 ||
    (input.ordinal ?? 0) > 2_147_483_647 ||
    !Number.isFinite(occurredAt.getTime()) ||
    (input.workNumber != null &&
      (!Number.isInteger(input.workNumber) ||
        input.workNumber < 1 ||
        input.workNumber > 2_147_483_647)) ||
    (input.stage !== undefined && !stages.has(input.stage)) ||
    [input.fromWorkflowStatus, input.toWorkflowStatus].some(
      (value) => value !== undefined && !workflowStatuses.has(value),
    ) ||
    [input.fromReviewStatus, input.toReviewStatus].some(
      (value) => value !== undefined && !reviewStatuses.has(value),
    ) ||
    [input.title, input.authorName, input.actorName].some(
      (value) => value != null && typeof value !== "string",
    )
  ) {
    throw new Error("notification_event_invalid");
  }
  return {
    eventKey: input.eventKey,
    type: input.type,
    resourceId: input.resourceId.toLowerCase(),
    aggregateVersion: input.aggregateVersion,
    ordinal: input.ordinal ?? 0,
    occurredAt,
    snapshot: {
      workNumber: input.workNumber ?? null,
      title: safeText(input.title),
      authorName: safeText(input.authorName),
      actorName: safeText(input.actorName),
      ...(input.stage !== undefined && { stage: input.stage }),
      ...(input.fromWorkflowStatus !== undefined && {
        fromWorkflowStatus: input.fromWorkflowStatus,
      }),
      ...(input.toWorkflowStatus !== undefined && {
        toWorkflowStatus: input.toWorkflowStatus,
      }),
      ...(input.fromReviewStatus !== undefined && {
        fromReviewStatus: input.fromReviewStatus,
      }),
      ...(input.toReviewStatus !== undefined && {
        toReviewStatus: input.toReviewStatus,
      }),
    },
  };
}

export function notificationPayloadHash(input: NotificationEventInput): string {
  return createHash("sha256")
    .update(JSON.stringify(normalizeNotificationEvent(input)))
    .digest("hex");
}

/** Version 1 is deliberately fixed; arbitrary business detail and templates are never accepted. */
export function renderNotificationMessage(
  event: NormalizedNotificationEvent,
  options: {
    includeDetails: boolean;
    siteUrl?: string;
    historicalReplay?: boolean;
  },
): string {
  const lines = [
    options.historicalReplay ? "【Comiku 历史补发】" : "【Comiku 通知】",
    `${event.snapshot.workNumber == null ? "通知" : `#${event.snapshot.workNumber}`} · ${labels.get(event.type) ?? "事件"}`,
    `发生时间：${event.occurredAt.toISOString()}`,
  ];
  const snapshot = event.snapshot;
  if (snapshot.stage) lines.push(`职责：${stageLabels[snapshot.stage]}`);
  const transition = <T extends string>(
    from: T | undefined,
    to: T | undefined,
    names: Record<T, string>,
  ) =>
    from && to
      ? `${names[from]} → ${names[to]}`
      : to
        ? names[to]
        : from
          ? `此前为${names[from]}`
          : null;
  const workflow = transition(
    snapshot.fromWorkflowStatus,
    snapshot.toWorkflowStatus,
    workflowLabels,
  );
  const review = transition(
    snapshot.fromReviewStatus,
    snapshot.toReviewStatus,
    reviewLabels,
  );
  if (workflow) lines.push(`流程：${workflow}`);
  if (review) lines.push(`审核：${review}`);
  const details: string[] = [];
  if (options.includeDetails) {
    if (event.snapshot.title)
      details.push(`标题：${safeText(event.snapshot.title)}`);
    if (event.snapshot.authorName)
      details.push(`作者：${safeText(event.snapshot.authorName)}`);
    if (event.snapshot.actorName)
      details.push(`操作：${safeText(event.snapshot.actorName)}`);
  }
  let base = "";
  if (options.siteUrl) {
    const parsed = new URL(options.siteUrl);
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
  const link = `登录后查看：${base}/works/${encodeURIComponent(event.resourceId)}`;
  const fixedLength = [...[...lines, link].join("\n")].length;
  if (fixedLength > 1000) throw new Error("notification_message_too_long");
  // Preserve every historical fact and the complete URL; only optional personal details spend the remaining budget.
  const detailBudget = 1000 - fixedLength - 1;
  if (details.length && detailBudget > 0) {
    const detailText = [...details.join("\n")];
    const suffix = ".".repeat(Math.min(3, detailBudget));
    lines.push(
      detailText.length <= detailBudget
        ? detailText.join("")
        : detailText.slice(0, detailBudget - suffix.length).join("") + suffix,
    );
  }
  return [...lines, link].join("\n");
}

export function notificationPreview(
  type: NotificationEventType,
  includeDetails: boolean,
  siteUrl?: string,
): string {
  // Synthetic examples only; producers remain responsible for the real historical facts.
  const history: Partial<NotificationEventInput> =
    type === "review_opened"
      ? {
          fromReviewStatus: ReviewStatus.normal,
          toReviewStatus: ReviewStatus.needs_review,
        }
      : type === "review_withdrawn" || type === "review_resumed"
        ? {
            fromReviewStatus: ReviewStatus.needs_review,
            toReviewStatus: ReviewStatus.normal,
          }
        : type === "archived"
          ? {
              fromWorkflowStatus: WorkflowStatus.translating,
              toWorkflowStatus: WorkflowStatus.archived,
            }
          : type === "restored"
            ? {
                fromWorkflowStatus: WorkflowStatus.archived,
                toWorkflowStatus: WorkflowStatus.translating,
              }
            : type === "publish_confirmed"
              ? {
                  stage: WorkStage.publish,
                  fromWorkflowStatus: WorkflowStatus.pending_publish,
                  toWorkflowStatus: WorkflowStatus.published,
                }
              : type === "proofreading_skipped"
                ? {
                    stage: WorkStage.proofread,
                    fromWorkflowStatus: WorkflowStatus.pending_proofread,
                    toWorkflowStatus: WorkflowStatus.pending_typeset,
                  }
                : type === "stage_submitted"
                  ? {
                      stage: WorkStage.translate,
                      fromWorkflowStatus: WorkflowStatus.translating,
                      toWorkflowStatus: WorkflowStatus.pending_proofread,
                    }
                  : type === "stage_submission_cancelled"
                    ? {
                        stage: WorkStage.translate,
                        fromWorkflowStatus: WorkflowStatus.pending_proofread,
                        toWorkflowStatus: WorkflowStatus.translating,
                      }
                    : type === "stage_joined"
                      ? {
                          stage: WorkStage.translate,
                          fromWorkflowStatus: WorkflowStatus.pending_translate,
                          toWorkflowStatus: WorkflowStatus.translating,
                        }
                      : type === "stage_left" ||
                          type === "stage_assignment_updated"
                        ? { stage: WorkStage.translate }
                        : type === "imported"
                          ? {
                              toWorkflowStatus:
                                WorkflowStatus.pending_translate,
                            }
                          : {};
  return renderNotificationMessage(
    normalizeNotificationEvent({
      eventKey: "preview",
      type,
      resourceId: "00000000-0000-4000-8000-000000000001",
      aggregateVersion: 1,
      occurredAt: "2026-01-01T00:00:00.000Z",
      workNumber: 1001,
      title: "合成预览作品",
      authorName: "预览作者",
      actorName: "预览成员",
      ...history,
    }),
    { includeDetails, siteUrl },
  );
}
