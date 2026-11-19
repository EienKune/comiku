import { useState } from "react";
import { Surface } from "../components/ui";
import { EditorReferenceTools } from "../features/editor/reference/EditorReferenceTools";
import { useSymbolInsertion } from "../features/editor/reference/use-symbol-insertion";
import type {
  ReferenceDictionaryEntry,
  searchReferenceDictionary,
} from "../features/editor/reference/reference-dictionary-api";

const entries: ReferenceDictionaryEntry[] = [
  {
    id: "synthetic-reference",
    original: "カチッ",
    explanationZh: "小物件扣合的短促声音。",
    explanationJa: "小さく硬い音。",
    translationZh: "咔哒",
    notes: null,
    sourceRef: "example:1",
    source: {
      key: "playground",
      name: "合成示例",
      version: "1",
      sourceUrl: null,
      attribution: null,
      license: "MIT",
    },
  },
];
const lookup: typeof searchReferenceDictionary = async (query) => ({
  entries: entries.filter((entry) =>
    [entry.original, entry.explanationZh, entry.explanationJa].some((value) =>
      value?.includes(query),
    ),
  ),
  nextOffset: null,
});

export function EditorReferenceDemo() {
  const [text, setText] = useState("好，马上就来。");
  const symbols = useSymbolInsertion({
    scope: "playground",
    writable: true,
    selectedEntryId: "example",
    entries: [{ id: "example", translatedText: text }],
  });
  return (
    <Surface className="editor-reference-demo">
      <header>
        <h3>拟声词与符号</h3>
        <EditorReferenceTools
          insert={symbols.insert}
          status={symbols.status}
          lookup={lookup}
        />
      </header>
      <label>
        <span>示例译文</span>
        <textarea
          {...symbols.bindTextarea("example")}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
    </Surface>
  );
}
