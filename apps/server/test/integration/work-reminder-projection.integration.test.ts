import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { parseEnvironment } from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { Prisma } from "../../src/generated/prisma/client.js";
import { OVERDUE_MILLISECONDS } from "../../src/work-reminders/work-reminder-policy.js";
import {
  readReminderEvidence,
  WorkReminderProjection,
} from "../../src/work-reminders/work-reminder-projection.js";

const url = process.env.TEST_DATABASE_URL;
if (url && !new URL(url).pathname.endsWith("_test"))
  throw new Error("Explicit isolated _test database required");

test(
  "reminder projection PostgreSQL: conservative clocks, exclusive observation, prior-scope deduplication and durable cancellation tokens",
  {
    skip: !url,
    timeout: 120_000,
  },
  async () => {
    const db = new PrismaService(
      parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url }),
    );
    await db.$connect();
    const projection = new WorkReminderProjection(db);
    const user = await db.user.create({
      data: {
        username: `reminder_projection_${randomUUID()}`,
        displayName: "Synthetic Member",
        passwordHash: "synthetic",
        roles: { create: [{ role: "translator" }, { role: "proofreader" }] },
        languageCapabilities: { create: { language: "ja" } },
      },
    });
    const author = await db.author.create({
      data: { displayName: "Synthetic Author" },
    });
    const account = await db.authorExternalAccount.create({
      data: {
        authorId: author.id,
        platform: "fixture",
        externalUserId: randomUUID(),
      },
    });
    const candidate = await db.candidatePost.create({
      data: {
        authorId: author.id,
        authorExternalAccountId: account.id,
        platform: "fixture",
        externalPostId: randomUUID(),
        postedAt: new Date(),
        rawJson: {},
      },
    });
    const work = await db.$transaction(async (tx) => {
      const work = await tx.work.create({
        data: {
          authorId: author.id,
          importedById: user.id,
          sourceCandidatePostId: candidate.id,
          stageParticipants: {
            create: {
              userId: user.id,
              stage: "proofread",
              participationMode: "owner",
            },
          },
        },
      });
      await tx.workEvent.create({
        data: {
          workId: work.id,
          actorId: user.id,
          action: "stage_joined",
          fromWorkflowStatus: "pending_translate",
          toWorkflowStatus: "pending_translate",
          detail: {
            operation: `claim:proofread:${user.id}:`,
            stage: "proofread",
            userId: user.id,
            participationRegistered: true,
          },
        },
      });
      return work;
    });
    const participant = await db.workStageParticipant.findFirstOrThrow({
      where: { workId: work.id },
    });
    const channelId = randomUUID();
    const options = {
      channelId,
      scopeGeneration: 2,
      readyEnabled: true,
      overdueEnabled: true,
    };
    const now = new Date();
    const additionalUserIds: string[] = [];
    const savedClock = await db.workReminderClock.findUnique({
      where: { id: "global" },
    });
    try {
      const claim = await db.workEvent.findFirstOrThrow({
        where: { workId: work.id, action: "stage_joined" },
      });
      assert.deepEqual(claim.createdAt, participant.joinedAt);
      const readClaimEvidence = async () =>
        (
          await db.$transaction((tx) =>
            readReminderEvidence(tx, [participant.id]),
          )
        )[0]!;
      assert.equal((await readClaimEvidence()).preclaimed, true);
      for (const update of [
        { createdAt: new Date(participant.joinedAt.getTime() - 1) },
        { createdAt: new Date(participant.joinedAt.getTime() + 1) },
        { actorId: null },
        {
          fromWorkflowStatus: "pending_proofread" as const,
          toWorkflowStatus: "pending_proofread" as const,
        },
        { detail: { ...(claim.detail as object), userId: randomUUID() } },
        { detail: { ...(claim.detail as object), stage: "typeset" } },
        {
          detail: {
            ...(claim.detail as object),
            operation: `join:proofread:${user.id}:`,
          },
        },
        {
          detail: {
            ...(claim.detail as object),
            participationRegistered: false,
          },
        },
      ]) {
        await db.workEvent.update({ where: { id: claim.id }, data: update });
        assert.equal((await readClaimEvidence()).preclaimed, false);
        await db.workEvent.update({
          where: { id: claim.id },
          data: {
            createdAt: claim.createdAt,
            actorId: claim.actorId,
            fromWorkflowStatus: claim.fromWorkflowStatus,
            toWorkflowStatus: claim.toWorkflowStatus,
            detail: claim.detail as Prisma.InputJsonValue,
          },
        });
      }
      await db.workReminderClock.upsert({
        where: { id: "global" },
        create: {
          id: "global",
          elapsedMilliseconds: 0n,
          lastObservedAt: now,
        },
        update: { elapsedMilliseconds: 0n, lastObservedAt: now },
      });
      await db.work.update({
        where: { id: work.id },
        data: { workflowStatus: "pending_proofread" },
      });
      await projection.maintain(now);
      const recovered = await db.workReminderEpisode.findUniqueOrThrow({
        where: { participantId: participant.id },
      });
      assert.equal(recovered.state, "ready");
      assert.equal(recovered.preclaimed, true);
      assert.equal(recovered.eligibleMilliseconds, 0n);
      await db.workReminderEpisode.delete({
        where: { participantId: participant.id },
      });
      await db.work.update({
        where: { id: work.id },
        data: { workflowStatus: "pending_translate" },
      });
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('comiku:work-reminder-projection', 0))`;
        assert.deepEqual(await projection.maintain(now), {
          processed: 0,
          acquired: false,
        });
      });
      await Promise.all([projection.maintain(now), projection.maintain(now)]);
      let episode = await db.workReminderEpisode.findUniqueOrThrow({
        where: { participantId: participant.id },
      });
      assert.equal(episode.state, "waiting");
      assert.equal(episode.round, 1);
      await db.work.update({
        where: { id: work.id },
        data: {
          workflowStatus: "pending_proofread",
          revision: { increment: 1 },
        },
      });
      const available = new Date(now.getTime() + 60_000);
      await projection.maintain(available);
      let selection = await db.$transaction((tx) =>
        projection.readItems(tx, available, options),
      );
      assert.equal(selection.readyCount, 1);
      assert.equal(selection.items[0]?.kind, "ready");
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM works WHERE id = ${work.id}::uuid FOR UPDATE`;
        await assert.rejects(
          db.$transaction((candidateTx) =>
            projection.readItems(candidateTx, available, options),
          ),
          /could not obtain lock|55P03/,
        );
      });
      await db.workReminderEpisode.update({
        where: { participantId: participant.id },
        data: { eligibleMilliseconds: BigInt(OVERDUE_MILLISECONDS) },
      });
      const urgent = await db.$transaction((tx) =>
        projection.readItems(tx, available, options),
      );
      assert.equal(
        urgent.items.length,
        1,
        "the same task must not appear as both ready and overdue",
      );
      assert.equal(urgent.items[0]?.kind, "overdue");
      assert.equal(urgent.readyCount, 0);
      await db.workReminderEpisode.update({
        where: { participantId: participant.id },
        data: { eligibleMilliseconds: 0n },
      });
      await db.workReminderNotice.create({
        data: {
          participantId: participant.id,
          round: 1,
          kind: "ready",
          channelId,
          scopeGeneration: 1,
          eventId: randomUUID(),
        },
      });
      selection = await db.$transaction((tx) =>
        projection.readItems(tx, available, options),
      );
      assert.equal(
        selection.readyCount,
        0,
        "an older scope notice must prevent an ABA reminder",
      );
      assert.equal(selection.items.length, 0);

      await db.workReminderEpisode.update({
        where: { participantId: participant.id },
        data: {
          eligibleMilliseconds: BigInt(OVERDUE_MILLISECONDS - 60_000),
        },
      });
      const overdue = new Date(available.getTime() + 60_000);
      await projection.maintain(overdue);
      selection = await db.$transaction((tx) =>
        projection.readItems(tx, overdue, options),
      );
      assert.equal(selection.overdueCount, 1);
      assert.equal(selection.items[0]?.kind, "overdue");
      const stale = await db.$transaction((tx) =>
        projection.readItems(
          tx,
          new Date(overdue.getTime() + 120_001),
          options,
        ),
      );
      assert.equal(
        stale.items.length,
        0,
        "an expired worker heartbeat must not be delivered",
      );
      await projection.maintain(new Date(overdue.getTime() - 1));
      episode = await db.workReminderEpisode.findUniqueOrThrow({
        where: { participantId: participant.id },
      });
      assert.deepEqual(episode.lastObservedAt, overdue);
      assert.equal(episode.eligibleMilliseconds, BigInt(OVERDUE_MILLISECONDS));

      await db.workEvent.create({
        data: {
          workId: work.id,
          action: "stage_submission_cancelled",
          createdAt: new Date("2026-01-01T00:00:00Z"),
          detail: {
            stage: "proofread",
            restoredParticipantIds: [participant.id],
          },
        },
      });
      const before = await db.$transaction((tx) =>
        readReminderEvidence(tx, [participant.id]),
      );
      await db.workEvent.create({
        data: {
          workId: work.id,
          action: "stage_submission_cancelled",
          createdAt: new Date("2000-01-01T00:00:00Z"),
          detail: {
            stage: "proofread",
            restoredParticipantIds: [participant.id],
          },
        },
      });
      const after = await db.$transaction((tx) =>
        readReminderEvidence(tx, [participant.id]),
      );
      assert.notEqual(before[0]?.sourceKey, after[0]?.sourceKey);
      await projection.maintain(new Date(overdue.getTime() + 60_000));
      episode = await db.workReminderEpisode.findUniqueOrThrow({
        where: { participantId: participant.id },
      });
      assert.equal(episode.round, 2);
      assert.equal(episode.eligibleMilliseconds, 0n);
      assert.equal(episode.preclaimed, false);
      const additionalIds = Array.from({ length: 1500 }, () => randomUUID());
      additionalUserIds.push(...additionalIds.map(() => randomUUID()));
      await db.user.createMany({
        data: additionalUserIds.map((id) => ({
          id,
          username: `reminder_capacity_${id}`,
          displayName: "Synthetic Member",
          passwordHash: "synthetic",
        })),
      });
      await db.userRole.createMany({
        data: additionalUserIds.map((userId) => ({
          userId,
          role: "proofreader",
        })),
      });
      await db.userLanguageCapability.createMany({
        data: additionalUserIds.map((userId) => ({ userId, language: "ja" })),
      });
      await db.workStageParticipant.createMany({
        data: additionalIds.map((id, index) => ({
          id,
          workId: work.id,
          userId: additionalUserIds[index]!,
          stage: "proofread",
          participationMode: "owner",
        })),
      });
      const participantIds = [participant.id, ...additionalIds];
      const baselineAt = new Date(overdue.getTime() + 60_000);
      await db.workReminderClock.update({
        where: { id: "global" },
        data: {
          elapsedMilliseconds: 0n,
          lastObservedAt: baselineAt,
        },
      });
      const baselineEvidence = await db.$transaction((tx) =>
        readReminderEvidence(tx, participantIds),
      );
      await db.workReminderEpisode.deleteMany({ where: { workId: work.id } });
      await db.workReminderEpisode.createMany({
        data: baselineEvidence.map((item) => ({
          participantId: item.participantId,
          workId: item.workId,
          userId: item.userId,
          stage: item.stage,
          state: item.state,
          sourceKey: item.sourceKey,
          evidenceKey: item.evidenceKey,
          clockMilliseconds: 0n,
          lastObservedAt: baselineAt,
          readyObservedAt: baselineAt,
        })),
      });
      for (let tick = 1; tick <= 8; tick++) {
        const result = await projection.maintain(
          new Date(baselineAt.getTime() + tick * 60_000),
        );
        assert.equal(result.processed, 500);
      }
      const accumulated = await db.workReminderEpisode.findMany({
        where: { workId: work.id },
      });
      assert.equal(accumulated.length, 1501);
      assert.ok(
        accumulated.every((item) => item.eligibleMilliseconds >= 240_000n),
        "every participant must advance even when its observation gap exceeds two minutes",
      );
      const healthyClock = await db.workReminderClock.findUniqueOrThrow({
        where: { id: "global" },
      });
      assert.equal(healthyClock.elapsedMilliseconds, 480_000n);
      const oldest = [...accumulated].sort(
        (a, b) => a.lastObservedAt.getTime() - b.lastObservedAt.getTime(),
      )[0]!;
      assert.ok(
        healthyClock.lastObservedAt.getTime() -
          oldest.lastObservedAt.getTime() >
          120_000,
      );
      await db.workReminderEpisode.update({
        where: { participantId: oldest.participantId },
        data: {
          eligibleMilliseconds:
            BigInt(OVERDUE_MILLISECONDS) -
            (healthyClock.elapsedMilliseconds - oldest.clockMilliseconds),
        },
      });
      const dueDuringRotation = await db.$transaction((tx) =>
        projection.readItems(tx, healthyClock.lastObservedAt, options),
      );
      assert.equal(
        dueDuringRotation.items[0]?.participantId,
        oldest.participantId,
      );
      assert.equal(dueDuringRotation.items[0]?.kind, "overdue");
      const afterShutdown = new Date(baselineAt.getTime() + 1080_000);
      await projection.maintain(afterShutdown);
      assert.equal(
        (
          await db.workReminderClock.findUniqueOrThrow({
            where: { id: "global" },
          })
        ).elapsedMilliseconds,
        480_000n,
      );
      await projection.maintain(new Date(afterShutdown.getTime() + 60_000));
      assert.equal(
        (
          await db.workReminderClock.findUniqueOrThrow({
            where: { id: "global" },
          })
        ).elapsedMilliseconds,
        540_000n,
      );

      const endedIds = Array.from({ length: 50_000 }, () => randomUUID());
      for (let offset = 0; offset < endedIds.length; offset += 2000) {
        await db.workReminderEpisode.createMany({
          data: endedIds.slice(offset, offset + 2000).map((id) => ({
            participantId: id,
            workId: work.id,
            userId: user.id,
            stage: "proofread",
            state: "ended",
            sourceKey: "a".repeat(64),
            evidenceKey: "b".repeat(64),
            clockMilliseconds: 0n,
            lastObservedAt: new Date("2000-01-01T00:00:00Z"),
          })),
        });
      }
      await db.$executeRaw`ANALYZE work_reminder_episodes`;
      await db.$executeRaw`ANALYZE work_stage_participants`;
      const selectionQueries: Prisma.Sql[] = [];
      const monitored = new Proxy(db, {
        get(target, property) {
          if (property === "$transaction")
            return (
              callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
            ) =>
              target.$transaction((tx) =>
                callback(
                  new Proxy(tx, {
                    get(transaction, key) {
                      if (key === "$queryRaw")
                        return (query: Prisma.Sql) => {
                          if (
                            query.sql.includes("FOR UPDATE") &&
                            query.sql.includes("work_reminder_episodes")
                          )
                            selectionQueries.push(query);
                          return transaction.$queryRaw(query);
                        };
                      const value: unknown = Reflect.get(transaction, key);
                      return typeof value === "function"
                        ? value.bind(transaction)
                        : value;
                    },
                  }),
                ),
              );
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      await new WorkReminderProjection(monitored).maintain(
        new Date(afterShutdown.getTime() + 120_000),
      );
      assert.equal(selectionQueries.length, 2);
      for (const query of selectionQueries) {
        const plans = await db.$queryRaw<
          Array<{ "QUERY PLAN": Array<{ Plan: Record<string, unknown> }> }>
        >(Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`);
        let examinedEpisodes = 0;
        const visit = (node: Record<string, unknown>) => {
          if (node["Relation Name"] === "work_reminder_episodes") {
            examinedEpisodes +=
              (Number(node["Actual Rows"] ?? 0) +
                Number(node["Rows Removed by Filter"] ?? 0)) *
              Number(node["Actual Loops"] ?? 1);
          }
          for (const child of (node.Plans ?? []) as Record<string, unknown>[])
            visit(child);
        };
        visit(plans[0]!["QUERY PLAN"][0]!.Plan);
        assert.ok(
          examinedEpisodes < 5000,
          `historical ended rows inflated a live selection to ${examinedEpisodes} visits`,
        );
      }
    } finally {
      await db.workReminderNotice.deleteMany({
        where: { participantId: participant.id },
      });
      await db.workReminderEpisode.deleteMany({
        where: { workId: work.id },
      });
      await db.workEvent.deleteMany({ where: { workId: work.id } });
      await db.workStageParticipant.deleteMany({ where: { workId: work.id } });
      await db.work.delete({ where: { id: work.id } });
      await db.candidatePost.delete({ where: { id: candidate.id } });
      await db.authorExternalAccount.delete({ where: { id: account.id } });
      await db.author.delete({ where: { id: author.id } });
      await db.userLanguageCapability.deleteMany({
        where: { userId: { in: [user.id, ...additionalUserIds] } },
      });
      await db.userRole.deleteMany({
        where: { userId: { in: [user.id, ...additionalUserIds] } },
      });
      await db.user.deleteMany({
        where: { id: { in: [user.id, ...additionalUserIds] } },
      });
      if (savedClock)
        await db.workReminderClock.upsert({
          where: { id: "global" },
          create: savedClock,
          update: {
            elapsedMilliseconds: savedClock.elapsedMilliseconds,
            lastObservedAt: savedClock.lastObservedAt,
          },
        });
      else await db.workReminderClock.deleteMany({ where: { id: "global" } });
      await db.$disconnect();
    }
  },
);
