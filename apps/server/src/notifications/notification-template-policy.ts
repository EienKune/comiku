import { BadRequestException } from "@nestjs/common";
import { WorkStage } from "../generated/prisma/enums.js";
import type { Prisma } from "../generated/prisma/client.js";
import { NOTIFICATION_EVENT_KEYS } from "./notification-events.js";
import type { NotificationWorkEventType } from "./notifications.contracts.js";

export interface NotificationTemplateSettings {
  titleEnabled: boolean;
  authorEnabled: boolean;
  actorEnabled: boolean;
  note: string;
}
export interface NotificationTemplatePolicy extends NotificationTemplateSettings {
  eventType: NotificationWorkEventType;
  revision: number;
  contentRevision: number;
}
export type NotificationSubscriptionRule = {
  eventType: NotificationWorkEventType;
  stages: WorkStage[] | null;
};
export function notificationEventSupportsStages(eventType: string): boolean {
  return (
    eventType.startsWith("stage_") ||
    [
      "typeset_handoff_started",
      "proofreading_skipped",
      "publish_confirmed",
    ].includes(eventType)
  );
}
export function allowedNotificationStages(eventType: string): WorkStage[] {
  if (eventType.startsWith("stage_"))
    return [WorkStage.translate, WorkStage.proofread, WorkStage.typeset];
  if (eventType === "typeset_handoff_started") return [WorkStage.typeset];
  if (eventType === "proofreading_skipped") return [WorkStage.proofread];
  if (eventType === "publish_confirmed") return [WorkStage.publish];
  return [];
}
export function assertNotificationEventType(
  eventType: string,
): asserts eventType is NotificationWorkEventType {
  if (!NOTIFICATION_EVENT_KEYS.includes(eventType as NotificationWorkEventType))
    throw new BadRequestException("通知事件类型无效");
}
export function normalizeTemplateSettings(
  input: NotificationTemplateSettings,
): NotificationTemplateSettings {
  if (
    !input ||
    [input.titleEnabled, input.authorEnabled, input.actorEnabled].some(
      (v) => typeof v !== "boolean",
    ) ||
    typeof input.note !== "string"
  )
    throw new BadRequestException("消息模板配置无效");
  if ([...input.note].length > 120)
    throw new BadRequestException("事件提示语最多120个字符");
  if (/[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(input.note))
    throw new BadRequestException("事件提示语不能包含控制字符");
  return {
    titleEnabled: input.titleEnabled,
    authorEnabled: input.authorEnabled,
    actorEnabled: input.actorEnabled,
    note: input.note.trim(),
  };
}
export function resolveTemplatePolicy(
  eventType: NotificationWorkEventType,
  row?:
    | (NotificationTemplateSettings & {
        revision: number;
        contentRevision: number;
      })
    | null,
): NotificationTemplatePolicy {
  return {
    eventType,
    titleEnabled: row?.titleEnabled ?? false,
    authorEnabled: row?.authorEnabled ?? false,
    actorEnabled: row?.actorEnabled ?? false,
    note: row?.note ?? "",
    revision: row?.revision ?? 0,
    contentRevision: row?.contentRevision ?? 0,
  };
}
export function normalizeSubscriptionRules(
  rules: unknown,
  eventTypes?: readonly string[],
): NotificationSubscriptionRule[] {
  if (!Array.isArray(rules) || rules.length > NOTIFICATION_EVENT_KEYS.length)
    throw new BadRequestException("通知订阅规则无效");
  const seen = new Set<string>();
  const normalized = rules
    .map((rule: unknown) => {
      if (
        !rule ||
        typeof rule !== "object" ||
        !("eventType" in rule) ||
        typeof rule.eventType !== "string" ||
        !("stages" in rule)
      )
        throw new BadRequestException("通知订阅规则无效");
      assertNotificationEventType(rule.eventType);
      const eventType = rule.eventType;
      if (seen.has(rule.eventType))
        throw new BadRequestException("通知事件不可重复订阅");
      seen.add(rule.eventType);
      if (rule.stages === null)
        return { eventType: rule.eventType, stages: null };
      if (
        !notificationEventSupportsStages(eventType) ||
        !Array.isArray(rule.stages) ||
        !rule.stages.length ||
        rule.stages.some(
          (s) => !allowedNotificationStages(eventType).includes(s),
        )
      )
        throw new BadRequestException("通知职责条件无效");
      return {
        eventType: rule.eventType,
        stages: [...new Set<WorkStage>(rule.stages)].sort(),
      };
    })
    .sort((a, b) => a.eventType.localeCompare(b.eventType));
  if (
    eventTypes &&
    JSON.stringify([...new Set(eventTypes)].sort()) !==
      JSON.stringify(normalized.map((r) => r.eventType).sort())
  )
    throw new BadRequestException("通知事件与订阅规则不一致");
  return normalized;
}
export function matchesSubscriptionRule(
  rules: readonly NotificationSubscriptionRule[],
  eventType: string,
  stage?: WorkStage | null,
): NotificationSubscriptionRule | null {
  return (
    rules.find(
      (r) =>
        r.eventType === eventType &&
        (r.stages === null || (stage != null && r.stages.includes(stage))),
    ) ?? null
  );
}
export function matchesNotificationSubscription(
  rules: readonly NotificationSubscriptionRule[],
  eventType: string,
  stage?: WorkStage | null,
): boolean {
  return matchesSubscriptionRule(rules, eventType, stage) !== null;
}
export async function readNotificationTemplates(
  tx: Prisma.TransactionClient,
  options: { lock?: boolean } = {},
): Promise<NotificationTemplatePolicy[]> {
  if (options.lock)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('comiku:notification-templates'))`;
  const rows = await tx.notificationTemplate.findMany({
    where: { eventType: { in: [...NOTIFICATION_EVENT_KEYS] } },
    take: NOTIFICATION_EVENT_KEYS.length,
  });
  return NOTIFICATION_EVENT_KEYS.map((type) =>
    resolveTemplatePolicy(
      type,
      rows.find((r) => r.eventType === type),
    ),
  );
}
