import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import type { Environment } from "../src/config/environment.js";
import type { PrismaService } from "../src/database/prisma.service.js";
import type { NotificationConnectionRegistry } from "../src/notifications/notification-connections.js";
import { deliveryDto } from "../src/notifications/notification-engine.helpers.js";
import type { NotificationPublisherService } from "../src/notifications/notification-publisher.service.js";
import { NotificationsService } from "../src/notifications/notifications.service.js";
import { NotificationChannelUpdateDto } from "../src/notifications/notifications.dto.js";

type TemplateRow = {
  eventType: string;
  revision: number;
  contentRevision: number;
  titleEnabled: boolean;
  authorEnabled: boolean;
  actorEnabled: boolean;
  note: string;
};
type UpdateInput = Parameters<NotificationsService["updateChannel"]>[2] & {
  expectedTemplateRevisions?: { eventType: string; revision: number }[];
};

function fixture(options: { eventTypes?: string[]; mode?: string } = {}) {
  let channel = {
    id: "channel",
    name: "Synthetic group",
    connectionKey: "fixture",
    connectionFingerprint: "a".repeat(64),
    groupId: "123",
    enabled: false,
    eventTypes: options.eventTypes ?? ["imported", "stage_submitted"],
    includeDetails: true,
    receiverMode: options.mode ?? "legacy",
    subscriptionRules: [] as { eventType: string; stages: null }[],
    revision: 4,
    audienceGeneration: 7,
    sourceAcceptAfter: new Date("2026-01-01T00:00:00Z"),
  };
  const templates = new Map<string, TemplateRow>();
  const pending = { status: "pending", text: "Original frozen legacy text" };
  const trace: string[] = [];
  let writes = 0;
  let cancellations = 0;
  const tx = {
    $executeRaw: async (sql: TemplateStringsArray) => {
      trace.push(
        sql.join("?").includes("notification-templates")
          ? "template-lock"
          : "other-lock",
      );
      return 0;
    },
    $queryRaw: async (sql: TemplateStringsArray) => {
      const query = sql.join("?");
      if (query.includes("notification_channels")) trace.push("channel-lock");
      return [{ now: new Date("2026-02-01T00:00:00Z") }];
    },
    user: {
      findUnique: async () => ({
        isActive: true,
        mustChangePassword: false,
        roles: [{ role: "admin" }],
      }),
    },
    notificationChannel: {
      findUnique: async () => channel,
      findMany: async () => [channel],
      count: async () => 0,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        writes++;
        return { ...channel, ...data };
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        writes++;
        channel = {
          ...channel,
          ...data,
          revision: channel.revision + 1,
          audienceGeneration:
            channel.audienceGeneration + (data.audienceGeneration ? 1 : 0),
        } as typeof channel;
        return channel;
      },
    },
    notificationTemplate: {
      findMany: async () => {
        trace.push("template-read");
        return [...templates.values()];
      },
      findUnique: async ({ where }: { where: { eventType: string } }) =>
        templates.get(where.eventType) ?? null,
      create: async ({ data }: { data: TemplateRow }) => {
        templates.set(data.eventType, data);
        return data;
      },
      update: async ({
        where,
        data,
      }: {
        where: { eventType: string };
        data: Partial<TemplateRow>;
      }) => {
        const row = { ...templates.get(where.eventType)!, ...data };
        templates.set(where.eventType, row);
        return row;
      },
    },
    notificationDelivery: {
      updateMany: async () => {
        cancellations++;
        pending.status = "cancelled";
        return { count: 1 };
      },
    },
  };
  const service = new NotificationsService(
    {
      ...tx,
      $transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    } as unknown as PrismaService,
    {} as NotificationPublisherService,
    {
      enabled: true,
      safeConnections: () => [],
      get: () => ({ key: "fixture", fingerprint: "a".repeat(64) }),
    } as unknown as NotificationConnectionRegistry,
    { appOrigin: "https://example.test" } as Environment,
  );
  return {
    service,
    tx,
    trace,
    pending,
    get channel() {
      return channel;
    },
    get writes() {
      return writes;
    },
    get cancellations() {
      return cancellations;
    },
    adoption(
      mapping: unknown = channel.eventTypes.map((eventType) => ({
        eventType,
        revision: 0,
      })),
    ): UpdateInput {
      return {
        ...channel,
        receiverMode: "templates",
        subscriptionRules: channel.eventTypes.map((eventType) => ({
          eventType,
          stages: null,
        })),
        expectedRevision: channel.revision,
        expectedTemplateRevisions: mapping,
      } as UpdateInput;
    },
  };
}

