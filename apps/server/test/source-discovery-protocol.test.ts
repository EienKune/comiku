/* Synthetic malformed protocol envelopes deliberately violate the type contract. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert/strict";
import test from "node:test";
import { discoveryFailures } from "../src/source-ingestion/adapters/gallery-dl/gallery-dl-content-source.js";
const envelope = () => ({
  failed_ids: ["2"],
  records: [[2, { id: "1" }]],
  enumeration_proof: {
    kind: "author_catalog",
    source_id: "42",
    complete: true,
    ids: ["1", "2"],
    resolved_ids: ["1"],
  },
  discovery_failures: [
    {
      external_post_id: "2",
      failure_code: "metadata_unavailable",
      evidence: { kind: "author_catalog", source_id: "42" },
    },
  ],
});
test("complete proof accepts exactly known metadata failure without fabricated metadata", () => {
  assert.deepEqual(discoveryFailures(envelope(), "42", "pixiv"), [
    {
      externalPostId: "2",
      failureCode: "metadata_unavailable",
      evidence: { kind: "author_catalog", sourceId: "42" },
    },
  ]);
});
test("incomplete proof, wrong owner, unknown ID and non-partitioned failures fail closed", () => {
  for (const change of [
    (p: any) => delete p.enumeration_proof,
    (p: any) => (p.enumeration_proof.complete = false),
    (p: any) => (p.enumeration_proof.source_id = "99"),
    (p: any) => p.failed_ids.push("3"),
    (p: any) => p.enumeration_proof.resolved_ids.push("2"),
    (p: any) => p.enumeration_proof.ids.push("4"),
    (p: any) => p.records.push([2, { id: "8" }]),
    (p: any) => (p.discovery_failures[0].failure_code = "authentication"),
  ]) {
    const p = envelope();
    change(p);
    assert.throws(() => discoveryFailures(p, "42", "pixiv"));
  }
});
