import assert from "node:assert/strict";
import { test } from "node:test";
import { planTypesetPageMappings } from "../src/typesetting/typeset-batch-mapping.js";

const pages = [
  { id: "p1", participantId: "mine" },
  { id: "p2", participantId: "other" },
  { id: "p3", participantId: "mine" },
];
const images = [
  { id: "i1", sourceName: "a.png" },
  { id: "i2", sourceName: "b.png" },
];
test("batch page mapping freezes explicit displayed order and ignores other owners", () => {
  assert.deepEqual(
    planTypesetPageMappings(
      images,
      [
        { imageId: "i1", workImageId: "p3" },
        { imageId: "i2", workImageId: "p2" },
      ],
      pages,
      "mine",
    ),
    {
      mappings: [{ imageId: "i1", workImageId: "p3", position: "page" }],
      ignored: ["b.png"],
    },
  );
});
test("batch mapping rejects missing, duplicate, foreign and ownerless mappings", () => {
  for (const mappings of [
    undefined,
    [],
    [{ imageId: "i1", workImageId: "p1" }],
    [
      { imageId: "i1", workImageId: "p1" },
      { imageId: "i2", workImageId: "p1" },
    ],
    [
      { imageId: "i1", workImageId: "p1" },
      { imageId: "foreign", workImageId: "p3" },
    ],
    [
      { imageId: "i1", workImageId: "p1" },
      { imageId: "i2", workImageId: "foreign" },
    ],
  ])
    assert.throws(() =>
      planTypesetPageMappings(images, mappings, pages, "mine"),
    );
  assert.throws(() =>
    planTypesetPageMappings(
      images,
      [
        { imageId: "i1", workImageId: "p1" },
        { imageId: "i2", workImageId: "p3" },
      ],
      pages,
      undefined,
    ),
  );
});
