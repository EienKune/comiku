import { useId, useRef, useState } from "react";
import { Button, IconButton } from "../../../components/ui";
import { BookOpen, GripVertical, Sparkles, X } from "lucide-react";
import { ReferenceDictionaryDialog } from "./ReferenceDictionaryDialog";
import type { searchReferenceDictionary } from "./reference-dictionary-api";
import { useSymbolPanel } from "./use-symbol-panel";
import "./reference-tools.css";

const symbols = Array.from("…～♡♠「」『』（）○●※☆★□◇♪♬·〆");

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
  const symbolPanel = useSymbolPanel(symbolsOpen, symbolOpener);
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
        className="editor-reference-trigger"
        leadingIcon={<BookOpen size={15} />}
        aria-label="拟声词"
        title="拟声词"
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
        className="editor-reference-trigger"
        leadingIcon={<Sparkles size={15} />}
        aria-label="符号"
        title="符号"
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
          ref={symbolPanel.panel}
          style={symbolPanel.style}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.stopPropagation();
              closeSymbols();
            }
          }}
        >
          <header {...symbolPanel.headerProps}>
            <strong>
              <GripVertical size={15} aria-hidden="true" />
              常用符号
            </strong>
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
