import { afterEach, expect, test, vi } from "vitest";
import { client } from "../account/api";
import {
  ManualUploadCheckpoints,
  type ManualCandidateDraft,
} from "./manual-upload-checkpoints";
import type { components } from "@comiku/api-client";
const ok = (data: unknown) => ({ data, response: new Response() }) as never;
const candidate = {
  id: "a",
  authorId: "author",
  revision: 1,
  text: "old",
  externalPostUrl: null,
  media: [{ id: "1" }, { id: "2" }],
} as components["schemas"]["CandidateDto"];
const draft: ManualCandidateDraft = {
  authorId: "author",
  text: "new",
  sourceUrl: "",
  media: [...candidate.media].reverse(),
};
afterEach(() => vi.restoreAllMocks());
test("order success then metadata failure retries only metadata at the returned revision", async () => {
  const checkpoints = new ManualUploadCheckpoints();
  const post = vi
    .spyOn(client, "POST")
    .mockResolvedValue(ok({ ...candidate, revision: 2, media: draft.media }));
  const patch = vi
    .spyOn(client, "PATCH")
    .mockRejectedValueOnce(Error("503"))
    .mockResolvedValue(
      ok({ ...candidate, revision: 3, text: "new", media: draft.media }),
    );
  await expect(
    checkpoints.confirm([candidate], { a: draft }, "candidate"),
  ).rejects.toThrow("503");
  await checkpoints.confirm([candidate], { a: draft }, "candidate");
  expect(post).toHaveBeenCalledOnce();
  expect(patch).toHaveBeenCalledTimes(2);
  expect(patch.mock.calls[1][1]).toMatchObject({
    body: { expectedRevision: 2 },
  });
});
test("completed metadata and successful import siblings are not replayed after a partial import", async () => {
  const checkpoints = new ManualUploadCheckpoints();
  const b = { ...candidate, id: "b" };
  const patch = vi
    .spyOn(client, "PATCH")
    .mockImplementation(async (_path, options) =>
      ok({
        ...candidate,
        id: (options as { params: { path: { id: string } } }).params.path.id,
        revision: 2,
        text: "new",
      }),
    );
  const post = vi
    .spyOn(client, "POST")
    .mockResolvedValueOnce(
      ok({
        results: [
          { id: "a", outcome: "succeeded" },
          { id: "b", outcome: "failed" },
        ],
      }),
    )
    .mockResolvedValue(ok({ results: [{ id: "b", outcome: "succeeded" }] }));
  const unchangedOrder = { ...draft, media: candidate.media };
  await expect(
    checkpoints.confirm(
      [candidate, b],
      { a: unchangedOrder, b: unchangedOrder },
      "direct",
    ),
  ).rejects.toThrow(/1/);
  expect(
    checkpoints.canConfirm([candidate, b], {
      a: { ...unchangedOrder, authorId: "" },
      b: unchangedOrder,
    }),
  ).toBe(true);
  await checkpoints.confirm(
    [candidate, b],
    { a: { ...unchangedOrder, authorId: "" }, b: unchangedOrder },
    "direct",
  );
  expect(patch).toHaveBeenCalledTimes(2);
  expect(post.mock.calls[1][1]).toMatchObject({
    body: { items: [{ id: "b", expectedRevision: 2 }] },
  });
});

test("earlier groups keep successful metadata checkpoints when a later group fails", async () => {
  const checkpoints = new ManualUploadCheckpoints();
  const b = { ...candidate, id: "b" };
  const patch = vi
    .spyOn(client, "PATCH")
    .mockResolvedValueOnce(ok({ ...candidate, text: "new", revision: 2 }))
    .mockRejectedValueOnce(Error("later group failed"))
    .mockResolvedValue(ok({ ...b, text: "new", revision: 2 }));
  const unchangedOrder = { ...draft, media: candidate.media };
  await expect(
    checkpoints.confirm(
      [candidate, b],
      { a: unchangedOrder, b: unchangedOrder },
      "candidate",
    ),
  ).rejects.toThrow(/later group/);
  await checkpoints.confirm(
    [candidate, b],
    { a: unchangedOrder, b: unchangedOrder },
    "candidate",
  );
  expect(patch).toHaveBeenCalledTimes(3);
  expect(patch.mock.calls[2][1]).toMatchObject({
    params: { path: { id: "b" } },
    body: { expectedRevision: 1 },
  });
});
