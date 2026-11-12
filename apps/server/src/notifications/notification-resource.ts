/** Resource namespaces derive from the persisted event type without changing
 * immutable snapshots or the migrations owned by optional integrations. */
export const WORK_REMINDER_EVENTS = ["work.digest", "work.ready"];
export function notificationResourceKind(event: {
  type: string;
}): "work" | "notification_test" | "work_digest" | "work_ready" {
  if (event.type === "work.digest") return "work_digest";
  if (event.type === "work.ready") return "work_ready";
  return event.type === "notification.test" ? "notification_test" : "work";
}
export function notificationResourceTypeFilter(event: { type: string }) {
  const kind = notificationResourceKind(event);
  return kind === "work_digest" || kind === "work_ready"
    ? { equals: event.type }
    : kind === "notification_test"
      ? { equals: "notification.test" }
      : { notIn: [...WORK_REMINDER_EVENTS, "notification.test"] };
}

/** Shared by both routed blockers and earlier unrouted events. */
export function notificationResourceWhere(event: {
  type: string;
  resourceId: string;
}) {
  return {
    resourceId: event.resourceId,
    type: notificationResourceTypeFilter(event),
  };
}
