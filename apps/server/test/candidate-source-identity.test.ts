import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { CandidatesService } from "../src/candidates/candidates.service.js";
import { WorksService } from "../src/works/works.service.js";

const safeAccount = {
  id: randomUUID(),
  platform: "pixiv",
  externalUserId: "12345",
  handle: null,
  displayNameSnapshot: "Synthetic side account",
  profileUrl: "https://example.test/profile",
  avatarFileObjectId: null,
  fetchEnabled: false,
  deletedAt: new Date("2026-01-01"),
  notes: "private-canary",
  rawJson: { secret: "private-canary" },
};
function candidate(account: object | null) {
  return {
    id: randomUUID(),
    authorId: randomUUID(),
    authorExternalAccountId: account ? safeAccount.id : null,
    author: {
      displayName: "Synthetic",
      sourceLanguage: "ja",
      avatarFileObjectId: null,
      externalAccounts: [
        { platform: "x", handle: "unrelated", avatarFileObjectId: null },
        { platform: "pixiv", handle: null, avatarFileObjectId: "avatar" },
      ],
    },
    authorExternalAccount: account,
    platform: "pixiv",
    sourceObservations: [],
    hashtags: [],
    status: "pending",
    media: [],
    workSources: [],
    postedAt: new Date(0),
    fetchedAt: new Date(0),
  };
}
test("candidate identity comes only from its actual account while independent author avatar remains available", async () => {
  const row = candidate(null);
  const db = {
    $queryRaw: async () => [],
    candidatePost: { findUnique: async () => row },
  };
  const service = new CandidatesService(db as never, {} as never);
  const unbound = await service.get(row.id);
  assert.equal(unbound.authorHandle, null);
  assert.equal(unbound.authorAvatarAvailable, true);
  assert.equal(
    (unbound as unknown as Record<string, unknown>).authorExternalAccountId,
    null,
  );
  assert.equal(
    (unbound as unknown as Record<string, unknown>).sourceAccount,
    null,
  );
  Object.assign(row, {
    authorExternalAccount: safeAccount,
    authorExternalAccountId: safeAccount.id,
  });
  const bound = await service.get(row.id);
  assert.equal(
    (bound as unknown as Record<string, unknown>).authorExternalAccountId,
    safeAccount.id,
  );
  const summary = (
    bound as unknown as { sourceAccount: { id: string; deletedAt: string } }
  ).sourceAccount;
  assert.equal(summary.id, safeAccount.id);
  assert.equal(summary.deletedAt, safeAccount.deletedAt.toISOString());
  assert.doesNotMatch(JSON.stringify(bound), /private-canary|rawJson|notes/);
});
test("work direct source DTO includes the actual retired account via the safe allowlist", async () => {
  const row = candidate(safeAccount);
  const db = {
    work: {
      findUnique: async () => ({
        sourceCandidatePostId: row.id,
        sources: [{ candidatePost: row, mappingKnown: true, sourceText: null }],
      }),
    },
  };
  const result = await new WorksService(
    db as never,
    {} as never,
    {} as never,
  ).source("work");
  assert.equal(
    (result.sources[0] as unknown as { sourceAccount: { id: string } })
      .sourceAccount?.id,
    safeAccount.id,
  );
  assert.doesNotMatch(JSON.stringify(result), /private-canary|rawJson|notes/);
});
