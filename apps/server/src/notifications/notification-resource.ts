/** Resource namespaces derive from the persisted event type without changing
 * immutable snapshots or the migrations owned by optional integrations. */
export const WORK_REMINDER_EVENTS = ["work.digest", "work.ready"];
export function notificationResourceKind(event: {
  type: string;
}): "work" | "notification_test" | "work_digest" {
  if (WORK_REMINDER_EVENTS.includes(event.type)) return "work_digest";
  return event.type === "notification.test" ? "notification_test" : "work";
}
export function notificationResourceTypeFilter(event: { type: string }) {
  const kind = notificationResourceKind(event);
  return kind === "work_digest"
    ? { in: WORK_REMINDER_EVENTS }
    : kind === "notification_test"
      ? { equals: "notification.test" }
      : { notIn: [...WORK_REMINDER_EVENTS, "notification.test"] };
}
