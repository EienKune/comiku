import assert from "node:assert/strict";
import test from "node:test";
import { pageSubmissionCurrent } from "../src/works/page-ownership.js";

test("valid page submission binds both current ownership generation and exact content revision", () => {
  const page = {
    participantId: "owner",
    generation: 4,
    draftRevision: 12,
    submittedAt: new Date(),
    submittedGeneration: 4,
    submittedRevision: 12,
  };
  assert.equal(pageSubmissionCurrent(page), true);
  assert.equal(pageSubmissionCurrent({ ...page, generation: 5 }), false);
  assert.equal(pageSubmissionCurrent({ ...page, draftRevision: 13 }), false);
  assert.equal(pageSubmissionCurrent({ ...page, participantId: null }), false);
  assert.equal(pageSubmissionCurrent({ ...page, submittedAt: null }), false);
});
