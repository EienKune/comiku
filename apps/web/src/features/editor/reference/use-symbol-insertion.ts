import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type TextareaHTMLAttributes,
} from "react";
export interface SymbolInsertionContext {
  scope: string;
  writable: boolean;
  selectedEntryId: string | null;
  entries: { id: string; translatedText: string; localOnly?: boolean }[];
  onUpdate: (id: string, value: string) => void;
}
interface Target {
  scope: string;
  id: string;
  node: HTMLTextAreaElement;
  start: number;
  end: number;
  text: string;
  composing: boolean;
}

function valid(target: Target, context: SymbolInsertionContext) {
  const entry = context.entries.find((entry) => entry.id === target.id);
  return (
    context.writable &&
    context.scope === target.scope &&
    context.selectedEntryId === target.id &&
    Boolean(
      entry && !entry.localOnly && entry.translatedText === target.text,
    ) &&
    target.node.isConnected &&
    !target.node.disabled
  );
}

export function useSymbolInsertion(context: SymbolInsertionContext) {
  const latest = useRef(context);
  latest.current = context;
  const target = useRef<Target | null>(null);
  const pendingCaret = useRef<Target | null>(null);
  const composingNodes = useRef(new WeakSet<HTMLTextAreaElement>());
  const [status, setStatus] = useState("");

  useLayoutEffect(() => {
    const saved = target.current;
    if (saved && !valid(saved, context)) {
      target.current = null;
      pendingCaret.current = null;
    }
    const pending = pendingCaret.current;
    if (pending && valid(pending, context)) {
      pendingCaret.current = null;
      pending.node.focus({ preventScroll: true });
      pending.node.setSelectionRange(pending.start, pending.end);
    }
  });
  useEffect(() => {
    const clear = () => {
      target.current = null;
      pendingCaret.current = null;
    };
    const focus = (event: FocusEvent) => {
      const node = event.target;
      if (
        node === target.current?.node ||
        (node instanceof Element &&
          node.closest("[data-editor-reference-tools]"))
      )
        return;
      clear();
    };
    const visibility = () => {
      if (document.hidden) clear();
    };
    document.addEventListener("focusin", focus);
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      document.removeEventListener("focusin", focus);
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  function remember(
    id: string,
    node: HTMLTextAreaElement,
    composing?: boolean,
  ) {
    if (composing === true) composingNodes.current.add(node);
    if (composing === false) composingNodes.current.delete(node);
    const current = latest.current;
    const entry = current.entries.find((item) => item.id === id);
    if (!current.writable || !entry || entry.localOnly || node.disabled) {
      target.current = null;
      return;
    }
    target.current = {
      scope: current.scope,
      id,
      node,
      start: node.selectionStart,
      end: node.selectionEnd,
      text: node.value,
      composing: composingNodes.current.has(node),
    };
  }

  function bindTextarea(
    id: string,
  ): TextareaHTMLAttributes<HTMLTextAreaElement> {
    return {
      onFocus: (event) => remember(id, event.currentTarget),
      onInput: (event) => remember(id, event.currentTarget),
      onSelect: (event) => remember(id, event.currentTarget),
      onKeyUp: (event) => remember(id, event.currentTarget),
      onPointerUp: (event) => remember(id, event.currentTarget),
      onBlur: (event) => {
        if (target.current?.node === event.currentTarget)
          remember(id, event.currentTarget);
      },
      onCompositionStart: (event) => remember(id, event.currentTarget, true),
      onCompositionEnd: (event) => remember(id, event.currentTarget, false),
    };
  }

  async function insert(symbol: string) {
    const saved = target.current;
    if (
      saved &&
      valid(saved, latest.current) &&
      !saved.composing &&
      saved.node.value === saved.text
    ) {
      const text =
        saved.text.slice(0, saved.start) + symbol + saved.text.slice(saved.end);
      const caret = saved.start + symbol.length;
      const next = { ...saved, text, start: caret, end: caret };
      target.current = next;
      pendingCaret.current = next;
      latest.current.onUpdate(saved.id, text);
      setStatus(`已插入 ${symbol}`);
      return;
    }
    if (saved && !valid(saved, latest.current)) target.current = null;
    try {
      await navigator.clipboard.writeText(symbol);
      setStatus(`已复制 ${symbol}`);
    } catch {
      setStatus(`复制失败，请手动复制：${symbol}`);
    }
  }
  return { status, bindTextarea, insert };
}
