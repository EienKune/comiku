import type { Prisma } from "../generated/prisma/client.js";
import {
  birthdayCutoffEligible,
  birthdayOffsetStates,
} from "../birthdays/birthday-policy.js";
import type { BirthdayNotificationSnapshot } from "../birthdays/birthday-notification.js";

export async function lockBirthdaySettings(tx: Prisma.TransactionClient) {
  await tx.$queryRaw`SELECT id FROM birthday_settings WHERE id = 'global' FOR SHARE`;
  return tx.birthdaySettings.findUnique({ where: { id: "global" } });
}
export async function lockBirthdaySubscription(
  tx: Prisma.TransactionClient,
  channelId: string,
) {
  await tx.$queryRaw`SELECT channel_id FROM birthday_channel_subscriptions WHERE channel_id = ${channelId}::uuid FOR SHARE`;
  return tx.birthdayChannelSubscription.findUnique({ where: { channelId } });
}
export function birthdayDeliveryInvalidReason(
  snapshotValue: unknown,
  generations: {
    birthdayGlobalGeneration?: number | null;
    birthdayOffsetGeneration?: number | null;
    birthdayScopeGeneration?: number | null;
  },
  settings: Awaited<ReturnType<typeof lockBirthdaySettings>>,
  subscription: Awaited<ReturnType<typeof lockBirthdaySubscription>>,
  now = new Date(),
): string | null {
  const snapshot = snapshotValue as BirthdayNotificationSnapshot | null;
  if (
    !snapshot ||
    snapshot.kind !== "birthday_digest" ||
    !Number.isFinite(Date.parse(snapshot.dueAt)) ||
    !Number.isFinite(Date.parse(snapshot.validBefore))
  )
    return "birthday_snapshot_invalid";
  if (now.getTime() >= Date.parse(snapshot.validBefore))
    return "birthday_expired";
  const dueAt = new Date(snapshot.dueAt);
  const offset = birthdayOffsetStates(settings?.offsetStates)[
    String(snapshot.offsetDays)
  ];
  if (
    !settings?.remindersEnabled ||
    settings.reminderGeneration !== generations.birthdayGlobalGeneration ||
    !birthdayCutoffEligible(settings.reminderAcceptAfter, dueAt) ||
    !settings.offsetDays.includes(snapshot.offsetDays) ||
    !offset ||
    offset.generation !== generations.birthdayOffsetGeneration ||
    !birthdayCutoffEligible(offset.acceptAfter, dueAt)
  )
    return "birthday_schedule_changed";
  if (
    !subscription?.enabled ||
    subscription.audienceGeneration !== generations.birthdayScopeGeneration ||
    !birthdayCutoffEligible(subscription.acceptAfter, dueAt)
  )
    return "birthday_subscription_changed";
  return null;
}
