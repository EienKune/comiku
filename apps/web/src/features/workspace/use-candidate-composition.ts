import { useRef, useState } from "react";
import {
  compositionApi,
  CompositionRequestError,
  validateCompositionReceipt,
  type CompositionReceipt,
} from "./candidate-composition-api";
import {
  compositionIntent,
  compositionProblem,
  compositionSources,
  createCompositionDraft,
  type CompositionDraft,
  type CompositionIntent,
  type CompositionMode,
} from "./candidate-composition-model";
import type {
  CandidateImportEntry,
  CandidateImportState,
} from "./candidate-import-state";

export type CompositionPhase =
  "editing" | "review" | "submitting" | "uncertain" | "result";
type Session = {
  key: string;
  draft: CompositionDraft;
  phase: CompositionPhase;
  intent?: CompositionIntent;
  error?: string;
  result?: CompositionReceipt;
};
export function useCandidateComposition(
  onSettled: (sources: readonly CandidateImportEntry[]) => void,
  onComplete: () => Promise<unknown>,
) {
  const [session, setSession] = useState<Session | null>(null),
    [visible, setVisible] = useState(false);
  const stored = useRef(new Map<string, CompositionDraft>()),
    running = useRef(false),
    current = useRef(session);
  current.current = session;
  const callbacks = useRef({ onSettled, onComplete });
  callbacks.current = { onSettled, onComplete };
  const locked =
    session?.phase === "submitting" || session?.phase === "uncertain";
  function open(mode: CompositionMode, state: CandidateImportState) {
    if (running.current || current.current?.phase === "uncertain") {
      setVisible(true);
      return;
    }
    const initial = createCompositionDraft(state, mode);
    const key = JSON.stringify([
      mode,
      initial.sources.map((source) => [
        source.id,
        source.expectedRevision,
        source.selectionToken,
        source.draftVersion,
      ]),
    ]);
    setSession({
      key,
      draft: stored.current.get(key) ?? initial,
      phase: "editing",
    });
    setVisible(true);
  }
  function update(change: (draft: CompositionDraft) => CompositionDraft) {
    if (running.current) return;
    setSession((value) => {
      if (!value || value.phase !== "editing") return value;
      const draft = change(value.draft);
      stored.current.set(value.key, draft);
      return { ...value, draft, error: undefined };
    });
  }
  function review() {
    setSession((value) => {
      if (
        !value ||
        value.phase !== "editing" ||
        compositionProblem(value.draft)
      )
        return value;
      return {
        ...value,
        phase: "review",
        intent: compositionIntent(value.draft, crypto.randomUUID()),
        error: undefined,
      };
    });
  }
  function edit() {
    if (running.current) return;
    setSession((value) =>
      value?.phase === "review"
        ? { ...value, phase: "editing", intent: undefined, error: undefined }
        : value,
    );
  }
  function close() {
    if (running.current) return;
    if (session?.phase === "editing")
      stored.current.set(session.key, session.draft);
    setVisible(false);
  }
  async function run(lookup: boolean) {
    const value = current.current;
    if (
      running.current ||
      !value?.intent ||
      !(lookup
        ? value.phase === "uncertain"
        : ["review", "uncertain"].includes(value.phase))
    )
      return;
    running.current = true;
    const wasUncertain = value.phase === "uncertain";
    setSession({ ...value, phase: "submitting", error: undefined });
    try {
      const data = lookup
        ? await compositionApi.lookup(value.intent.idempotencyKey)
        : await compositionApi.submit(value.intent);
      const originals = new Map(
        compositionSources(value.draft).map((source) => [
          source.id,
          source.candidate.media.map((media) => media.id),
        ]),
      );
      const result = validateCompositionReceipt(data, value.intent, originals);
      callbacks.current.onSettled(compositionSources(value.draft));
      if (stored.current.get(value.key)?.version === value.draft.version)
        stored.current.delete(value.key);
      setSession({ ...value, phase: "result", result, error: undefined });
      void callbacks.current.onComplete().catch(() => {});
    } catch (error) {
      const definite =
        !wasUncertain &&
        !lookup &&
        error instanceof CompositionRequestError &&
        error.status >= 400 &&
        error.status < 500 &&
        ![408, 429].includes(error.status);
      setSession({
        ...value,
        phase: definite ? "review" : "uncertain",
        error: error instanceof Error ? error.message : "尚未确认本次入库结果",
      });
    } finally {
      running.current = false;
    }
  }
  const operations = useRef({ open, update, review, edit, close, run });
  operations.current = { open, update, review, edit, close, run };
  const [actions] = useState(() => ({
    open: (mode: CompositionMode, state: CandidateImportState) =>
      operations.current.open(mode, state),
    update: (change: (draft: CompositionDraft) => CompositionDraft) =>
      operations.current.update(change),
    review: () => operations.current.review(),
    edit: () => operations.current.edit(),
    close: () => operations.current.close(),
    reopen: () => setVisible(true),
    submit: () => operations.current.run(false),
    lookup: () => operations.current.run(true),
  }));
  return {
    ...actions,
    visible,
    draft: session?.draft,
    phase: session?.phase,
    intent: session?.intent,
    result: session?.result,
    error: session?.error,
    locked,
    busy: session?.phase === "submitting",
    uncertain: session?.phase === "uncertain",
    dirty:
      locked ||
      [...stored.current.values()].some((draft) => draft.version > 0) ||
      (session?.phase === "editing" && session.draft.version > 0),
  };
}
