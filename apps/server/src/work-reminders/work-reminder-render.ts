import { createHash } from "node:crypto";
import type { WorkStage } from "../generated/prisma/client.js";
import type { NotificationMessageSegment } from "../notifications/notification-message-segments.js";
import { normalizeWorkReminderNote } from "./work-reminder-scheduling.js";

export interface WorkReminderFrozenItem {
  participantId: string;
  round: number;
  userId: string;
  workId: string;
  workNumber: number;
  title: string | null;
  displayName: string;
  stage: WorkStage;
  kind: "ready" | "overdue";
  qqNumber: string | null;
  userRevision: number;
  sourceKey: string;
}
export interface WorkDigestSnapshot {
  kind: "work_digest";
  formatVersion?: 2;
  localDate: string;
  slot: string;
  dueAt: string;
  validBefore: string;
  observedAt: string;
  counts: {
    ready: number;
    overdue: number;
    availableTranslation: number;
    availableProofreading: number;
    availableTypesetting: number;
    availableWorks: number;
    candidates: number;
    translationTotal?: number;
    proofreadingTotal?: number;
    typesettingTotal?: number;
  };
  items: WorkReminderFrozenItem[];
}
export interface WorkReadySnapshot {
  kind: "work_ready";
  dueAt: string;
  validBefore: string;
  observedAt: string;
  items: WorkReminderFrozenItem[];
}
export type WorkReminderSnapshot = WorkDigestSnapshot | WorkReadySnapshot;
const compact = (value: string, length: number) =>
  [...value.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, " ")]
    .slice(0, length)
    .join("");
const stageName: Record<WorkStage, string> = {
  translate: "翻译",
  proofread: "校对",
  typeset: "嵌字",
  publish: "发布",
};
export function renderWorkReminder(
  snapshot: WorkDigestSnapshot,
  note: string,
  mentions: boolean,
  siteUrl = "http://localhost:5173",
) {
  const normalizedNote = normalizeWorkReminderNote(note);
  const observed = new Date(Date.parse(snapshot.observedAt) + 8 * 3_600_000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
  const lines = ["【工作摘要】", `截至 ${observed}`];
  if (snapshot.formatVersion === 2) {
    lines.push(
      `待入库候选：${snapshot.counts.candidates} 篇`,
      `翻译：${snapshot.counts.translationTotal ?? snapshot.counts.availableTranslation} 部（待认领 ${snapshot.counts.availableTranslation}）`,
      `校对：${snapshot.counts.proofreadingTotal ?? snapshot.counts.availableProofreading} 部（待认领 ${snapshot.counts.availableProofreading}）`,
      `嵌字：${snapshot.counts.typesettingTotal ?? snapshot.counts.availableTypesetting} 部（待认领 ${snapshot.counts.availableTypesetting}）`,
    );
    if (snapshot.counts.overdue)
      lines.push(`超过72小时未交稿：${snapshot.counts.overdue} 项`);
  } else if (snapshot.counts.availableWorks || snapshot.counts.candidates)
    lines.push(
      `待接作品 ${snapshot.counts.availableWorks} 部 · 翻译 ${snapshot.counts.availableTranslation} / 校对 ${snapshot.counts.availableProofreading} / 嵌字 ${snapshot.counts.availableTypesetting}`,
      `可入库候选 ${snapshot.counts.candidates} 篇`,
    );
  if (
    snapshot.formatVersion !== 2 &&
    (snapshot.counts.ready || snapshot.counts.overdue)
  )
    lines.push(
      `预认领任务已就绪 ${snapshot.counts.ready} 项 · 超过72小时未交稿 ${snapshot.counts.overdue} 项`,
    );
  for (const item of snapshot.items)
    lines.push(
      `#${item.workNumber} ${compact(item.title ?? "待定标题", 48)} · ${item.kind === "overdue" ? `${stageName[item.stage]}超过72小时未交稿` : `可以开始${stageName[item.stage]}`} · ${compact(item.displayName, 24)}`,
    );
  const total = snapshot.counts.ready + snapshot.counts.overdue;
  if (total > snapshot.items.length)
    lines.push(`另有 ${total - snapshot.items.length} 项`);
  if (normalizedNote) lines.push("", normalizedNote);
  lines.push("", `${siteUrl.replace(/\/$/, "")}/works`);
  const text = lines.join("\n");
  return withMentions(text, snapshot.items, mentions);
}

export function renderWorkReady(
  snapshot: WorkReadySnapshot,
  mentions: boolean,
  siteUrl = "http://localhost:5173",
) {
  if (snapshot.items.length !== 1 || snapshot.items[0]!.kind !== "ready")
    throw new Error("work_ready_items_invalid");
  const item = snapshot.items[0]!;
  const text = [
    "【任务交接提醒】",
    `#${item.workNumber} ${compact(item.title ?? "待定标题", 48)}`,
    `可以开始${stageName[item.stage]}了 · ${compact(item.displayName, 24)}`,
    "",
    `${siteUrl.replace(/\/$/, "")}/works/${item.workId}`,
  ].join("\n");
  return withMentions(text, snapshot.items, mentions);
}

function withMentions(
  text: string,
  items: WorkReminderFrozenItem[],
  mentions: boolean,
) {
  const messageSegments: NotificationMessageSegment[] = [
    { type: "text", data: { text } },
  ];
  const mentioned = new Set<string>();
  if (mentions)
    for (const item of items) {
      if (
        item.qqNumber &&
        /^[1-9][0-9]{4,19}$/.test(item.qqNumber) &&
        !mentioned.has(item.qqNumber)
      ) {
        mentioned.add(item.qqNumber);
        messageSegments.push({ type: "at", data: { qq: item.qqNumber } });
      }
    }
  if ([...text].length > 1000)
    throw new Error("work_reminder_message_too_long");
  return { text, messageSegments };
}
export function workReminderHash(
  occurrenceId: string,
  snapshot: WorkReminderSnapshot,
) {
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, occurrenceId, snapshot }))
    .digest("hex");
}
