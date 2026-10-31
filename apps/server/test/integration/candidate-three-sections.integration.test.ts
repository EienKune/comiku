import { CandidatesService } from "../../src/candidates/candidates.service.js";
import type { Prisma } from "../../src/generated/prisma/client.js";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { candidateReviewFixture } from "./candidate-review-fixture.js";

test("three review sections retain both tag directions and freeze reasons until explicit refresh", async () => {
  const f = await candidateReviewFixture();
  const groupIds: string[] = [];
  try {
    const yes = await f.service.createTagGroup({
      name: `yes-${randomUUID()}`,
      kind: "valid",
      enabled: true,
      aliases: [`yes${randomUUID()}`],
    });
    groupIds.push(yes.id);
    const no = await f.service.createTagGroup({
      name: `no-${randomUUID()}`,
      kind: "blocked",
      enabled: true,
      aliases: [`no${randomUUID()}`],
    });
    groupIds.push(no.id);
    const p = await f.post({
      analysisPredictions: [],
      hashtags: {
        create: [
          {
            normalizedValue: yes.aliases[0].toLowerCase(),
            displayValue: yes.aliases[0],
          },
          {
            normalizedValue: no.aliases[0].toLowerCase(),
            displayValue: no.aliases[0],
          },
        ],
      },
    });
    const old = await f.db.candidateClassificationDecision.create({
      data: { candidatePostId: p.id, label: "photo", decidedById: f.actor.id },
    });
    const session = await f.create();
    assert.equal(session.counts.uncertain, 1);
    const query = { ...f.filter, reviewSessionId: session.sessionId };
    const card = (await f.service.list(query, f.actor.id)).items[0];
    assert.equal(card.triageGroup, "uncertain");
    assert.ok(card.triageReasons.includes("rule_conflict"));
    assert.deepEqual(card.tagRuleMatches.map((m) => m.direction).sort(), [
      "deprioritize",
      "priority",
    ]);
    await f.service.updateTagGroup(no.id, {
      ...no,
      name: `changed-${randomUUID()}`,
      enabled: false,
      expectedRevision: no.revision,
    });
    const unchanged = (await f.service.list(query, f.actor.id)).items[0];
    assert.deepEqual(unchanged.tagRuleMatches, card.tagRuleMatches);
    assert.deepEqual(unchanged.triageReasons, card.triageReasons);
    const refreshed = await f.create(session.sessionId);
    assert.equal(refreshed.counts.priority, 1);
    assert.deepEqual(
      await f.db.candidateClassificationDecision.findUnique({
        where: { candidatePostId: p.id },
      }),
      old,
    );
  } finally {
    await f.close();
    await f.db.$connect();
    await f.db.candidateTagGroup.deleteMany({
      where: { id: { in: groupIds } },
    });
    await f.db.$disconnect();
  }
});

