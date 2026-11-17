import type { components } from "@comiku/api-client";
import type { QueryClient } from "@tanstack/react-query";

type Channel = components["schemas"]["NotificationChannelDto"];
export async function adoptConfirmedChannelMetadata(
  cache: QueryClient,
  saved: Channel,
) {
  const workKey = ["work-reminders", "subscriptions"];
  const birthdayKey = ["birthdays", "subscriptions"];
  // An older GET must not restore the pre-write audience after this confirmed
  // response. Only channel metadata is authoritative here; scope drafts and
  // their subscription revisions remain owned by their independent editors.
  await Promise.all([
    cache.cancelQueries({ queryKey: workKey, exact: true }),
    cache.cancelQueries({ queryKey: birthdayKey, exact: true }),
  ]);
  const metadata = {
    name: saved.name,
    groupId: saved.groupId,
    connectionKey: saved.connectionKey,
    enabled: saved.enabled,
    revision: saved.revision,
  };
  cache.setQueryData<components["schemas"]["WorkReminderManagementDto"]>(
    workKey,
    (current) =>
      current
        ? {
            ...current,
            channels: current.channels.map((channel) =>
              channel.id === saved.id ? { ...channel, ...metadata } : channel,
            ),
          }
        : current,
  );
  cache.setQueryData<components["schemas"]["BirthdayChannelDto"][]>(
    birthdayKey,
    (current) =>
      current?.map((channel) =>
        channel.id === saved.id ? { ...channel, ...metadata } : channel,
      ),
  );
}
