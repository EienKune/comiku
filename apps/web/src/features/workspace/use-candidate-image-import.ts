import { useCallback, useMemo, useRef, useState } from "react";
import { client, unwrap } from "../account/api";
import {
  applyImportDraft,
  buildCandidateImportIntent,
  emptyCandidateImportState,
  resetImportCandidate,
  selectCandidateForImport,
  settleCandidateImport,
  type CandidateImportEntry,
  type ImportCandidate,
} from "./candidate-import-state";
import {
  toggleLoadedCandidates,
  settleCandidateSelection,
} from "./candidate-selection";
import { candidateImageDraftChanged } from "./candidate-image-drafts";
import type {
  CandidateImportPhase,
  CandidateImportResult,
} from "./CandidateImportConfirmation";

type Confirmation = {
  entries: CandidateImportEntry[];
  phase: CandidateImportPhase;
  results?: CandidateImportResult[];
  error?: string;
};
export function useCandidateImageImport(onComplete: () => Promise<unknown>) {
  const [state, setState] = useState(emptyCandidateImportState),
    [confirmation, setConfirmation] = useState<Confirmation | null>(null),
    [confirmationVisible, setConfirmationVisible] = useState(false);
  const [editor, setEditor] = useState<ImportCandidate | null>(null),
    [error, setError] = useState(""),
    [success, setSuccess] = useState(""),
    [reloading, setReloading] = useState(false);
  const running = useRef(false),
    editorEpoch = useRef(0);
  const [editorVersion, setEditorVersion] = useState(0);
  const complete = useRef(onComplete);
  complete.current = onComplete;
  const uncertain = confirmation?.phase === "uncertain",
    busy = confirmation?.phase === "submitting",
    locked = busy || uncertain;
  const selected = useMemo(
    () =>
      new Map(
        [...state.selected].map(([id, item]) => [id, item.candidate.revision]),
      ),
    [state.selected],
  );
  function toggle(candidate: ImportCandidate) {
    if (locked || running.current) return;
    const token = crypto.randomUUID();
    setState((current) => selectCandidateForImport(current, candidate, token));
  }
  function toggleLoaded(candidates: ImportCandidate[]) {
    if (locked || running.current) return;
    const tokens = new Map(
      candidates.map((candidate) => [candidate.id, crypto.randomUUID()]),
    );
    setState((current) => {
      const revisions = new Map(
        [...current.selected].map(([id, item]) => [
          id,
          item.candidate.revision,
        ]),
      );
      const nextRevisions = toggleLoadedCandidates(revisions, candidates);
      const selected = new Map(
        [...current.selected].filter(([id]) => nextRevisions.has(id)),
      );
      for (const candidate of candidates)
        if (nextRevisions.has(candidate.id) && !selected.has(candidate.id))
          selected.set(candidate.id, {
            candidate: {
              ...candidate,
              media: candidate.media.map((media) => ({ ...media })),
            },
            token: tokens.get(candidate.id)!,
          });
      return { ...current, selected };
    });
  }
  function clearSelection() {
    if (!locked && !running.current)
      setState((current) => ({ ...current, selected: new Map() }));
  }
  function openEditor(candidate: ImportCandidate) {
    if (locked || running.current) return;
    editorEpoch.current++;
    setEditor(candidate);
    setError("");
  }
  function closeEditor() {
    editorEpoch.current++;
    setEditor(null);
    setReloading(false);
    setError("");
  }
  function applyEditor(ids: string[]) {
    if (!editor || locked) return;
    try {
      const next = applyImportDraft(state, editor, ids);
      setState(next);
      if (confirmation && confirmationVisible)
        setConfirmation({
          entries: buildCandidateImportIntent(next),
          phase: "review",
        });
      closeEditor();
      setSuccess("图片整理已应用，尚未入库");
    } catch (e) {
      setError(e instanceof Error ? e.message : "图片整理未应用，请重试");
    }
  }
  async function resetEditor() {
    if (!editor || locked || reloading) return;
    const id = editor.id,
      epoch = editorEpoch.current;
    setReloading(true);
    setError("");
    try {
      const latest = await unwrap(
        await client.GET("/api/candidates/{id}", { params: { path: { id } } }),
      );
      if (editorEpoch.current !== epoch) return;
      if (latest.status !== "pending")
        throw new Error("此帖已被处理，不能继续整理入库图片");
      const next = resetImportCandidate(state, latest, crypto.randomUUID());
      setState(next);
      editorEpoch.current++;
      setEditorVersion((value) => value + 1);
      setEditor(latest);
      if (confirmation && confirmationVisible)
        setConfirmation({
          entries: buildCandidateImportIntent(next),
          phase: "review",
        });
    } catch (e) {
      if (editorEpoch.current === epoch)
        setError(e instanceof Error ? e.message : "读取最新图片失败");
    } finally {
      if (editorEpoch.current === epoch || editorEpoch.current === epoch + 1)
        setReloading(false);
    }
  }
  function openConfirmation() {
    if (running.current) return;
    if (uncertain) {
      setConfirmationVisible(true);
      return;
    }
    try {
      const entries = buildCandidateImportIntent(state);
      if (!entries.length) return;
      setError("");
      setConfirmation({ entries, phase: "review" });
      setConfirmationVisible(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "无法准备入库，请重新检查选择");
    }
  }
  function closeConfirmation() {
    if (running.current) return;
    setConfirmationVisible(false);
    if (!uncertain) setConfirmation(null);
  }
  async function submit() {
    if (
      running.current ||
      !confirmation ||
      !["review", "uncertain"].includes(confirmation.phase)
    )
      return;
    const entries = confirmation.entries;
    running.current = true;
    setConfirmation({ ...confirmation, phase: "submitting", error: undefined });
    setError("");
    setSuccess("");
    try {
      const response = await unwrap(
        await client.POST("/api/candidates/actions", {
          body: {
            action: "import",
            items: entries.map(({ id, expectedRevision, mediaIds }) => ({
              id,
              expectedRevision,
              mediaIds: [...mediaIds],
            })),
          },
        }),
      );
      const expected = new Set(entries.map((entry) => entry.id)),
        seen = new Set<string>();
      const outcomes = new Set([
        "succeeded",
        "unchanged",
        "conflict",
        "not_found",
        "forbidden",
        "failed",
      ]);
      if (
        response.results.length !== entries.length ||
        response.results.some((result) => {
          if (
            !expected.has(result.id) ||
            seen.has(result.id) ||
            !outcomes.has(result.outcome)
          )
            return true;
          seen.add(result.id);
          return false;
        })
      )
        throw new Error("入库回执不完整，尚未确认全部结果");
      setState((current) =>
        settleCandidateImport(current, entries, response.results),
      );
      const failures = response.results.filter(
        (result) => !["succeeded", "unchanged"].includes(result.outcome),
      );
      if (failures.length) {
        setConfirmation({
          entries,
          phase: "result",
          results: response.results,
          error: `${response.results.length - failures.length} 项完成，${failures.length} 项需要重新检查`,
        });
      } else {
        setConfirmation(null);
        setConfirmationVisible(false);
        setSuccess(`${response.results.length} 项入库完成`);
      }
      void complete.current().catch(() => {});
    } catch (e) {
      const message =
        e instanceof Error ? e.message : "请求未完成，请重试本次入库";
      setConfirmation({ entries, phase: "uncertain", error: message });
      setError("本次入库结果尚未确认，请继续查看并重试原请求。");
    } finally {
      running.current = false;
    }
  }
  const settleOther = useCallback(
    (
      results: readonly { id: string; outcome: string }[],
      submitted: ReadonlyMap<string, number>,
    ) => {
      setState((current) => {
        const revisions = new Map(
          [...current.selected].map(([id, item]) => [
            id,
            item.candidate.revision,
          ]),
        );
        const remaining = settleCandidateSelection(
          revisions,
          results,
          submitted,
        );
        const selected = new Map(current.selected),
          drafts = { ...current.drafts };
        for (const id of current.selected.keys())
          if (!remaining.has(id)) {
            selected.delete(id);
            delete drafts[id];
          }
        return { selected, drafts };
      });
    },
    [],
  );
  const operations = useRef({
    toggle,
    toggleLoaded,
    clearSelection,
    openEditor,
    closeEditor,
    applyEditor,
    resetEditor,
    openConfirmation,
    closeConfirmation,
    submit,
  });
  operations.current = {
    toggle,
    toggleLoaded,
    clearSelection,
    openEditor,
    closeEditor,
    applyEditor,
    resetEditor,
    openConfirmation,
    closeConfirmation,
    submit,
  };
  const [actions] = useState(() => ({
    toggle: (candidate: ImportCandidate) =>
      operations.current.toggle(candidate),
    toggleLoaded: (candidates: ImportCandidate[]) =>
      operations.current.toggleLoaded(candidates),
    clearSelection: () => operations.current.clearSelection(),
    openEditor: (candidate: ImportCandidate) =>
      operations.current.openEditor(candidate),
    closeEditor: () => operations.current.closeEditor(),
    applyEditor: (ids: string[]) => operations.current.applyEditor(ids),
    resetEditor: () => operations.current.resetEditor(),
    openConfirmation: () => operations.current.openConfirmation(),
    closeConfirmation: () => operations.current.closeConfirmation(),
    submit: () => operations.current.submit(),
  }));
  return {
    selected,
    state,
    editor,
    editorVersion,
    error,
    success,
    reloading,
    confirmation: confirmationVisible ? confirmation : null,
    busy,
    locked,
    uncertain,
    dirty:
      locked || Object.values(state.drafts).some(candidateImageDraftChanged),
    ...actions,
    settleOther,
  };
}
