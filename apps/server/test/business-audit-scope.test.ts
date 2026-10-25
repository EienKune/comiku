import assert from "node:assert/strict";
import { test } from "node:test";
import { businessEventScope } from "../src/audit/business-audit.scope.js";

test("administrators and reviewers receive the global business event scope", () => {
  assert.deepEqual(businessEventScope("actor", ["admin"]), {});
  assert.deepEqual(businessEventScope("actor", ["reviewer"]), {});
});

test("ordinary roles only receive events they performed or related works", () => {
  assert.deepEqual(businessEventScope("actor", ["translator"]), {
    OR: [
      { actorId: "actor" },
      { work: { importedById: "actor" } },
      { work: { stageParticipants: { some: { userId: "actor" } } } },
    ],
  });
});
