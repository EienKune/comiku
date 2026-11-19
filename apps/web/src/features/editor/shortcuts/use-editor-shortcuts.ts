import { useEffect, useState } from "react";
import {
  defaultEditorShortcuts,
  readEditorShortcuts,
  writeEditorShortcuts,
  type EditorShortcuts,
} from "./editor-shortcuts";

export function useEditorShortcuts(accountId: string) {
  const [state, setState] = useState(() => ({
    accountId,
    ...readEditorShortcuts(accountId),
  }));
  useEffect(() => {
    setState((previous) =>
      previous.accountId === accountId
        ? previous
        : { accountId, ...readEditorShortcuts(accountId) },
    );
  }, [accountId]);
  const current =
    state.accountId === accountId
      ? state
      : { bindings: defaultEditorShortcuts, notice: null };
  return {
    ...current,
    save(bindings: EditorShortcuts) {
      const notice = writeEditorShortcuts(accountId, bindings);
      setState({ accountId, bindings: { ...bindings }, notice });
      return notice;
    },
  };
}
