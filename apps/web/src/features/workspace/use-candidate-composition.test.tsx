import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  compositionApi,
  CompositionRequestError,
} from "./candidate-composition-api";
import { useCandidateComposition } from "./use-candidate-composition";
import {
  emptyCandidateImportState,
  selectCandidateForImport,
  type ImportCandidate,
} from "./candidate-import-state";
const state = (tokenSuffix = "") =>
  ["a", "b"].reduce(
    (current, id) =>
      selectCandidateForImport(
        current,
        {
          id,
          revision: 2,
          authorId: "author",
          authorName: id,
          postedAt: "2026-01-01",
          status: "pending",
          media: [{ id: `${id}-1` }],
        } as ImportCandidate,
        id + tokenSuffix,
      ),
    emptyCandidateImportState(),
  );
const receipt = (key: string) => ({
  idempotencyKey: key,
  mode: "merge",
  works: [
    {
      workId: "work",
      workNumber: 1,
      title: null,
      imageCount: 2,
      sourceCandidateIds: ["a", "b"],
    },
  ],
  candidates: ["a", "b"].map((id) => ({
    id,
    revision: 3,
    status: "imported",
    workIds: ["work"],
  })),
  unadoptedMediaIds: [],
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
test("a lost response freezes key/payload and 404 lookup retains the intent across closing and retry", async () => {
  const submit = vi
    .spyOn(compositionApi, "submit")
    .mockRejectedValueOnce(new TypeError("lost"));
  vi.spyOn(compositionApi, "lookup").mockRejectedValue(
    new CompositionRequestError(404, "未找到"),
  );
  const settle = vi.fn(),
    complete = vi.fn(async () => {});
  const { result } = renderHook(() =>
    useCandidateComposition(settle, complete),
  );
  act(() => result.current.open("merge", state()));
  act(() => result.current.review());
  await act(() => result.current.submit());
  expect(result.current.locked).toBe(true);
  const frozen = structuredClone(submit.mock.calls[0][0]);
  act(() => result.current.close());
  expect(result.current.visible).toBe(false);
  act(() => result.current.reopen());
  await act(() => result.current.lookup());
  expect(result.current.phase).toBe("uncertain");
  expect(result.current.intent).toEqual(frozen);
  submit.mockImplementation(async (intent) => receipt(intent.idempotencyKey));
  await act(() => result.current.submit());
  expect(submit.mock.calls[1][0]).toEqual(frozen);
  expect(result.current.result?.works).toHaveLength(1);
  expect(settle).toHaveBeenCalledTimes(1);
  expect(complete).toHaveBeenCalledTimes(1);
});
test("incomplete successful response and later permission rejection remain uncertain", async () => {
  const submit = vi
    .spyOn(compositionApi, "submit")
    .mockResolvedValue({ works: [] });
  const settle = vi.fn();
  const { result } = renderHook(() =>
    useCandidateComposition(settle, async () => {}),
  );
  act(() => result.current.open("merge", state()));
  act(() => result.current.review());
  await act(() => result.current.submit());
  expect(result.current.phase).toBe("uncertain");
  submit.mockRejectedValue(new CompositionRequestError(403, "无权限"));
  await act(() => result.current.submit());
  expect(result.current.locked).toBe(true);
  expect(settle).not.toHaveBeenCalled();
});
test("a first authoritative revision rejection preserves the editable composition and ordinary state", async () => {
  vi.spyOn(compositionApi, "submit").mockRejectedValue(
    new CompositionRequestError(409, "帖子版本已变化"),
  );
  const { result } = renderHook(() =>
    useCandidateComposition(vi.fn(), async () => {}),
  );
  act(() => result.current.open("merge", state()));
  act(() => result.current.review());
  await act(() => result.current.submit());
  expect(result.current.locked).toBe(false);
  expect(result.current.phase).toBe("review");
  act(() => result.current.edit());
  expect(result.current.phase).toBe("editing");
  expect(result.current.draft?.groups[0].mediaIds).toEqual(["a-1", "b-1"]);
});
test("submitting is synchronously guarded and a successful lookup settles the original request once", async () => {
  let resolve!: (value: unknown) => void;
  const submit = vi.spyOn(compositionApi, "submit").mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const settle = vi.fn();
  const { result } = renderHook(() =>
    useCandidateComposition(settle, async () => {}),
  );
  act(() => result.current.open("merge", state()));
  act(() => result.current.review());
  act(() => {
    void result.current.submit();
    void result.current.submit();
  });
  expect(submit).toHaveBeenCalledTimes(1);
  await act(async () => {
    resolve({});
  });
  vi.spyOn(compositionApi, "lookup").mockImplementation(async (key) =>
    receipt(key),
  );
  await act(() => result.current.lookup());
  await waitFor(() => expect(settle).toHaveBeenCalledTimes(1));
  expect(result.current.phase).toBe("result");
});

test("reselecting unchanged sources restores the composition with fresh selection identities", async () => {
  const settle = vi.fn();
  vi.spyOn(compositionApi, "submit").mockImplementation(async (intent) => ({
    ...receipt(intent.idempotencyKey),
    works: [{ ...receipt(intent.idempotencyKey).works[0], title: "保留名称" }],
  }));
  const { result } = renderHook(() =>
    useCandidateComposition(settle, async () => {}),
  );
  act(() => result.current.open("merge", state()));
  act(() =>
    result.current.update((draft) => ({
      ...draft,
      version: draft.version + 1,
      groups: [
        { ...draft.groups[0], title: "保留名称", mediaIds: ["b-1", "a-1"] },
      ],
    })),
  );
  act(() => result.current.close());
  act(() => result.current.open("merge", state("-reselected")));
  expect(result.current.draft?.groups[0]).toMatchObject({
    title: "保留名称",
    mediaIds: ["b-1", "a-1"],
  });
  expect(
    result.current.draft?.sources.map((source) => source.selectionToken),
  ).toEqual(["a-reselected", "b-reselected"]);
  act(() => result.current.review());
  await act(() => result.current.submit());
  expect(
    settle.mock.calls[0][0].map(
      (source: { selectionToken: string }) => source.selectionToken,
    ),
  ).toEqual(["a-reselected", "b-reselected"]);
  expect(result.current.phase).toBe("result");
  expect(result.current.dirty).toBe(false);
});

test("successful import clears older cached compositions involving the processed sources", async () => {
  vi.spyOn(compositionApi, "submit").mockImplementation(async (intent) =>
    receipt(intent.idempotencyKey),
  );
  const { result } = renderHook(() =>
    useCandidateComposition(vi.fn(), async () => {}),
  );
  act(() => result.current.open("merge", state()));
  act(() => result.current.update((draft) => ({ ...draft, version: 1 })));
  act(() => result.current.close());
  const updated = state("-updated");
  for (const entry of updated.selected.values()) entry.candidate.revision = 4;
  act(() => result.current.open("merge", updated));
  expect(result.current.draft?.version).toBe(0);
  act(() => result.current.review());
  vi.mocked(compositionApi.submit).mockImplementation(async (intent) => ({
    ...receipt(intent.idempotencyKey),
    candidates: receipt(intent.idempotencyKey).candidates.map((source) => ({
      ...source,
      revision: 5,
    })),
  }));
  await act(() => result.current.submit());
  expect(result.current.phase).toBe("result");
  expect(result.current.dirty).toBe(false);
});
