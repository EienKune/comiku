import { useId, useRef, useState } from "react";
import { Button, IconButton } from "../../../components/ui";
import { BookOpen, Sparkles, X } from "lucide-react";
import { ReferenceDictionaryDialog } from "./ReferenceDictionaryDialog";
import type { searchReferenceDictionary } from "./reference-dictionary-api";
import "./reference-tools.css";

const symbols = ["☆", "★", "♡", "♥", "♪", "…"] as const;

export function EditorReferenceTools({
  insert,
  status,
  lookup,
}: {
  insert: (symbol: string) => void | Promise<void>;
  status: string;
  lookup?: typeof searchReferenceDictionary;
}) {
  const [dictionaryOpen, setDictionaryOpen] = useState(false);
  const [symbolsOpen, setSymbolsOpen] = useState(false);
  const symbolOpener = useRef<HTMLDivElement>(null);
  const panelId = useId();
  function closeSymbols() {
    setSymbolsOpen(false);
    symbolOpener.current
      ?.querySelector<HTMLButtonElement>("[aria-controls]")
      ?.focus({ preventScroll: true });
  }
  return (
    <div
      className="editor-reference-tools"
      data-editor-reference-tools
      ref={symbolOpener}
    >
      <Button
        size="sm"
        variant="secondary"
        leadingIcon={<BookOpen size={15} />}
        onClick={() => {
          setSymbolsOpen(false);
          setDictionaryOpen(true);
        }}
      >
        拟声词
      </Button>
      <Button
        size="sm"
        variant="secondary"
        leadingIcon={<Sparkles size={15} />}
        aria-expanded={symbolsOpen}
        aria-controls={panelId}
        onClick={() => setSymbolsOpen((open) => !open)}
      >
        符号
      </Button>
      {dictionaryOpen && (
        <ReferenceDictionaryDialog
          lookup={lookup}
          onClose={() => setDictionaryOpen(false)}
        />
      )}
      {symbolsOpen && (
        <div
          id={panelId}
          role="group"
          aria-label="常用符号"
          className="editor-symbol-panel"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.stopPropagation();
              closeSymbols();
            }
          }}
        >
          <header>
            <strong>常用符号</strong>
            <IconButton size="sm" label="关闭符号" onClick={closeSymbols}>
              <X size={16} />
            </IconButton>
          </header>
          <div className="editor-symbol-buttons">
            {symbols.map((symbol) => (
              <Button
                key={symbol}
                size="sm"
                variant="secondary"
                aria-label={`插入或复制 ${symbol}`}
                onClick={() => void insert(symbol)}
              >
                {symbol}
              </Button>
            ))}
          </div>
          <p role="status">{status || "插入译文光标处；无编辑目标时复制。"}</p>
        </div>
      )}
    </div>
  );
}
