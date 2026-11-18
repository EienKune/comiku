import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CompositionEvent,
} from "react";
import { SpellCheck } from "lucide-react";
import { Badge, Button } from "../../../components/ui";
import type { EditableTranslationImage } from "../draft-storage";
import { replaceTextareaRange } from "../native-text-edit";
import {
  checkTranslationPunctuation,
  isPunctuationResultCurrent,
  type PunctuationResult,
  type PunctuationScope,
} from "./check-punctuation";
import "./punctuation-check.css";

interface Context {
  scope: PunctuationScope;
  images: EditableTranslationImage[];
  ready: boolean;
  writable: boolean;
  canRepair?: () => boolean;
  getTextarea: (id: string) => HTMLTextAreaElement | null;
  onLocate: (result: PunctuationResult) => void;
  onUpdate: (id: string, text: string) => void;
}

type Snapshot = {
  scope: PunctuationScope;
  images: EditableTranslationImage[];
  results: PunctuationResult[];
};

function sameSnapshot(snapshot: Snapshot, context: Context) {
  return (
    snapshot.scope.workId === context.scope.workId &&
    snapshot.scope.editorEpoch === context.scope.editorEpoch &&
    snapshot.scope.latestVersionId === context.scope.latestVersionId &&
    snapshot.images === context.images
  );
}

