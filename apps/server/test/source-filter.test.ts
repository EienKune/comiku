import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { CandidateQueryDto } from "../src/candidates/candidates.dto.js";
import { WorkQueryDto } from "../src/works/works.dto.js";
import {
  candidateBaseWhere,
  candidateFilterHash,
  normalizeCandidateFilter,
} from "../src/candidates/candidate-query.js";

const accountId = randomUUID();
test("source defaults preserve the legacy candidate hash and strict false semantics", () => {
  const legacy = {
    status: "pending",
    authorId: null,
    search: null,
    sourceLanguage: null,
    fetchedAfter: null,
    fetchedBefore: null,
  };
  const hash = createHash("sha256")
    .update(JSON.stringify(legacy))
    .digest("hex");
  assert.equal(candidateFilterHash(normalizeCandidateFilter({})), hash);
  assert.equal(
    candidateFilterHash(
      normalizeCandidateFilter({ sourceUnbound: false } as never),
    ),
    hash,
  );
  for (const Dto of [CandidateQueryDto, WorkQueryDto]) {
    const value = plainToInstance(Dto, {
      sourceUnbound: "false",
    }) as CandidateQueryDto & { sourceUnbound?: boolean };
    assert.equal(value.sourceUnbound, false);
    assert.equal(
      validateSync(plainToInstance(Dto, { sourceUnbound: "yes" })).length,
      1,
    );
  }
});
test("source filter canonicalizes identities and rejects redundant or impossible scopes", () => {
  assert.equal(
    (
      normalizeCandidateFilter({
        sourceAccountId: accountId.toUpperCase(),
      } as never) as Record<string, unknown>
    ).sourceAccountId,
    accountId,
  );
  for (const source of [
    { sourceAccountId: accountId, sourcePlatform: "x" },
    { sourceAccountId: accountId, sourceUnbound: true },
    { sourcePlatform: "manual", sourceUnbound: true },
    { sourceUnbound: "false" },
    { sourcePlatform: "unknown" },
  ])
    assert.throws(() => normalizeCandidateFilter(source as never));
  assert.notEqual(
    candidateFilterHash(normalizeCandidateFilter({})),
    candidateFilterHash(
      normalizeCandidateFilter({ sourcePlatform: "x" } as never),
    ),
  );
});
test("candidate SQL constrains historical actual account or unbound nonmanual sources", () => {
  const account = candidateBaseWhere(
    normalizeCandidateFilter({ sourceAccountId: accountId } as never),
  );
  assert.match(account.text, /c\.author_external_account_id/);
  assert.ok(account.values.includes(accountId));
  const unbound = candidateBaseWhere(
    normalizeCandidateFilter({
      sourceUnbound: true,
      sourcePlatform: "pixiv",
    } as never),
  );
  assert.match(unbound.text, /author_external_account_id IS NULL/);
  assert.match(unbound.text, /platform <> 'manual'/);
  assert.ok(unbound.values.includes("pixiv"));
});
import { WorksService } from "../src/works/works.service.js";
import { WorkView } from "../src/works/works.dto.js";
import {
  assertSourceFilterAccount,
  normalizeSourceFilter,
} from "../src/source-identity/source-filter.js";

test("specific-account filtering validates author ownership while keeping retired identities", async () => {
  const authorId = randomUUID();
  const db = {
    authorExternalAccount: {
      findUnique: async () => ({ authorId, deletedAt: new Date() }),
    },
  };
  const filter = normalizeSourceFilter({ sourceAccountId: accountId });
  await assertSourceFilterAccount(db as never, filter, authorId);
  await assertSourceFilterAccount(db as never, filter);
  await assert.rejects(
    assertSourceFilterAccount(db as never, filter, randomUUID()),
    /作者/,
  );
});

test("all Work scopes and album queries constrain a single direct source row", async () => {
  for (const view of [
    undefined,
    WorkView.todo,
    WorkView.recommended,
    WorkView.publish,
  ]) {
    const wheres: unknown[] = [];
    const db = {
      user: {
        findUnique: async () => ({
          isActive: true,
          roles: [{ role: "admin" }],
          languageCapabilities: [],
        }),
      },
      work: {
        count: async ({ where }: { where: unknown }) => {
          wheres.push(where);
          return 0;
        },
        findMany: async ({ where }: { where: unknown }) => {
          wheres.push(where);
          return [];
        },
      },
      workImage: {
        count: async ({ where }: { where: unknown }) => {
          wheres.push(where);
          return 0;
        },
        findMany: async ({ where }: { where: unknown }) => {
          wheres.push(where);
          return [];
        },
      },
    };
    const service = new WorksService(db as never, {} as never, {} as never);
    const query = {
      sourcePlatform: "x",
      sourceUnbound: true,
      limit: 24,
      mine: false,
      view,
    } as WorkQueryDto;
    await service.list("actor", query);
    if (!view) await service.album("actor", { ...query, limit: 60 });
    assert.ok(wheres.length > 2);
    for (const where of wheres) {
      const json = JSON.stringify(where);
      assert.match(json, /"sources":\{"some":\{"candidatePost":\{/);
      assert.match(
        json,
        /"platform":"x","authorExternalAccountId":null,"NOT":\{"platform":"manual"\}/,
      );
    }
  }
});

test("album default cursors retain old hashes while changed source scopes invalidate them", async () => {
  const authorId = randomUUID(),
    actorId = randomUUID();
  const legacy = {
    actorId,
    search: "",
    sourceLanguage: null,
    phase: null,
    workflowStatus: null,
    reviewStatus: null,
    authorId,
    mine: false,
    unassignedStage: null,
  };
  const hash = createHash("sha256")
    .update(JSON.stringify(legacy))
    .digest("hex");
  const cursor = Buffer.from(
    JSON.stringify({
      v: 1,
      f: hash,
      t: "2026-01-01T00:00:00Z",
      w: randomUUID(),
      i: randomUUID(),
      o: 0,
    }),
  ).toString("base64url");
  const db = {
    user: {
      findUnique: async () => ({
        isActive: true,
        roles: [{ role: "admin" }],
        languageCapabilities: [],
      }),
    },
    work: { count: async () => 0 },
    workImage: { count: async () => 0, findMany: async () => [] },
  };
  const service = new WorksService(db as never, {} as never, {} as never);
  const query = { authorId, cursor, mine: false, limit: 60 };
  await service.album(actorId, query);
  await assert.rejects(
    service.album(actorId, { ...query, sourcePlatform: "x" } as never),
    /游标/,
  );
});