test("current valid image winners route posts conservatively, without legacy classification or cache precedence", async () => {
  const f = await candidateReviewFixture();
  try {
    const positive = await f.post({
      analysisState: "failed",
      analysisPredictions: [
        { label: "positive", confidence: 0.4, score: 0.7 },
        { label: "other", confidence: 0.9, score: 0.9 },
      ],
    });
    const highPrecision = await f.post({
      analysisPredictions: [
        { label: "other", confidence: 0.9, score: 0.30000000000000004 },
      ],
    });
    assert.equal(
      (await f.service.get(highPrecision.id)).triageGroup,
      "low_priority",
    );
    const low = await f.post({
      analysisPredictions: [{ label: "other", confidence: 0.9, score: 0.2 }],
    });
    const related = await f.post({
      analysisPredictions: [{ label: "related", confidence: 0.8, score: 0.6 }],
    });
    const empty = await f.post({ analysisPredictions: [] });
    const old = await f.post({
      analysisModelKey: "retired",
      analysisPredictions: [{ label: "other", confidence: 0.9, score: 0.1 }],
    });
    const uncertain: string[] = [related.id, empty.id, old.id];
    for (const mutation of [
      "failed",
      "queued",
      "missing",
      "checksum",
      "inactive",
      "unknown",
      "no-label",
      "no-value",
      "not-object",
      "scalar-mismatch",
      "scalar-underflow",
      "scalar-overflow",
      "vector-overflow",
    ]) {
      const p = await f.post({
        analysisPredictions: [{ label: "other", confidence: 0.9, score: 0.2 }],
      });
      uncertain.push(p.id);
      const media = await f.db.candidateMedia.findFirstOrThrow({
        where: { candidatePostId: p.id },
        include: { analyses: true },
      });
      const a = media.analyses[0];
      if (mutation === "missing")
        await f.db.candidateMediaAnalysis.delete({ where: { id: a.id } });
      else if (mutation === "checksum")
        await f.db.candidateMediaAnalysis.update({
          where: { id: a.id },
          data: { sourceSha256: "b".repeat(64) },
        });
      else if (mutation === "inactive")
        await f.db.fileObject.update({
          where: { id: media.fileObjectId },
          data: { deletedAt: new Date() },
        });
      else if (mutation === "failed" || mutation === "queued")
        await f.db.candidateMediaAnalysis.update({
          where: { id: a.id },
          data: { status: mutation },
        });
      else if (mutation === "vector-overflow")
        await f.db
          .$executeRaw`UPDATE candidate_media_analyses SET result_json=jsonb_set(result_json,'{classScores}','[{"label":"positive","value":9e131071},{"label":"related","value":9e131071},{"label":"other","value":0}]'::jsonb) WHERE id=${a.id}::uuid`;
      else if (
        mutation === "scalar-underflow" ||
        mutation === "scalar-overflow"
      ) {
        const value = mutation === "scalar-underflow" ? "1e-4000" : "1e4000";
        await f.db
          .$executeRaw`UPDATE candidate_media_analyses SET result_json=jsonb_set(result_json,'{score}',${value}::jsonb) WHERE id=${a.id}::uuid`;
      } else {
        const result = structuredClone(a.resultJson) as {
          score: number;
          predictedClass: string;
          classScores: Record<string, unknown>[];
        };
        if (mutation === "unknown") result.predictedClass = "foreign";
        if (mutation === "no-label") delete result.classScores[0].label;
        if (mutation === "no-value") {
          delete result.classScores[0].value;
          result.classScores[1].value = 0.1;
        }
        if (mutation === "not-object") result.classScores[0] = null as never;
        if (mutation === "scalar-mismatch") result.score = 0.5;
        await f.db.candidateMediaAnalysis.update({
          where: { id: a.id },
          data: { resultJson: result as Prisma.InputJsonValue },
        });
      }
    }
    await f.db.candidateClassificationDecision.create({
      data: {
        candidatePostId: positive.id,
        label: "photo",
        decidedById: f.actor.id,
      },
    });
    await f.db.candidatePost.update({
      where: { id: positive.id },
      data: { tagDisposition: "blocked" },
    });
    const positiveCard = await f.service.get(positive.id);
    assert.equal(positiveCard.triageGroup, "priority");
    assert.equal(positiveCard.classificationTags?.[0]?.label, "other");
    assert.ok(positiveCard.triageReasons.includes("priority_model"));
    assert.equal((await f.service.get(low.id)).triageGroup, "low_priority");
    const page = await f.service.list(
      { ...f.filter, triageGroup: "uncertain", limit: 100 },
      f.actor.id,
    );
    assert.deepEqual(page.items.map((p) => p.id).sort(), uncertain.sort());
    const disabled = new (
      f.service
        .constructor as typeof import("../../src/candidates/candidates.service.js").CandidatesService
    )(f.db, {} as never);
    assert.equal((await disabled.get(low.id)).triageGroup, "uncertain");
    const session = await f.create();
    await f.db.candidateReviewSession.update({
      where: { id: session.sessionId },
      data: { policyVersion: 1 },
    });
    await assert.rejects(
      f.service.list(
        { ...f.filter, reviewSessionId: session.sessionId },
        f.actor.id,
      ),
      /格式.*刷新/,
    );
  } finally {
    await f.close();
  }
});