export function usePunctuationCheck(context: Context) {
  const latest = useRef(context);
  latest.current = context;
  const composing = useRef(new Set<HTMLTextAreaElement>());
  const triggerRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(50);
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState<{
    result: PunctuationResult;
    replacement?: string;
  } | null>(null);
  const title = useId();

  function isComposing() {
    for (const node of composing.current) {
      if (!node.isConnected) composing.current.delete(node);
    }
    return composing.current.size > 0;
  }

  function current(result: PunctuationResult) {
    const active = latest.current;
    return (
      active.ready &&
      isPunctuationResultCurrent(result, active.scope, active.images)
    );
  }

  function repairable(result: PunctuationResult) {
    const active = latest.current;
    const entry = active.images
      .find((image) => image.id === result.imageId)
      ?.entries.find((item) => item.id === result.entryId);
    return (
      active.writable &&
      (active.canRepair?.() ?? true) &&
      Boolean(entry && !entry.localOnly)
    );
  }

  function check() {
    const active = latest.current;
    if (!active.ready || isComposing()) {
      setStatus("请结束输入法组合输入，并等待全部译文和草稿加载完成后重试。");
      return;
    }
    setSnapshot({
      scope: { ...active.scope },
      images: active.images,
      results: checkTranslationPunctuation(active.scope, active.images),
    });
    setLimit(50);
    setStatus("");
    setOpen(true);
  }

  function close() {
    dialogRef.current?.close();
    setOpen(false);
    triggerRef.current?.querySelector("button")?.focus({ preventScroll: true });
  }

  function act(result: PunctuationResult, replacement?: string) {
    if (
      !current(result) ||
      isComposing() ||
      (replacement !== undefined && !repairable(result))
    ) {
      setStatus("目标已变化或当前不能操作，请结束输入后重新检查。");
      return;
    }
    // Leave the modal top layer before focusing the actual editor textarea.
    dialogRef.current?.close();
    setOpen(false);
    setPending({ result, replacement });
    latest.current.onLocate(result);
  }

  useEffect(() => {
    if (open) dialogRef.current?.showModal();
  }, [open]);

  useLayoutEffect(() => {
    if (!pending) return;
    // Run outside React's commit: native input must be allowed to finish its
    // normal controlled-input event before we inspect the resulting value.
    const frame = requestAnimationFrame(() => {
      setPending(null);
      const { result, replacement } = pending;
      const active = latest.current;
      const node = active.getTextarea(result.entryId);
      if (
        !current(result) ||
        isComposing() ||
        !node?.isConnected ||
        node.value !== result.text ||
        (replacement !== undefined && (!repairable(result) || node.disabled))
      ) {
        setStatus("目标已变化或当前不能操作，请重新检查。");
        return;
      }
      node.closest("article")?.scrollIntoView?.({ block: "nearest" });
      if (replacement === undefined) {
        node.focus({ preventScroll: true });
        node.setSelectionRange(result.start, result.end);
        setStatus(
          `已定位第 ${result.imageNumber} 页，Label ${result.entryNumber}`,
        );
      } else if (
        replaceTextareaRange(node, {
          start: result.start,
          end: result.end,
          replacement,
          expectedText: result.text,
        })
      ) {
        // Native input normally reaches onChange; keep the existing save path in
        // browsers that don't emit it for the editing command as well.
        const entry = latest.current.images
          .find((image) => image.id === result.imageId)
          ?.entries.find((item) => item.id === result.entryId);
        if (entry?.translatedText !== node.value)
          latest.current.onUpdate(result.entryId, node.value);
        setStatus("已替换，可在译文框中撤销或重做。重新检查可查看剩余问题。");
      } else {
        setStatus("浏览器未能执行可撤销的替换，请在已定位的译文框中手动修改。");
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [pending]);

  function compositionStart(event: CompositionEvent<HTMLDivElement>) {
    if (event.target instanceof HTMLTextAreaElement)
      composing.current.add(event.target);
  }

  function compositionEnd(event: CompositionEvent<HTMLDivElement>) {
    if (event.target instanceof HTMLTextAreaElement)
      composing.current.delete(event.target);
  }

  const changed = Boolean(snapshot && !sameSnapshot(snapshot, context));
  const results = snapshot?.results ?? [];
  return {
    compositionStart,
    compositionEnd,
    notice:
      !open && status ? (
        <div className="translation-editor-message" role="status">
          <span>{status}</span>
          <button
            type="button"
            aria-label="关闭标点提示"
            onClick={() => setStatus("")}
          >
            关闭
          </button>
        </div>
      ) : null,
    tools: (
      <div ref={triggerRef} className="punctuation-check-tools">
        <Button
          size="sm"
          variant="secondary"
          leadingIcon={<SpellCheck size={15} />}
          disabled={!context.ready}
          onClick={check}
        >
          检查标点
        </Button>
        {open && snapshot && (
          <dialog
            ref={dialogRef}
            className="punctuation-check-dialog"
            aria-labelledby={title}
            onCancel={(event) => {
              event.preventDefault();
              close();
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.stopPropagation();
                close();
              }
            }}
          >
            <header>
              <h2 id={title}>标点检查</h2>
              <Button size="sm" variant="secondary" onClick={close}>
                关闭
              </Button>
            </header>
            <div className="punctuation-check-body">
              <p>
                已检查 {snapshot.images.length} 页译文 · 明确格式问题{" "}
                {results.filter((item) => item.severity === "format").length} 项
                · 需要确认{" "}
                {results.filter((item) => item.severity === "confirm").length}{" "}
                项
              </p>
              <p className="punctuation-check-boundary">
                仅检查标点格式，不代表翻译或校对通过，不影响保存和交稿。
              </p>
              {(changed || status || !context.ready) && (
                <div role="status" className="punctuation-check-status">
                  {!context.ready
                    ? "译文尚未就绪，请等待加载或先处理本地草稿冲突。"
                    : status || "译文或版本已变化，请重新检查。"}
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!context.ready}
                    onClick={check}
                  >
                    重新检查
                  </Button>
                </div>
              )}
              {results.length ? (
                <ol className="punctuation-check-results">
                  {results.slice(0, limit).map((result) => {
                    const valid = current(result);
                    const before = result.text.slice(
                      Math.max(0, result.start - 20),
                      result.start,
                    );
                    const after = result.text.slice(
                      result.end,
                      result.end + 20,
                    );
                    return (
                      <li
                        key={`${result.imageId}:${result.entryId}:${result.ruleId}:${result.start}`}
                      >
                        <div className="punctuation-check-result-heading">
                          <strong>
                            第 {result.imageNumber} 页 · Label{" "}
                            {result.entryNumber}
                          </strong>
                          <Badge
                            tone={
                              result.severity === "format"
                                ? "warning"
                                : "neutral"
                            }
                          >
                            {valid
                              ? result.severity === "format"
                                ? "明确格式问题"
                                : "需要确认"
                              : "已失效"}
                          </Badge>
                        </div>
                        <blockquote>
                          {before}
                          <mark>
                            {result.text.slice(result.start, result.end)}
                          </mark>
                          {after}
                        </blockquote>
                        <p>{result.explanation}</p>
                        <div className="punctuation-check-result-actions">
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={!valid}
                            onClick={() => act(result)}
                          >
                            定位
                          </Button>
                          {result.replacements.map((replacement) => (
                            <Button
                              key={replacement}
                              size="sm"
                              variant="secondary"
                              disabled={!valid || !repairable(result)}
                              onClick={() => act(result, replacement)}
                            >
                              {result.ruleId === "ascii-double-quotes"
                                ? "换为中文引号"
                                : replacement === ": "
                                  ? "换为半角冒号加空格"
                                  : `替换为 ${replacement}`}
                            </Button>
                          ))}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              ) : !changed && context.ready ? (
                <p role="status">未发现所检查的标点问题。</p>
              ) : null}
              {results.length > limit && (
                <Button
                  variant="secondary"
                  onClick={() => setLimit((value) => value + 50)}
                >
                  再显示 50 项
                </Button>
              )}
            </div>
          </dialog>
        )}
      </div>
    ),
  };
}
