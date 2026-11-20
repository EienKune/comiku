import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { TranslationsService } from "../src/translations/translations.service.js";
import {
  ReviewStatus,
  WorkflowStatus,
} from "../src/generated/prisma/client.js";

function fixture(options: { participating?: boolean; missing?: boolean } = {}) {
  const head: {
    revision: number;
    editorEpoch: number;
    workflowStatus: WorkflowStatus;
    reviewStatus: ReviewStatus;
    sourceLanguage: string;
  } = {
    revision: 12,
    editorEpoch: 4,
    workflowStatus: WorkflowStatus.translating,
    reviewStatus: ReviewStatus.normal,
    sourceLanguage: "ja",
  };
  const reads: unknown[] = [];
  const writtenModes: string[] = [];
  const deletions: unknown[] = [];
  const db = {
    work: {
      findUnique: async (query: unknown) => {
        reads.push(query);
        return options.missing ? null : head;
      },
    },
    user: {
      findUnique: async () => ({
        roles: [{ role: "translator" }],
        languageCapabilities: [{ language: "ja" }],
      }),
    },
    workStageParticipant: {
      findMany: async () =>
        options.participating ? [{ stage: "translate" }] : [],
    },
    translationEditorPresence: {
      deleteMany: async (query: unknown) => {
        deletions.push(query);
        return { count: 1 };
      },
      upsert: async ({ create }: { create: { mode: string } }) => {
        writtenModes.push(create.mode);
      },
      findMany: async () => [],
    },
    $transaction: async (operations: Promise<unknown>[]) =>
      Promise.all(operations),
  };
  const service = new TranslationsService(db as never, {} as never);
  const responseHead = () => ({
    workRevision: head.revision,
    editorEpoch: head.editorEpoch,
    workflowStatus: head.workflowStatus,
    reviewStatus: head.reviewStatus,
  });
  return { service, head, reads, writtenModes, deletions, responseHead };
}

test("view heartbeat returns only presence and the current lightweight work head", async () => {
  const f = fixture();
  f.head.editorEpoch = 0;
  assert.deepEqual(
    await f.service.updatePresence("actor", "session", "work", {
      mode: "view",
    }),
    { items: [], expiresInSeconds: 90, ...f.responseHead() },
  );
  assert.equal(f.reads.length, 1);
  assert.deepEqual(f.reads[0], {
    where: { id: "work" },
    select: {
      revision: true,
      editorEpoch: true,
      workflowStatus: true,
      reviewStatus: true,
      sourceLanguage: true,
    },
  });
  assert.deepEqual(f.writtenModes, ["view"]);
});

test("edit heartbeat reuses the work projection for participation authorization", async () => {
  const f = fixture({ participating: true });
  assert.deepEqual(
    await f.service.updatePresence("actor", "session", "work", {
      mode: "edit",
    }),
    { items: [], expiresInSeconds: 90, ...f.responseHead() },
  );
  assert.equal(f.reads.length, 1);
  assert.deepEqual(f.writtenModes, ["edit"]);
});

test("a stale edit heartbeat remains forbidden and view retry observes withdrawal", async () => {
  const f = fixture();
  f.head.revision = 15;
  f.head.editorEpoch = 5;
  f.head.workflowStatus = WorkflowStatus.pending_translate;
  await assert.rejects(
    f.service.updatePresence("actor", "session", "work", { mode: "edit" }),
    ForbiddenException,
  );
  assert.deepEqual(f.writtenModes, []);
  assert.deepEqual(
    await f.service.updatePresence("actor", "session", "work", {
      mode: "view",
    }),
    { items: [], expiresInSeconds: 90, ...f.responseHead() },
  );
  assert.deepEqual(f.writtenModes, ["view"]);
});

test("leave returns the current work head and deletes only the actor session", async () => {
  const f = fixture();
  f.head.reviewStatus = ReviewStatus.needs_review;
  assert.deepEqual(await f.service.leavePresence("actor", "session", "work"), {
    items: [],
    expiresInSeconds: 90,
    ...f.responseHead(),
  });
  assert.deepEqual(f.deletions, [
    { where: { workId: "work", sessionId: "session", userId: "actor" } },
  ]);
  assert.equal(f.reads.length, 1);
});

test("archival and review blocking keep edit presence forbidden while allowing view", async () => {
  for (const changed of [
    { workflowStatus: WorkflowStatus.archived },
    { reviewStatus: ReviewStatus.blocked },
  ]) {
    const f = fixture({ participating: true });
    Object.assign(f.head, changed);
    await assert.rejects(
      f.service.updatePresence("actor", "session", "work", { mode: "edit" }),
      ForbiddenException,
    );
    assert.deepEqual(f.writtenModes, []);
    assert.deepEqual(
      await f.service.updatePresence("actor", "session", "work", {
        mode: "view",
      }),
      { items: [], expiresInSeconds: 90, ...f.responseHead() },
    );
  }
});

test("presence cannot read or write a missing work", async () => {
  const f = fixture({ missing: true });
  await assert.rejects(
    f.service.updatePresence("actor", "session", "missing", { mode: "view" }),
    NotFoundException,
  );
  await assert.rejects(
    f.service.leavePresence("actor", "session", "missing"),
    NotFoundException,
  );
  assert.deepEqual(f.writtenModes, []);
  assert.deepEqual(f.deletions, []);
});
