import { useEffect, useId, useRef, useState } from "react";
import { Button, SearchField } from "../../../components/ui";
import {
  searchReferenceDictionary,
  type ReferenceDictionaryEntry,
} from "./reference-dictionary-api";
import "./reference-tools.css";

export function ReferenceDictionaryDialog({
  onClose,
  lookup = searchReferenceDictionary,
}: {
  onClose: () => void;
  lookup?: typeof searchReferenceDictionary;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const title = useId();
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [retry, setRetry] = useState(0);
  const [entries, setEntries] = useState<ReferenceDictionaryEntry[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState("");

  useEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current;
    dialog?.showModal();
    dialog
      ?.querySelector<HTMLInputElement>("input")
      ?.focus({ preventScroll: true });
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => {
        void lookup(q, offset, controller.signal)
          .then((page) => {
            if (controller.signal.aborted) return;
            setEntries((previous) =>
              offset === 0 ? page.entries : [...previous, ...page.entries],
            );
            setNextOffset(page.nextOffset);
            setPending(false);
          })
          .catch((cause: unknown) => {
            if (controller.signal.aborted) return;
            setError(
              cause instanceof Error ? cause.message : "查询失败，请稍后重试",
            );
            setPending(false);
          });
      },
      offset === 0 ? 200 : 0,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, offset, retry, lookup]);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus("已复制汉化建议");
    } catch {
      setCopyStatus("复制失败，请选择汉化建议后手动复制。");
    }
  }

  return (
    <dialog
      ref={ref}
      className="editor-reference-dialog"
      aria-labelledby={title}
      data-editor-reference-tools
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header>
        <h2 id={title}>拟声词</h2>
        <Button size="sm" variant="secondary" onClick={onClose}>
          关闭
        </Button>
      </header>
      <SearchField
        type="search"
        aria-label="搜索拟声词"
        placeholder="搜索日文或中文"
        value={query}
        onChange={(event) => {
          const value = Array.from(event.target.value).slice(0, 80).join("");
          if (value === query) return;
          setQuery(value);
          setOffset(0);
          setEntries([]);
          setNextOffset(null);
          setError(null);
          setCopyStatus("");
          setPending(Boolean(value.trim()));
        }}
      />
      <div className="editor-reference-results" aria-busy={pending}>
        {entries.map((entry, index) => (
          <article
            key={`${entry.id}:${index}`}
            className="editor-reference-entry"
          >
            <h3>{entry.original}</h3>
            {entry.explanationZh && (
              <div>
                <span className="editor-reference-label">中文解释</span>
                <p>{entry.explanationZh}</p>
              </div>
            )}
            {entry.explanationJa && (
              <div>
                <span className="editor-reference-label">日文说明</span>
                <p lang="ja">{entry.explanationJa}</p>
              </div>
            )}
            {entry.translationZh && (
              <div>
                <span className="editor-reference-label">汉化建议</span>
                <p>{entry.translationZh}</p>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void copy(entry.translationZh!)}
                >
                  复制汉化
                </Button>
              </div>
            )}
            {entry.notes && (
              <p className="editor-reference-notes">{entry.notes}</p>
            )}
            <footer>
              <span>
                {entry.source.name} · {entry.source.version} · {entry.sourceRef}
              </span>
              {entry.source.sourceUrl &&
                /^https?:\/\//i.test(entry.source.sourceUrl) && (
                  <a
                    href={entry.source.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    来源
                  </a>
                )}
              {entry.source.attribution && (
                <span>{entry.source.attribution}</span>
              )}
              {entry.source.license && <span>{entry.source.license}</span>}
            </footer>
          </article>
        ))}
        {!query.trim() && <p>输入日文或中文查询。</p>}
        {pending && <p role="status">正在查询…</p>}
        {query.trim() && !pending && !error && !entries.length && (
          <p>暂无匹配词条。</p>
        )}
        {error && (
          <div role="alert">
            <p>{error}</p>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setError(null);
                setPending(true);
                setRetry((value) => value + 1);
              }}
            >
              重试
            </Button>
          </div>
        )}
        {nextOffset !== null && !error && (
          <Button
            size="sm"
            variant="secondary"
            loading={pending}
            onClick={() => {
              setPending(true);
              setOffset(nextOffset);
            }}
          >
            继续加载
          </Button>
        )}
      </div>
      <div className="editor-reference-copy-status" role="status">
        {copyStatus}
      </div>
    </dialog>
  );
}
