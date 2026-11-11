import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseEnvironment } from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import {
  normalizeNotificationEvent,
  notificationPayloadHash,
} from "../../src/notifications/notification-events.js";
import type { NotificationEventInput } from "../../src/notifications/notifications.contracts.js";

const url = process.env.TEST_DATABASE_URL;
if (url && !new URL(url).pathname.endsWith("_test"))
  throw new Error("Explicit isolated TEST_DATABASE_URL ending _test required");
const migrationUrl = new URL(
  "../../prisma/migrations/20261111000100_birthdays/migration.sql",
  import.meta.url,
);
async function migrationStatements() {
  const migration = await readFile(migrationUrl, "utf8");
  const statements = migration
    .replace(/^--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  // The real migration remains atomic. Only this rollback-only transaction
  // removes its wrapper so COMMIT cannot escape the fixture's isolation.
  assert.equal(statements[0], "BEGIN");
  assert.equal(statements.at(-1), "COMMIT");
  assert.equal(
    statements.filter((statement) => /^(BEGIN|COMMIT)$/i.test(statement))
      .length,
    2,
  );
  return statements.slice(1, -1);
}

test("birthday forward migration retains an explicit transaction", async () => {
  assert.ok((await migrationStatements()).length > 0);
});

test(
  "birthday forward migration preserves legacy notification payloads, frozen routes and delivery evidence",
  { skip: !url, timeout: 30_000 },
  async () => {
    const db = new PrismaService(
      parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url }),
    );
    await db.$connect();
    const schema = `birthday_migration_${randomUUID().replaceAll("-", "")}`;
    const rollback = new Error("rollback isolated birthday migration schema");
    const statements = await migrationStatements();
    try {
      await assert.rejects(
        db.$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
            // No public fallback: an accidentally missing fixture table must
            // fail rather than letting an unqualified migration touch public.
            await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
            for (const table of [
              "notification_channels",
              "notification_events",
              "notification_deliveries",
              "notification_work_event_receipts",
              "notification_attempts",
            ])
              await tx.$executeRawUnsafe(
                `CREATE TABLE "${table}" (LIKE public."${table}" INCLUDING ALL)`,
              );
            // Reconstruct the immediate predecessor using only isolated clones.
            // DROP COLUMN also removes the cloned resource-kind index.
            await tx.$executeRawUnsafe(
              'ALTER TABLE "notification_events" DROP COLUMN "resource_kind"',
            );
            await tx.$executeRawUnsafe(
              'ALTER TABLE "notification_deliveries" DROP COLUMN "birthday_global_generation", DROP COLUMN "birthday_offset_generation", DROP COLUMN "birthday_scope_generation"',
            );
            const channelId = randomUUID();
            const fixedAt = new Date("2026-11-10T01:02:03.004Z");
            await tx.$executeRaw`
              INSERT INTO notification_channels
                (id, name, connection_key, connection_fingerprint, group_id,
                 enabled, event_types, include_details, receiver_mode,
                 subscription_rules, revision, audience_generation,
                 source_accept_after, next_send_at, rate_window_at,
                 rate_window_count, created_at, updated_at)
              VALUES (${channelId}::uuid, 'Synthetic migration group', 'migration-fixture',
                ${"a".repeat(64)}, '123456789', true,
                ARRAY['imported','stage_joined'], false, 'legacy', '[]'::jsonb,
                9, 17, ${fixedAt}, ${fixedAt}, ${fixedAt}, 4, ${fixedAt}, ${fixedAt})`;

            for (const version of [1, 2, 3, 0]) {
              const eventId = randomUUID();
              const deliveryId = randomUUID();
              const resourceId = randomUUID();
              const jobId = randomUUID();
              const input: NotificationEventInput = {
                eventKey: `synthetic-migration:${schema}:${version}`,
                type:
                  version === 0
                    ? "notification.test"
                    : version === 1
                      ? "imported"
                      : "stage_joined",
                resourceId,
                aggregateVersion: 13,
                ordinal: version,
                occurredAt: fixedAt,
                ...(version !== 0 && { workNumber: 100 + version }),
                ...(version >= 2 && {
                  stage: "translate" as const,
                  title: "合成历史标题😀",
                  authorName: "合成历史作者",
                  actorName: "合成历史成员",
                  metadataOrigin: "capture_current" as const,
                  metadataObservedAt: fixedAt.toISOString(),
                }),
                ...(version === 3 && { participationKind: "claim" as const }),
              };
              const normalized = normalizeNotificationEvent(input);
              const hash = notificationPayloadHash(input);
              const text = `【Comiku 冻结历史 v${version}】\n合成原文😀\n完整链接 https://example.test/works/${resourceId}`;
              const routes = [
                {
                  id: channelId,
                  revision: 7,
                  generation: 17,
                  groupId: "123456789",
                  connectionKey: "migration-fixture",
                  connectionFingerprint: "a".repeat(64),
                  includeDetails: false,
                  templateVersion: 1,
                  ...(version !== 1 && {
                    content: {
                      formatVersion: version === 0 ? 1 : 2,
                      receiverMode: version === 0 ? "legacy" : "templates",
                      templatePolicy:
                        version === 0
                          ? null
                          : {
                              eventType: input.type,
                              titleEnabled: true,
                              authorEnabled: false,
                              actorEnabled: true,
                              note: "保留历史提示语",
                              revision: 5,
                              contentRevision: 3,
                            },
                      matchedRule: {
                        eventType: input.type,
                        stages: version >= 2 ? ["translate"] : null,
                      },
                      text,
                      metadataObservedAt:
                        version >= 2 ? fixedAt.toISOString() : null,
                      metadataOrigin: version >= 2 ? "capture_current" : null,
                    },
                  }),
                },
              ];
              await tx.$executeRaw`
                INSERT INTO notification_events
                  (id,event_key,payload_hash,type,resource_id,aggregate_version,
                   ordinal,occurred_at,snapshot,route_refs,routed_at,created_at)
                VALUES (${eventId}::uuid,${input.eventKey},${hash},${input.type},
                  ${resourceId}::uuid,13,${version},${fixedAt},
                  ${JSON.stringify(normalized.snapshot)}::jsonb,
                  ${JSON.stringify(routes)}::jsonb,${fixedAt},${fixedAt})`;
              const status =
                version === 1
                  ? "pending"
                  : version === 2
                    ? "retry_wait"
                    : version === 3
                      ? "unknown"
                      : "accepted";
              await tx.$executeRaw`
                INSERT INTO notification_deliveries
                  (id,event_id,channel_id,audience_generation,replay_generation,
                   connection_key,connection_fingerprint,group_id,channel_revision,
                   text,status,attempts,revision,error_code,provider_message_id,
                   next_attempt_at,job_id,created_at,updated_at)
                VALUES (${deliveryId}::uuid,${eventId}::uuid,${channelId}::uuid,17,${version},
                  'migration-fixture',${"a".repeat(64)},'123456789',7,
                  ${text},${status},${version},6,${status === "unknown" ? "send_interrupted" : null},
                  ${status === "accepted" ? "synthetic-receipt" : null},
                  ${status === "retry_wait" ? fixedAt : null},${jobId}::uuid,${fixedAt},${fixedAt})`;
              if (version > 0)
                await tx.$executeRaw`
                  INSERT INTO notification_work_event_receipts
                    (id,source_event_id,resource_id,resource_ordinal,input_version,
                     safe_input,payload_hash,route_refs,status,attempts,
                     next_attempt_at,notification_event_id,created_at,updated_at)
                  VALUES (${randomUUID()}::uuid,${randomUUID()}::uuid,${resourceId}::uuid,
                    ${version},${version},${JSON.stringify(input)}::jsonb,${hash},
                    ${JSON.stringify(routes)}::jsonb,'registered',2,${fixedAt},
                    ${eventId}::uuid,${fixedAt},${fixedAt})`;
              await tx.$executeRaw`
                INSERT INTO notification_attempts
                  (id,delivery_id,number,job_id,lease_id,send_boundary_crossed,
                   status,error_code,provider_message_id,started_at,completed_at)
                VALUES (${randomUUID()}::uuid,${deliveryId}::uuid,1,${jobId}::uuid,
                  ${randomUUID()}::uuid,true,${status === "unknown" ? "unknown" : "accepted"},
                  ${status === "unknown" ? "send_interrupted" : null},
                  ${status === "accepted" ? "synthetic-receipt" : null},${fixedAt},${fixedAt})`;
            }
            const history = async () => ({
              events: await tx.$queryRaw`
                SELECT to_jsonb(e)-'resource_kind' AS value
                FROM notification_events e ORDER BY event_key`,
              deliveries: await tx.$queryRaw`
                SELECT to_jsonb(d)-'birthday_global_generation'-'birthday_offset_generation'-'birthday_scope_generation' AS value
                FROM notification_deliveries d ORDER BY id`,
              channels: await tx.$queryRaw`
                SELECT to_jsonb(c) AS value FROM notification_channels c ORDER BY id`,
              receipts: await tx.$queryRaw`
                SELECT to_jsonb(r) AS value FROM notification_work_event_receipts r ORDER BY input_version`,
              attempts: await tx.$queryRaw`
                SELECT to_jsonb(a) AS value FROM notification_attempts a ORDER BY id`,
            });
            const before = await history();
            assert.equal((before.events as unknown[]).length, 4);
            assert.equal((before.receipts as unknown[]).length, 3);
            for (const statement of statements)
              await tx.$executeRawUnsafe(statement);
            assert.deepEqual(await history(), before);
            const kinds = await tx.$queryRaw<{ type: string; kind: string }[]>`
              SELECT type,resource_kind AS kind FROM notification_events ORDER BY event_key`;
            assert.equal(
              kinds.filter((row) => row.type === "notification.test").length,
              1,
            );
            for (const row of kinds)
              assert.equal(
                row.kind,
                row.type === "notification.test" ? "notification_test" : "work",
              );
            const [unchangedDeliveryNamespaces] = await tx.$queryRaw<
              { count: number }[]
            >`
              SELECT count(*)::int AS count FROM notification_deliveries
              WHERE birthday_global_generation IS NOT NULL
                 OR birthday_offset_generation IS NOT NULL
                 OR birthday_scope_generation IS NOT NULL`;
            assert.equal(unchangedDeliveryNamespaces!.count, 0);
            const resourceColumn = await tx.$queryRaw<
              { defaultValue: string; nullable: string }[]
            >`
              SELECT column_default AS "defaultValue",is_nullable AS nullable
              FROM information_schema.columns
              WHERE table_schema=${schema} AND table_name='notification_events'
                AND column_name='resource_kind'`;
            assert.match(resourceColumn[0]!.defaultValue, /'work'/);
            assert.equal(resourceColumn[0]!.nullable, "NO");
            // No fixture DDL or record survives this transaction.
            throw rollback;
          },
          { timeout: 20_000 },
        ),
        (error) => error === rollback,
      );
      const [remaining] = await db.$queryRaw<{ present: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=${schema}) AS present`;
      assert.equal(remaining!.present, false);
    } finally {
      await db.$disconnect();
    }
  },
);
