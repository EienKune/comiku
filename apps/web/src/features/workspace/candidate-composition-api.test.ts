import { expect, test } from "vitest";
import { validateCompositionReceipt } from "./candidate-composition-api";
import type { CompositionIntent } from "./candidate-composition-model";
const intent: CompositionIntent = {
  idempotencyKey: "key",
  mode: "split",
  candidates: [{ id: "source", expectedRevision: 2 }],
  works: [
    { title: "第一作", mediaIds: ["one"] },
    { title: "第二作", mediaIds: ["two"] },
  ],
};
const originals = new Map([["source", ["one", "two", "unused"]]]);
const receipt = () => ({
  idempotencyKey: "key",
  mode: "split",
  works: [
    {
      workId: "w1",
      workNumber: 1,
      title: "第一作",
      imageCount: 1,
      sourceCandidateIds: ["source"],
    },
    {
      workId: "w2",
      workNumber: 2,
      title: "第二作",
      imageCount: 1,
      sourceCandidateIds: ["source"],
    },
  ],
  candidates: [
    { id: "source", revision: 3, status: "imported", workIds: ["w1", "w2"] },
  ],
  unadoptedMediaIds: ["unused"],
});
test("a complete receipt describes every created work and every submitted source", () => {
  expect(
    validateCompositionReceipt(receipt(), intent, originals).works.map(
      (work) => work.workId,
    ),
  ).toEqual(["w1", "w2"]);
});
test.each([
  "work",
  "candidate",
  "unadopted",
  "link",
  "revision",
  "key",
  "source",
])(
  "rejects a malformed/incomplete %s receipt without declaring success",
  (fault) => {
    const data = receipt();
    if (fault === "work") data.works.pop();
    if (fault === "candidate") data.candidates = [];
    if (fault === "unadopted") data.unadoptedMediaIds = [];
    if (fault === "link") data.candidates[0].workIds = ["w1"];
    if (fault === "revision") data.candidates[0].revision = 2;
    if (fault === "key") data.idempotencyKey = "another";
    if (fault === "source") data.works[0].sourceCandidateIds = [];
    expect(() => validateCompositionReceipt(data, intent, originals)).toThrow(
      /回执/,
    );
  },
);
