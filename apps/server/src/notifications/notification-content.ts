import type { WorkStage } from "../generated/prisma/client.js";
import type {
  NotificationEventType,
  NormalizedNotificationEvent,
} from "./notifications.contracts.js";
import type { NotificationTemplateSettings } from "./notification-template-policy.js";
import { notificationPreviewEvent } from "./notification-events.js";

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
type EventCopy = {
  action: string;
  actorLabel?: string;
  namedAction?: (name: string) => string;
};

function eventCopy(event: NormalizedNotificationEvent): EventCopy {
  const stage = event.snapshot.stage ? stageLabels[event.snapshot.stage] : "";
  switch (event.type) {
    case "imported":
      return { action: "作品已入库", actorLabel: "入库人" };
    case "stage_joined":
      if (event.snapshot.participationKind === "claim")
        return {
          action: `已认领${stage || "制作任务"}`,
          namedAction: (name) => `${name}认领了${stage || "制作任务"}`,
        };
      if (event.snapshot.participationKind === "join")
        return {
          action: `已加入${stage}协作`,
          namedAction: (name) => `${name}加入${stage}协作`,
        };
      return { action: `已接取${stage || "制作"}任务`, actorLabel: "接取人" };
    case "stage_started":
      return { action: `开始${stage || "制作"}`, actorLabel: "操作人" };
    case "typeset_handoff_started":
      return { action: "嵌字交接已开始", actorLabel: "操作人" };
    case "stage_left":
      return { action: `已退出${stage || "制作"}任务`, actorLabel: "退出人" };
    case "stage_assignment_updated":
      return { action: `${stage}页码分工已调整`, actorLabel: "操作人" };
    case "stage_submitted":
      return {
        action:
          event.snapshot.stage === "translate"
            ? "翻译已提交，待校对"
            : event.snapshot.stage === "proofread"
              ? "校对已提交，待嵌字"
              : event.snapshot.stage === "typeset"
                ? "嵌字已完成，待发布"
                : "阶段已提交",
        actorLabel: "提交人",
      };
    case "proofreading_skipped":
      return { action: "已跳过校对，待嵌字", actorLabel: "操作人" };
    case "stage_submission_cancelled":
      return { action: `${stage || "阶段"}提交已撤回`, actorLabel: "撤回人" };
    case "review_opened":
      return { action: "制作已暂停，原作内容待确认", actorLabel: "申请人" };
    case "review_withdrawn":
      return { action: "已撤销内容审核申请，继续制作", actorLabel: "撤回人" };
    case "review_resumed":
      return { action: "已确认继续制作", actorLabel: "处理人" };
    case "archived":
      return { action: "作品已归档", actorLabel: "操作人" };
    case "restored":
      return { action: "作品已恢复", actorLabel: "操作人" };
    case "publish_confirmed":
      return { action: "发布已确认", actorLabel: "发布人" };
    case "metadata_updated":
      return { action: "作品资料已保存", actorLabel: "保存人" };
    case "collaboration_mode_updated":
      return { action: "协作模式已调整", actorLabel: "操作人" };
    case "stage_credit_updated":
      return { action: `${stage}署名已更新`, actorLabel: "操作人" };
    case "stage_contribution_completed":
      return { action: `个人${stage}分工已完成`, actorLabel: "完成人" };
    case "translation_imported":
      return { action: `${stage}译文已导入`, actorLabel: "导入人" };
    case "typeset_version_uploaded":
      return { action: "成图版本已上传", actorLabel: "上传人" };
    case "typeset_version_selected":
      return { action: "成图版本已选用", actorLabel: "操作人" };
    case "typeset_version_deleted":
      return { action: "成图版本已删除", actorLabel: "操作人" };
    case "typeset_version_restored":
      return { action: "成图版本已恢复", actorLabel: "操作人" };
    case "notification.test":
      return { action: "通知测试", actorLabel: "操作人" };
  }
}

function truncate(text: string, budget: number): string {
  const chars = [...text];
  return chars.length <= budget
    ? text
    : chars.slice(0, Math.max(0, budget - 1)).join("") + "…";
}
export { validateNotificationReceiptInput } from "./notification-receipt-input.js";

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
  const copy = eventCopy(event);
  const heading = (title = "") => `${identity}${title ? ` ${title}` : ""}`;
  const parts = Object.fromEntries(
    messageTime
      .formatToParts(event.occurredAt)
      .map(({ type, value }) => [type, value]),
  );
  const facts = [
    `发生时间：${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`,
  ];
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
  // Reserve the complete action, facts, link and future replay marker before display metadata.
  let budget =
    1000 -
    [...REPLAY_MARKER].length -
    [...["【Comiku 通知】", heading(), copy.action, ...facts, link].join("\n")]
      .length;
  if (budget < 0) throw new Error("notification_message_too_long");
  let title = "";
  if (template.titleEnabled && snapshot.title && budget > 1) {
    title = truncate(snapshot.title, budget - 1);
    budget -= [...title].length + 1;
  }
  const allocateLine = (value: string): string => {
    if (!value || budget <= 1) return "";
    const line = truncate(value, budget - 1);
    budget -= [...line].length + 1;
    return line;
  };
  const author =
    template.authorEnabled && snapshot.authorName
      ? allocateLine(`作者：${snapshot.authorName}`)
      : "";
  let action = copy.action;
  let actorLine = "";
  const actor = template.actorEnabled ? snapshot.actorName : null;
  if (actor && copy.namedAction) {
    // The anonymous action remains complete even when an unusually long URL leaves no name budget.
    const overhead = [...copy.namedAction("")].length - [...copy.action].length;
    if (budget > overhead) {
      const name = truncate(actor, budget - overhead);
      action = copy.namedAction(name);
      budget -= [...action].length - [...copy.action].length;
    }
  } else if (actor && copy.actorLabel)
    actorLine = allocateLine(`${copy.actorLabel}：${actor}`);
  const note = allocateLine(template.note);
  return [
    "【Comiku 通知】",
    heading(title),
    ...(event.type === "imported" && author ? [author] : []),
    action,
    ...facts,
    ...(event.type !== "imported" && author ? [author] : []),
    actorLine,
    note,
    link,
  ]
    .filter(Boolean)
    .join("\n");
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
