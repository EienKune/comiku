import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeCandidateCursor,
  encodeCandidateCursor,
  normalizeCandidateFilter,
} from "../src/candidates/candidate-query.js";

test("review cursor binds session, filter, model, group and version", () => {
  const binding = {
    sessionId: "a",
    filterHash: "filter",
    modelKey: "model",
    group: "photo",
  };
  const encoded = encodeCandidateCursor({ ...binding, ordinal: 24 });
  assert.equal(decodeCandidateCursor(encoded, binding).ordinal, 24);
  for (const field of ["sessionId", "filterHash", "modelKey", "group"] as const)
    assert.throws(() =>
      decodeCandidateCursor(encoded, { ...binding, [field]: "other" }),
    );
  assert.throws(
    () =>
      decodeCandidateCursor("00000000-0000-4000-8000-000000000000", binding),
    /版本|游标/,
  );
  assert.throws(() =>
    decodeCandidateCursor(
      Buffer.from(JSON.stringify({ ...binding, v: 1, ordinal: -1 })).toString(
        "base64url",
      ),
      binding,
    ),
  );
});

test("base filter normalizes search and dates and excludes paging/group", () => {
  assert.deepEqual(
    normalizeCandidateFilter({
      limit: 24,
      search: " @Alice ",
      triageGroup: "photo",
    }),
    normalizeCandidateFilter({
      limit: 100,
      search: "Alice",
      triageGroup: "valid_manga",
    }),
  );
  assert.notDeepEqual(
    normalizeCandidateFilter({ limit: 24 }),
    normalizeCandidateFilter({ limit: 24, status: "discarded" }),
  );
});

test("signed ordinal cursors reject body tampering and another session secret", () => {
  const binding = {
    sessionId: "owned",
    filterHash: "filter",
    modelKey: "model",
    group: null,
  };
  const token = encodeCandidateCursor(
    { ...binding, ordinal: 24 },
    "private-secret",
  );
  assert.equal(
    decodeCandidateCursor(token, binding, "private-secret").ordinal,
    24,
  );
  assert.throws(() => decodeCandidateCursor(token, binding, "other-secret"));
  const [body, signature] = token.split(".");
  const value = JSON.parse(Buffer.from(body, "base64url").toString());
  value.ordinal = 25;
  assert.throws(() =>
    decodeCandidateCursor(
      `${Buffer.from(JSON.stringify(value)).toString("base64url")}.${signature}`,
      binding,
      "private-secret",
    ),
  );
});

test("live cursor rejects noncanonical UUID layout before reaching SQL", () => {
  const binding = {
    sessionId: null,
    filterHash: "filter",
    modelKey: null,
    group: null,
  };
  const value = {
    ...binding,
    rank: 0,
    score: -1,
    postedAt: "2026-10-29T00:00:00Z",
  };
  for (const id of [
    "a".repeat(36),
    "-".repeat(36),
    "000000000-000-4000-8000-000000000000",
  ])
    assert.throws(
      () =>
        decodeCandidateCursor(encodeCandidateCursor({ ...value, id }), binding),
      (error: unknown) =>
        !!error &&
        typeof error === "object" &&
        "getStatus" in error &&
        (error as { getStatus(): number }).getStatus() === 400,
    );
  const id = "ABCDEF12-3456-7890-ABCD-EF1234567890";
  assert.equal(
    decodeCandidateCursor(encodeCandidateCursor({ ...value, id }), binding).id,
    id,
  );
});