test("an unseen template update after preview rejects legacy adoption without changing the channel or old queue", async () => {
  const f = fixture();
  const preview = await f.service.configuration();
  const consent = preview.templates
    .filter((t) => f.channel.eventTypes.includes(t.eventType))
    .map(({ eventType, revision }) => ({ eventType, revision }));
  const before = structuredClone(f.channel);
  await f.service.updateTemplate("other-admin", "imported", {
    expectedRevision: 0,
    titleEnabled: true,
    authorEnabled: true,
    actorEnabled: true,
    note: "Changed after preview",
  });
  assert.equal(f.channel.revision, before.revision);
  await assert.rejects(
    f.service.updateChannel("actor", "channel", f.adoption(consent)),
    (error: unknown) =>
      error instanceof ConflictException &&
      error.getStatus() === 409 &&
      /模板.*重新预览/.test(error.message),
  );
  assert.deepEqual(f.channel, before);
  assert.equal(f.writes, 0);
  assert.equal(f.cancellations, 0);
  assert.deepEqual(f.pending, {
    status: "pending",
    text: "Original frozen legacy text",
  });
});

const invalidMappings: [string, unknown][] = [
  ["missing", undefined],
  ["null", null],
  ["non-array", {}],
  ["empty", []],
  ["one selected event missing", [{ eventType: "imported", revision: 0 }]],
  [
    "duplicate selected event",
    [
      { eventType: "imported", revision: 0 },
      { eventType: "imported", revision: 0 },
    ],
  ],
  [
    "extra event",
    [
      { eventType: "imported", revision: 0 },
      { eventType: "stage_submitted", revision: 0 },
      { eventType: "archived", revision: 0 },
    ],
  ],
  [
    "invalid event",
    [
      { eventType: "imported", revision: 0 },
      { eventType: "unknown", revision: 0 },
    ],
  ],
  [
    "negative revision",
    [
      { eventType: "imported", revision: -1 },
      { eventType: "stage_submitted", revision: 0 },
    ],
  ],
  [
    "fractional revision",
    [
      { eventType: "imported", revision: 0.5 },
      { eventType: "stage_submitted", revision: 0 },
    ],
  ],
  [
    "string revision",
    [
      { eventType: "imported", revision: "0" },
      { eventType: "stage_submitted", revision: 0 },
    ],
  ],
  [
    "missing revision",
    [{ eventType: "imported" }, { eventType: "stage_submitted", revision: 0 }],
  ],
  ["null entry", [null, { eventType: "stage_submitted", revision: 0 }]],
];
for (const [label, mapping] of invalidMappings) {
  test(`legacy adoption rejects ${label} revision mapping atomically for direct service callers`, async () => {
    const f = fixture();
    const before = structuredClone(f.channel);
    const input = f.adoption(mapping);
    if (mapping === undefined) delete input.expectedTemplateRevisions;
    await assert.rejects(
      f.service.updateChannel("actor", "channel", input),
      (error: unknown) =>
        error instanceof BadRequestException && error.getStatus() === 400,
    );
    assert.deepEqual(f.channel, before);
    assert.equal(f.writes, 0);
    assert.equal(f.cancellations, 0);
  });
}

test("fresh adoption requires every default revision and preserves generation, source cutoff and pending text", async () => {
  const f = fixture();
  const cutoff = f.channel.sourceAcceptAfter;
  await f.service.updateTemplate("other-admin", "imported", {
    expectedRevision: 0,
    titleEnabled: true,
    authorEnabled: false,
    actorEnabled: false,
    note: "Current",
  });
  f.trace.length = 0;
  const result = await f.service.updateChannel(
    "actor",
    "channel",
    f.adoption([
      { eventType: "stage_submitted", revision: 0 },
      { eventType: "imported", revision: 1 },
    ]),
  );
  assert.equal(result.receiverMode, "templates");
  assert.equal(result.revision, 5);
  assert.equal(result.audienceGeneration, 7);
  assert.equal(f.channel.sourceAcceptAfter, cutoff);
  assert.deepEqual(f.pending, {
    status: "pending",
    text: "Original frozen legacy text",
  });
  assert.equal(f.cancellations, 0);
  assert.deepEqual(f.trace, ["template-lock", "template-read", "channel-lock"]);
});

