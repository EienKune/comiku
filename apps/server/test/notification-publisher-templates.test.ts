import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { NotificationPublisherService } from "../src/notifications/notification-publisher.service.js";
import type { Prisma } from "../src/generated/prisma/client.js";
import type { NotificationFrozenRoute } from "../src/notifications/notifications.contracts.js";

test("direct publisher respects historical stage rules and freezes caller metadata with the saved template", async () => {
  type Stored = Prisma.NotificationEventCreateManyInput & { id: string };
  let stored: Stored | undefined;
  let reads = 0;
  const base = {
    revision: 3,
    audienceGeneration: 2,
    generation: 2,
    groupId: "123456",
    connectionKey: "synthetic",
    connectionFingerprint: "a".repeat(64),
    includeDetails: true,
  };
  const channels = [
    {
      ...base,
      id: "legacy",
      receiverMode: "legacy",
      eventTypes: ["stage_submitted"],
      subscriptionRules: [],
    },
    {
      ...base,
      id: "translate",
      receiverMode: "templates",
      eventTypes: ["stage_submitted"],
      subscriptionRules: [
        { eventType: "stage_submitted", stages: ["translate"] },
      ],
    },
    {
      ...base,
      id: "typeset",
      receiverMode: "templates",
      eventTypes: ["stage_submitted"],
      subscriptionRules: [
        { eventType: "stage_submitted", stages: ["typeset"] },
      ],
    },
  ];
  const template = {
    eventType: "stage_submitted",
    titleEnabled: true,
    authorEnabled: false,
    actorEnabled: true,
    note: "FROZEN_NOTE",
    revision: 8,
    contentRevision: 7,
  };
  const tx = {
    $executeRaw: async () => 1,
    $queryRaw: async () => {
      reads++;
      return channels;
    },
    notificationChannel: {
      findMany: async () => {
        reads++;
        return channels;
      },
    },
    notificationTemplate: { findMany: async () => [template] },
    notificationEvent: {
      findUnique: async () => stored ?? null,
      createMany: async ({
        data,
      }: {
        data: Prisma.NotificationEventCreateManyInput;
      }) => {
        stored ??= { id: "event", ...data };
      },
      findUniqueOrThrow: async () => stored!,
    },
  };
  const publisher = new NotificationPublisherService({
    $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  } as never);
  const input = {
    eventKey: "direct:stage",
    type: "stage_submitted" as const,
    resourceId: "00000000-0000-4000-8000-000000000001",
    aggregateVersion: 1,
    occurredAt: "2026-11-07T00:00:00Z",
    stage: "translate" as const,
    title: "CALLER_TITLE",
    authorName: "CALLER_AUTHOR",
    actorName: "CALLER_ACTOR",
  };
  const first = (await publisher.record(input)) as Stored;
  const routes = first.routeRefs as unknown as NotificationFrozenRoute[];
  assert.deepEqual(
    routes.map((route) => route.id),
    ["legacy", "translate"],
  );
  const content = routes.find((route) => route.id === "translate")!.content!;
  assert.match(content.text, /CALLER_TITLE/);
  assert.match(content.text, /CALLER_ACTOR/);
  assert.doesNotMatch(content.text, /CALLER_AUTHOR/);
  assert.equal(content.templatePolicy!.contentRevision, 7);
  assert.deepEqual(content.matchedRule!.stages, ["translate"]);
  assert.match(
    routes.find((route) => route.id === "legacy")!.content!.text,
    /CALLER_AUTHOR/,
  );
  template.note = "LATER_NOTE";
  channels[1].subscriptionRules = [
    { eventType: "stage_submitted", stages: ["typeset"] },
  ];
  assert.deepEqual(await publisher.record(input), first);
  assert.equal(reads, 1);
  assert.match(content.text, /FROZEN_NOTE/);
  assert.doesNotMatch(content.text, /LATER_NOTE/);
});
