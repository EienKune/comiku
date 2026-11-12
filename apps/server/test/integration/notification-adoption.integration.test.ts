import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { parseEnvironment } from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { NotificationConnectionRegistry } from "../../src/notifications/notification-connections.js";
import { NotificationPublisherService } from "../../src/notifications/notification-publisher.service.js";
import { NotificationsService } from "../../src/notifications/notifications.service.js";
import type { Prisma } from "../../src/generated/prisma/client.js";

const url = process.env.TEST_DATABASE_URL;
if (url && !new URL(url).pathname.endsWith("_test"))
  throw new Error("Explicit isolated _test database required");
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForBarrier(
  reached: Promise<void>,
  operations: readonly Promise<unknown>[],
  label: string,
  timeoutMs = 5_000,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      reached,
      ...operations.map((operation) =>
        operation.then(() => {
          throw new Error(`${label}: operation completed before the barrier`);
        }),
      ),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label}: barrier timed out`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test(
  "template adoption uses the confirmed revisions atomically with concurrent administrators",
  { skip: !url, timeout: 60_000 },
  async (t) => {
    const env = parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url });
    const db = new PrismaService(env);
    await db.$connect();
    const registry = new NotificationConnectionRegistry({
      env: { NOTIFICATIONS_ENABLED: "true", SYNTHETIC_TOKEN: "synthetic" },
      manifest: [
        {
          key: "adoption",
          name: "Synthetic",
          endpoint: "http://127.0.0.1:1",
          tokenEnv: "SYNTHETIC_TOKEN",
          allowedIps: ["127.0.0.1"],
        },
      ],
    });
    const publisher = new NotificationPublisherService(db, env);
    const service = (database = db) =>
      new NotificationsService(database, publisher, registry, env);
    const users = await Promise.all(
      ["a", "b"].map((suffix) =>
        db.user.create({
          data: {
            username: `adopt_${suffix}_${randomUUID()}`,
            displayName: "Synthetic",
            passwordHash: "synthetic",
            mustChangePassword: false,
            roles: { create: { role: "admin" } },
          },
        }),
      ),
    );
    const ids: string[] = [],
      eventIds: string[] = [];
    const initial = (await service().configuration()).templates.find(
      (x) => x.eventType === "stage_submitted",
    )!;
    const current = async () =>
      (await service().configuration()).templates.find(
        (x) => x.eventType === "stage_submitted",
      )!;
    const editTemplate = async (note: string, target = service()) =>
      target.updateTemplate(users[1]!.id, "stage_submitted", {
        expectedRevision: (await current()).revision,
        titleEnabled: true,
        authorEnabled: true,
        actorEnabled: true,
        note,
      });
    const makeChannel = async () => {
      const c = await service().createChannel(users[0]!.id, {
        name: "Synthetic legacy",
        connectionKey: "adoption",
        groupId: String(Math.floor(Math.random() * 1e12) + 1e12),
        enabled: true,
        eventTypes: ["imported", "stage_submitted"],
        includeDetails: false,
        receiverMode: "legacy",
      });
      ids.push(c.id);
      return c;
    };
    const revisions = async () =>
      (await service().configuration()).templates
        .filter((x) => ["imported", "stage_submitted"].includes(x.eventType))
        .map((x) => ({ eventType: x.eventType, revision: x.revision }));
    type Channel = Awaited<ReturnType<typeof makeChannel>>;
    const adopt = (
      c: Channel,
      expectedTemplateRevisions: { eventType: string; revision: number }[],
      target = service(),
    ) =>
      target.updateChannel(users[0]!.id, c.id, {
        name: c.name,
        connectionKey: c.connectionKey,
        groupId: c.groupId,
        enabled: c.enabled,
        eventTypes: c.eventTypes,
        includeDetails: c.includeDetails,
        receiverMode: "templates",
        subscriptionRules: c.subscriptionRules,
        expectedRevision: c.revision,
        expectedTemplateRevisions,
      });
    const status = (error: unknown, expected: number) =>
      !!error &&
      typeof error === "object" &&
      "getStatus" in error &&
      typeof error.getStatus === "function" &&
      error.getStatus() === expected;
    async function waitingForAdvisory(pid: number, settled: () => boolean) {
      for (let n = 0; n < 200; n++) {
        const locks = await db.$queryRaw<
          { waiting: boolean }[]
        >`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=${pid} AND locktype='advisory' AND NOT granted) AS waiting`;
        if (locks[0]?.waiting) return true;
        if (settled()) return false;
        await delay(10);
      }
      return false;
    }
    // Instrument only the transaction delegate. Original service locking/query logic executes in PostgreSQL.
    function wrapped(
      hook: (tx: Prisma.TransactionClient) => Prisma.TransactionClient,
      entered?: (pid: number) => void,
    ) {
      return new Proxy(db, {
        get(target, key, receiver) {
          if (key !== "$transaction") return Reflect.get(target, key, receiver);
          return <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
            target.$transaction(
              async (tx) => {
                if (entered)
                  entered(
                    (
                      await tx.$queryRaw<
                        { pid: number }[]
                      >`SELECT pg_backend_pid() AS pid`
                    )[0]!.pid,
                  );
                return fn(hook(tx));
              },
              { timeout: 15_000 },
            );
        },
      });
    }
    try {
      await editTemplate("before-preview");
      await t.test(
        "A previews, B changes template, A adoption rejects without changing audience or pending body",
        async () => {
          const c = await makeChannel();
          const confirmed = await revisions();
          const before = await db.notificationChannel.findUniqueOrThrow({
            where: { id: c.id },
          });
          const event = await db.notificationEvent.create({
            data: {
              eventKey: `adoption:${randomUUID()}`,
              payloadHash: "a".repeat(64),
              type: "stage_submitted",
              resourceId: randomUUID(),
              aggregateVersion: 1,
              occurredAt: new Date(),
              snapshot: { workNumber: 1001 },
              routeRefs: [],
            },
          });
          eventIds.push(event.id);
          const old = await db.notificationDelivery.create({
            data: {
              eventId: event.id,
              channelId: c.id,
              audienceGeneration: before.audienceGeneration,
              connectionKey: before.connectionKey,
              connectionFingerprint: before.connectionFingerprint,
              groupId: before.groupId,
              channelRevision: before.revision,
              text: "ORIGINAL_PENDING",
            },
          });
          await editTemplate("changed-after-preview");
          await assert.rejects(adopt(c, confirmed), (e) => status(e, 409));
          const unchanged = await db.notificationChannel.findUniqueOrThrow({
            where: { id: c.id },
          });
          assert.equal(unchanged.receiverMode, "legacy");
          assert.equal(unchanged.revision, before.revision);
          assert.equal(unchanged.audienceGeneration, before.audienceGeneration);
          assert.equal(
            unchanged.sourceAcceptAfter.toISOString(),
            before.sourceAcceptAfter.toISOString(),
          );
          assert.deepEqual(
            await db.notificationDelivery.findUniqueOrThrow({
              where: { id: old.id },
            }),
            old,
          );
          const adopted = await adopt(c, await revisions());
          assert.equal(adopted.receiverMode, "templates");
          assert.equal(adopted.audienceGeneration, before.audienceGeneration);
          assert.equal(
            (
              await db.notificationChannel.findUniqueOrThrow({
                where: { id: c.id },
              })
            ).sourceAcceptAfter.toISOString(),
            before.sourceAcceptAfter.toISOString(),
          );
          assert.deepEqual(
            await db.notificationDelivery.findUniqueOrThrow({
              where: { id: old.id },
            }),
            old,
          );
        },
      );
      await t.test(
        "adoption requires exact selected event revisions including a default template",
        async () => {
          const c = await makeChannel();
          const confirmed = await revisions();
          await assert.rejects(
            adopt(
              c,
              confirmed.filter((x) => x.eventType !== "imported"),
            ),
            (e) => status(e, 400),
          );
          await assert.rejects(adopt(c, [...confirmed, confirmed[0]!]), (e) =>
            status(e, 400),
          );
          await assert.rejects(
            adopt(c, [...confirmed, { eventType: "archived", revision: 0 }]),
            (e) => status(e, 400),
          );
          assert.equal(
            (
              await db.notificationChannel.findUniqueOrThrow({
                where: { id: c.id },
              })
            ).receiverMode,
            "legacy",
          );
          assert.equal((await adopt(c, confirmed)).receiverMode, "templates");
        },
      );
      await t.test(
        "B holds template edit, A waits for it before channel lock then rejects stale confirmation",
        async () => {
          const c = await makeChannel(),
            confirmed = await revisions();
          const written = barrier(),
            release = barrier(),
            entered = barrier();
          let pid = 0,
            settled = false;
          const holding = service(
            wrapped(
              (tx) =>
                new Proxy(tx, {
                  get(target, key, receiver) {
                    if (key !== "notificationTemplate")
                      return Reflect.get(target, key, receiver);
                    return new Proxy(target.notificationTemplate, {
                      get(delegate, method) {
                        if (method !== "update")
                          return Reflect.get(delegate, method);
                        return async (
                          ...args: Parameters<typeof delegate.update>
                        ) => {
                          const result = await delegate.update(...args);
                          written.resolve();
                          await release.promise;
                          return result;
                        };
                      },
                    });
                  },
                }),
            ),
          );
          const writer = editTemplate("writer-first", holding);
          let adoption: ReturnType<typeof adopt> | undefined;
          try {
            await waitForBarrier(written.promise, [writer], "template write");
            const waiting = service(
              wrapped(
                (tx) => tx,
                (value) => {
                  pid = value;
                  entered.resolve();
                },
              ),
            );
            adoption = adopt(c, confirmed, waiting).then(
              (value) => {
                settled = true;
                return value;
              },
              (error) => {
                settled = true;
                throw error;
              },
            );
            await waitForBarrier(
              entered.promise,
              [writer, adoption],
              "adoption transaction entry",
            );
            assert.equal(
              await waitingForAdvisory(pid, () => settled),
              true,
              "adoption must wait for the template policy lock",
            );
            await db.$transaction(
              (tx) =>
                tx.$queryRaw`SELECT id FROM notification_channels WHERE id=${c.id}::uuid FOR UPDATE NOWAIT`,
            );
          } finally {
            release.resolve();
            await Promise.allSettled(adoption ? [writer, adoption] : [writer]);
          }
          await writer;
          assert.ok(adoption);
          await assert.rejects(adoption, (e) => status(e, 409));
          assert.equal(
            (
              await db.notificationChannel.findUniqueOrThrow({
                where: { id: c.id },
              })
            ).receiverMode,
            "legacy",
          );
        },
      );
      await t.test(
        "A commits confirmed adoption before B can edit the shared template",
        async () => {
          const c = await makeChannel(),
            confirmed = await revisions();
          const written = barrier(),
            release = barrier(),
            entered = barrier();
          let pid = 0,
            settled = false;
          const holding = service(
            wrapped(
              (tx) =>
                new Proxy(tx, {
                  get(target, key, receiver) {
                    if (key !== "notificationChannel")
                      return Reflect.get(target, key, receiver);
                    return new Proxy(target.notificationChannel, {
                      get(delegate, method) {
                        if (method !== "update")
                          return Reflect.get(delegate, method);
                        return async (
                          ...args: Parameters<typeof delegate.update>
                        ) => {
                          const result = await delegate.update(...args);
                          written.resolve();
                          await release.promise;
                          return result;
                        };
                      },
                    });
                  },
                }),
            ),
          );
          const adopting = adopt(c, confirmed, holding);
          let update: ReturnType<typeof editTemplate> | undefined;
          try {
            await waitForBarrier(written.promise, [adopting], "channel write");
            const waiting = service(
              wrapped(
                (tx) => tx,
                (value) => {
                  pid = value;
                  entered.resolve();
                },
              ),
            );
            update = editTemplate("adoption-first", waiting).then(
              (value) => {
                settled = true;
                return value;
              },
              (error) => {
                settled = true;
                throw error;
              },
            );
            await waitForBarrier(
              entered.promise,
              [adopting, update],
              "template edit transaction entry",
            );
            assert.equal(
              await waitingForAdvisory(pid, () => settled),
              true,
              "template edit must wait for confirmed adoption to commit",
            );
          } finally {
            release.resolve();
            await Promise.allSettled(update ? [adopting, update] : [adopting]);
          }
          await adopting;
          assert.ok(update);
          assert.ok(await update);
          assert.equal(
            (
              await db.notificationChannel.findUniqueOrThrow({
                where: { id: c.id },
              })
            ).receiverMode,
            "templates",
          );
          assert.equal((await current()).note, "adoption-first");
        },
      );
    } finally {
      await db.notificationAttempt.deleteMany({
        where: { delivery: { channelId: { in: ids } } },
      });
      await db.notificationDelivery.deleteMany({
        where: { channelId: { in: ids } },
      });
      await db.notificationEvent.deleteMany({
        where: { id: { in: eventIds } },
      });
      await db.notificationChannel.deleteMany({ where: { id: { in: ids } } });
      await service().updateTemplate(users[0]!.id, "stage_submitted", {
        expectedRevision: (await current()).revision,
        titleEnabled: initial.titleEnabled,
        authorEnabled: initial.authorEnabled,
        actorEnabled: initial.actorEnabled,
        note: initial.note,
      });
      await db.userRole.deleteMany({
        where: { userId: { in: users.map((x) => x.id) } },
      });
      await db.user.deleteMany({
        where: { id: { in: users.map((x) => x.id) } },
      });
      await db.$disconnect();
    }
  },
);