test("tag directions, conflict ordering, gray compatibility and zero scores keep independent evidence", async () => {
  const f = await candidateReviewFixture();
  const groups: string[] = [];
  try {
    const yes = await f.service.createTagGroup({
      name: `yes-${randomUUID()}`,
      kind: "valid",
      enabled: true,
      aliases: [`yes${randomUUID()}`],
    });
    groups.push(yes.id);
    const no = await f.service.createTagGroup({
      name: `no-${randomUUID()}`,
      kind: "blocked",
      enabled: true,
      aliases: [`no${randomUUID()}`],
    });
    groups.push(no.id);
    const gray = await f.db.candidateTagGroup.create({
      data: {
        name: `gray-${randomUUID()}`,
        kind: "gray",
        aliases: {
          create: {
            normalizedValue: `gray${randomUUID()}`,
            displayValue: "gray",
          },
        },
      },
      include: { aliases: true },
    });
    groups.push(gray.id);
    const tags = (tag: string) => ({
      create: [{ displayValue: tag, normalizedValue: tag.toLowerCase() }],
    });
    const conflict = await f.post({
      analysisPredictions: [{ label: "positive", confidence: 0.4, score: 0.1 }],
      hashtags: tags(no.aliases[0]),
    });
    const ordinary = await f.post({
      analysisPredictions: [{ label: "related", confidence: 0.8, score: 0.99 }],
    });
    const positiveTag = await f.post({
      analysisPredictions: [{ label: "other", confidence: 0.9, score: 0.2 }],
      hashtags: tags(yes.aliases[0]),
    });
    const negativeTag = await f.post({
      analysisPredictions: [],
      hashtags: tags(no.aliases[0]),
    });
    const grayOnly = await f.post({
      analysisPredictions: [],
      hashtags: tags(gray.aliases[0].normalizedValue),
    });
    assert.equal((await f.service.get(positiveTag.id)).triageGroup, "priority");
    assert.equal(
      (await f.service.get(positiveTag.id)).classificationTags?.[0]?.label,
      "other",
    );
    assert.equal(
      (await f.service.get(negativeTag.id)).triageGroup,
      "low_priority",
    );
    assert.equal((await f.service.get(grayOnly.id)).triageGroup, "uncertain");
    const uncertain = await f.service.list(
      { ...f.filter, triageGroup: "uncertain" },
      f.actor.id,
    );
    assert.equal(uncertain.items[0].id, conflict.id);
    assert.ok(uncertain.items.some((p) => p.id === ordinary.id));
    const zero = await f.post({
      analysisPredictions: [{ label: "positive", confidence: 0.8, score: 0 }],
      postedAt: new Date(0),
    });
    const absent = await f.post({
      analysisPredictions: [],
      hashtags: tags(yes.aliases[0]),
    });
    const priority = await f.service.list(
      { ...f.filter, triageGroup: "priority" },
      f.actor.id,
    );
    assert.ok(
      priority.items.findIndex((p) => p.id === zero.id) <
        priority.items.findIndex((p) => p.id === absent.id),
    );
    await assert.rejects(
      f.service.createTagGroup({
        name: "unsupported gray",
        kind: "gray",
        aliases: ["uniquegray"],
        enabled: true,
      }),
      /灰名单/,
    );
    await assert.rejects(
      f.service.updateTagGroup(yes.id, {
        ...yes,
        kind: "gray",
        expectedRevision: yes.revision,
      }),
      /灰名单/,
    );
    await f.service.updateTagGroup(gray.id, {
      name: gray.name,
      kind: "gray",
      enabled: false,
      aliases: [gray.aliases[0].normalizedValue],
      expectedRevision: gray.revision,
    });
  } finally {
    await f.db.candidateTagGroup.deleteMany({ where: { id: { in: groups } } });
    await f.close();
  }
});

test("editing rules after their atomic read cannot mix the new explanations into the old session", async () => {
  const f = await candidateReviewFixture();
  let groupId = "";
  try {
    const group = await f.service.createTagGroup({
      name: `snapshot-${randomUUID()}`,
      kind: "valid",
      enabled: true,
      aliases: [`snapshot${randomUUID()}`],
    });
    groupId = group.id;
    const post = await f.post({
      analysisPredictions: [],
      hashtags: {
        create: {
          normalizedValue: group.aliases[0].toLowerCase(),
          displayValue: group.aliases[0],
        },
      },
    });
    let intercepted = false;
    const db = new Proxy(f.db, {
      get(target, key) {
        if (key !== "$transaction") return Reflect.get(target, key);
        return (
          callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
          options: never,
        ) =>
          target.$transaction(
            (tx) =>
              callback(
                new Proxy(tx, {
                  get(transaction, method) {
                    if (method !== "$queryRaw")
                      return Reflect.get(transaction, method);
                    return async (...args: unknown[]) => {
                      const result = await Reflect.apply(
                        transaction.$queryRaw,
                        transaction,
                        args,
                      );
                      if (
                        !intercepted &&
                        Array.isArray(args[0]) &&
                        args[0].join("?").includes("SELECT a.normalized_value")
                      ) {
                        intercepted = true;
                        await f.service.updateTagGroup(group.id, {
                          ...group,
                          name: `changed-${randomUUID()}`,
                          enabled: false,
                          expectedRevision: group.revision,
                        });
                      }
                      return result;
                    };
                  },
                }),
              ),
            options,
          );
      },
    });
    const service = new CandidatesService(
      db,
      {} as never,
      undefined,
      f.analysis,
    );
    const session = await service.createReviewSession(f.actor.id, {
      ...f.filter,
      idempotencyKey: randomUUID(),
    });
    assert.equal(intercepted, true);
    assert.equal(session.counts.priority, 1);
    const card = (
      await f.service.list(
        { ...f.filter, reviewSessionId: session.sessionId },
        f.actor.id,
      )
    ).items[0];
    assert.equal(card.id, post.id);
    assert.equal(card.tagRuleMatches[0].groupName, group.name);
    assert.equal((await f.create()).counts.uncertain, 1);
  } finally {
    if (groupId)
      await f.db.candidateTagGroup.delete({ where: { id: groupId } });
    await f.close();
  }
});