test("disabled zero-event adoption accepts an explicit empty map but does not infer missing consent", async () => {
  const missing = fixture({ eventTypes: [] });
  const input = missing.adoption([]);
  delete input.expectedTemplateRevisions;
  await assert.rejects(
    missing.service.updateChannel("actor", "channel", input),
    BadRequestException,
  );
  const f = fixture({ eventTypes: [] });
  const result = await f.service.updateChannel(
    "actor",
    "channel",
    f.adoption([]),
  );
  assert.equal(result.receiverMode, "templates");
  assert.equal(result.audienceGeneration, 7);
  assert.equal(f.cancellations, 0);
});

test("ordinary legacy saves, modern updates and new template groups remain compatible without adoption consent", async () => {
  for (const mode of ["legacy", "templates"]) {
    const f = fixture({ mode });
    const input = { ...f.adoption(), receiverMode: mode };
    delete input.expectedTemplateRevisions;
    const result = await f.service.updateChannel("actor", "channel", input);
    assert.equal(result.receiverMode, mode);
    assert.equal(f.writes, 0);
  }
  const f = fixture();
  f.tx.notificationChannel.findUnique = async () =>
    null as unknown as typeof f.channel;
  const result = await f.service.createChannel("actor", f.adoption());
  assert.equal(result.receiverMode, "templates");
});

test("adoption with a real target change retains audience rollover and old pending cancellation", async () => {
  const f = fixture();
  const result = await f.service.updateChannel("actor", "channel", {
    ...f.adoption(),
    groupId: "456",
  });
  assert.equal(result.audienceGeneration, 8);
  assert.equal(
    f.channel.sourceAcceptAfter.toISOString(),
    "2026-02-01T00:00:00.000Z",
  );
  assert.equal(f.cancellations, 1);
  assert.equal(f.pending.status, "cancelled");
});

test("the update DTO validates nested adoption revisions and accepts revision-zero defaults", async () => {
  const f = fixture();
  const payload = { ...f.adoption() };
  delete (payload as Partial<typeof f.channel>).id;
  const valid = plainToInstance(NotificationChannelUpdateDto, payload);
  assert.deepEqual(await validate(valid), []);
  for (const mapping of [
    null,
    {},
    [null],
    [{ eventType: "imported", revision: "0" }],
    [{ eventType: "imported", revision: -1 }],
    [{ eventType: "unknown", revision: 0 }],
  ]) {
    const dto = plainToInstance(NotificationChannelUpdateDto, {
      ...payload,
      expectedTemplateRevisions: mapping,
    });
    assert.ok(
      (await validate(dto)).some(
        (error) => error.property === "expectedTemplateRevisions",
      ),
      `invalid nested map ${JSON.stringify(mapping)}`,
    );
  }
});

test("history exposes the original delivery target after channel retargeting without connection secrets", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const row = {
    id: "delivery",
    channelId: "channel",
    groupId: "123456789",
    connectionKey: "removed-original",
    connectionFingerprint: "private-fingerprint",
    audienceGeneration: 7,
    channel: {
      name: "Current renamed group",
      groupId: "987654321",
      connectionKey: "current",
      endpoint: "private-endpoint",
      token: "private-token",
    },
    event: { type: "imported", snapshot: { workNumber: 42 }, routeRefs: [] },
    status: "unknown",
    attempts: 1,
    createdAt: now,
    updatedAt: now,
    errorCode: "unresolved",
    providerMessageId: null,
    text: "Frozen old message",
    revision: 0,
    resolvedAt: null,
  };
  const result = deliveryDto(
    row as unknown as Parameters<typeof deliveryDto>[0],
  );
  assert.equal(result.channelName, "Current renamed group");
  assert.equal((result as Record<string, unknown>).groupId, "123456789");
  assert.equal(
    (result as Record<string, unknown>).connectionKey,
    "removed-original",
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /private-fingerprint|private-endpoint|private-token/,
  );
});
