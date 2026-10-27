import assert from "node:assert/strict";
import test from "node:test";
import { jobEvent } from "../src/jobs/job-events.js";

test("job events expose attempts and retries without serializing payloads or upstream errors", () => {
  const row = {
    id: "fixture-job",
    resourceId: "fixture-run",
    kind: "source_fetch",
    lane: "network",
    attempts: 2,
    payload: { cookie: "private-fixture-cookie" },
    lastError: "upstream-secret",
    leaseId: "private-lease",
  };
  const event = jobEvent(
    "retry_scheduled",
    row,
    new Date("2026-10-26T10:00:00Z"),
  );
  assert.equal(event.attempt, 2);
  assert.equal(event.resourceId, "fixture-run");
  assert.equal(event.retryAt, "2026-10-26T10:00:00.000Z");
  assert.doesNotMatch(
    JSON.stringify(event),
    /cookie|secret|private-lease|payload/,
  );
});
