import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  Check,
  Cloud,
  Hand,
  Keyboard,
  MessageSquarePlus,
  Minus,
  Move,
  Plus,
  Trash2,
} from "lucide-react";
import { Badge, Button, IconButton } from "../components/ui";
import { useCanvasWheelZoom } from "../features/editor/use-canvas-wheel-zoom";
import "../components/marker-hit-area.css";
import "../components/editor-tool-keycap.css";
import { MarkerTooltip } from "../components/MarkerTooltip";
import { EditorShortcutDialog } from "../features/editor/shortcuts/EditorShortcutDialog";
import {
  captureShortcut,
  defaultEditorShortcuts,
  isShortcutControl,
  shortcutAria,
  shortcutLabel,
  type EditorShortcuts,
} from "../features/editor/shortcuts/editor-shortcuts";

type MarkerPositionType = "inside" | "outside";
type ToolMode = "add" | "move-marker" | "pan";

interface Marker {
  id: string;
  x: number;
  y: number;
  text: string;
  positionType: MarkerPositionType;
}

type DragState =
  | {
      kind: "marker";
      markerId: string;
      startClientX: number;
      startClientY: number;
      startX: number;
      startY: number;
    }
  | {
      kind: "pan";
      startClientX: number;
      startClientY: number;
      startX: number;
      startY: number;
    };

const initialMarkers: Marker[] = [
  {
    id: "marker-1",
    x: 27,
    y: 18,
    text: "今天也一起加油吧！",
    positionType: "inside",
  },
  {
    id: "marker-2",
    x: 72,
    y: 43,
    text: "嗯，我们出发。",
    positionType: "inside",
  },
  {
    id: "marker-3",
    x: 36,
    y: 76,
    text: "等、等等我——",
    positionType: "outside",
  },
];

type SaveState = "saved" | "saving";

const markerTypeLabel: Record<MarkerPositionType, string> = {
  inside: "框内",
  outside: "框外",
};

export function MarkerDemo() {
  const [shortcuts, setShortcuts] = useState<EditorShortcuts>({
    ...defaultEditorShortcuts,
  });
  const [showShortcutSettings, setShowShortcutSettings] = useState(false);
  const composing = useRef(false);
  const [markers, setMarkers] = useState(initialMarkers);
  const [selectedId, setSelectedId] = useState(initialMarkers[0].id);
  const [toolMode, setToolMode] = useState<ToolMode>("pan");
  const [newMarkerType, setNewMarkerType] =
    useState<MarkerPositionType>("inside");
  const [zoom, setZoom] = useState(90);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const artboardRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const undoStack = useRef<string[]>([]);
  const dragRef = useRef<DragState | null>(null);

  const selectedIndex = useMemo(
    () => markers.findIndex((marker) => marker.id === selectedId),
    [markers, selectedId],
  );
  const selectedMarker =
    selectedIndex >= 0 ? markers[selectedIndex] : undefined;

  useEffect(() => {
    if (markers === initialMarkers) return;
    setSaveState("saving");
    const timer = window.setTimeout(() => setSaveState("saved"), 720);
    return () => window.clearTimeout(timer);
  }, [markers]);

  useCanvasWheelZoom({
    canvas: stageRef,
    image: artboardRef,
    zoom: zoom / 100,
    offset: pan,
    ready: true,
    onChange: (next) => {
      setZoom(next.zoom * 100);
      setPan(next.offset);
    },
  });

  useEffect(() => {
    const clear = () => {
      undoStack.current = [];
    };
    const focus = (event: FocusEvent) => {
      if (!stageRef.current?.contains(event.target as Node)) clear();
    };
    const visibility = () => {
      if (document.hidden) clear();
    };
    const key = (event: KeyboardEvent) => {
      if (
        event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "z" &&
        toolMode === "add" &&
        stageRef.current?.contains(document.activeElement)
      ) {
        const id = undoStack.current.pop();
        if (id) {
          event.preventDefault();
          setMarkers((current) => current.filter((marker) => marker.id !== id));
          setSelectedId("");
        }
      }
    };
    window.addEventListener("keydown", key);
    window.addEventListener("blur", clear);
    document.addEventListener("focusin", focus);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", clear);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [toolMode]);

  function chooseTool(mode: ToolMode) {
    undoStack.current = [];
    setToolMode(mode);
  }

  function chooseAddTool(positionType: MarkerPositionType) {
    undoStack.current = [];
    setToolMode("add");
    setNewMarkerType(positionType);
  }

  function toolShortcut(event: ReactKeyboardEvent<HTMLDivElement>) {
    const target = event.target;
    if (
      event.defaultPrevented ||
      event.repeat ||
      composing.current ||
      event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229 ||
      dragRef.current ||
      document.querySelector(
        'dialog[open], [role="dialog"][aria-modal="true"]',
      ) ||
      !(target instanceof Element) ||
      !target.closest(
        ".marker-demo__stage, .marker-demo__tools, .translation-list",
      ) ||
      target.closest(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="spinbutton"], [role="slider"]',
      )
    )
      return;
    const captured = captureShortcut(event.nativeEvent);
    if (!captured || !("shortcut" in captured)) return;
    const action = (["pan", "add-inside", "add-outside", "move"] as const).find(
      (id) => shortcuts[id] === captured.shortcut,
    );
    if (action) {
      if (
        !target.closest(".marker-demo__stage, .marker-demo__tools") ||
        (!target.closest(".marker-demo__tools") && isShortcutControl(target))
      )
        return;
      event.preventDefault();
      if (target.closest(".translation-marker"))
        stageRef.current?.focus({ preventScroll: true });
      if (action === "add-inside") chooseAddTool("inside");
      else if (action === "add-outside") chooseAddTool("outside");
      else chooseTool(action === "pan" ? "pan" : "move-marker");
    } else if (
      target.closest(".marker-demo__stage, .translation-list") &&
      !isShortcutControl(target)
    ) {
      const key = captured.shortcut;
      if (
        key === shortcuts["previous-marker"] ||
        key === shortcuts["next-marker"]
      ) {
        event.preventDefault();
        const previous = key === shortcuts["previous-marker"];
        const nextIndex =
          selectedIndex === -1
            ? previous
              ? markers.length - 1
              : 0
            : selectedIndex + (previous ? -1 : 1);
        if (markers[nextIndex]) setSelectedId(markers[nextIndex].id);
      } else if (
        key === shortcuts["previous-page"] ||
        key === shortcuts["next-page"]
      ) {
        // This preview has a single page; both boundaries remain on this page.
        event.preventDefault();
      }
    }
  }

  function addMarker(event: MouseEvent<HTMLDivElement>) {
    if (toolMode !== "add") return;

    const bounds = artboardRef.current?.getBoundingClientRect();
    if (
      !bounds ||
      !bounds.width ||
      !bounds.height ||
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    )
      return;
    const marker: Marker = {
      id: crypto.randomUUID(),
      x: Math.max(
        4,
        Math.min(96, ((event.clientX - bounds.left) / bounds.width) * 100),
      ),
      y: Math.max(
        4,
        Math.min(96, ((event.clientY - bounds.top) / bounds.height) * 100),
      ),
      text: "",
      positionType: newMarkerType,
    };

    stageRef.current?.focus({ preventScroll: true });
    undoStack.current.push(marker.id);
    setMarkers((current) => [...current, marker]);
    setSelectedId(marker.id);
  }

  function updateSelected(text: string) {
    setMarkers((current) =>
      current.map((marker) =>
        marker.id === selectedId ? { ...marker, text } : marker,
      ),
    );
  }

  function updateSelectedType(positionType: MarkerPositionType) {
    setMarkers((current) =>
      current.map((marker) =>
        marker.id === selectedId ? { ...marker, positionType } : marker,
      ),
    );
  }

  function removeSelected() {
    undoStack.current = [];
    setMarkers((current) => {
      const next = current.filter((marker) => marker.id !== selectedId);
      const fallbackIndex = Math.min(
        Math.max(selectedIndex - 1, 0),
        next.length - 1,
      );
      setSelectedId(next[fallbackIndex]?.id ?? "");
      return next;
    });
  }

  function startMarkerDrag(
    event: PointerEvent<HTMLButtonElement>,
    marker: Marker,
  ) {
    event.stopPropagation();
    setSelectedId(marker.id);
    if (toolMode !== "move-marker") return;

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      kind: "marker",
      markerId: marker.id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: marker.x,
      startY: marker.y,
    };
  }

  function startPan(event: PointerEvent<HTMLDivElement>) {
    if (toolMode !== "pan") return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      kind: "pan",
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: pan.x,
      startY: pan.y,
    };
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;

    if (drag.kind === "pan") {
      setPan({
        x: drag.startX + event.clientX - drag.startClientX,
        y: drag.startY + event.clientY - drag.startClientY,
      });
      return;
    }

    const bounds = artboardRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const nextX =
      drag.startX + ((event.clientX - drag.startClientX) / bounds.width) * 100;
    const nextY =
      drag.startY + ((event.clientY - drag.startClientY) / bounds.height) * 100;
    setMarkers((current) =>
      current.map((marker) =>
        marker.id === drag.markerId
          ? {
              ...marker,
              x: Math.max(4, Math.min(96, nextX)),
              y: Math.max(4, Math.min(96, nextY)),
            }
          : marker,
      ),
    );
  }

  function stopDragging() {
    dragRef.current = null;
  }

  return (
    <div
      className="marker-demo"
      onKeyDown={toolShortcut}
      onCompositionStartCapture={() => {
        composing.current = true;
      }}
      onCompositionEndCapture={() => {
        composing.current = false;
      }}
    >
      {showShortcutSettings && (
        <EditorShortcutDialog
          bindings={shortcuts}
          notice={null}
          helpText="聚焦按键框后按下新快捷键。设置仅用于本次演示，不会修改账号偏好。此示例仅有一页；在画布或标记列表聚焦时可切换标记。"
          onSave={(next) => {
            setShortcuts({ ...next });
            return null;
          }}
          onClose={() => setShowShortcutSettings(false)}
        />
      )}
      <div className="marker-demo__toolbar">
        <div
          className="marker-demo__tools"
          role="toolbar"
          aria-label="图片操作工具"
        >
          <button
            type="button"
            className={`editor-tool-button${toolMode === "pan" ? " is-active" : ""}`}
            aria-label="移动画布"
            aria-keyshortcuts={shortcutAria(shortcuts.pan)}
            title={`移动画布 · 快捷键 ${shortcutLabel(shortcuts.pan)}（画布或工具栏聚焦时）`}
            aria-pressed={toolMode === "pan"}
            onClick={() => chooseTool("pan")}
          >
            <Hand size={15} />
            移动画布
            <kbd className="editor-tool-keycap" aria-hidden="true">
              {shortcutLabel(shortcuts.pan)}
            </kbd>
          </button>
          <button
            type="button"
            className={
              toolMode === "add" && newMarkerType === "inside"
                ? "editor-tool-button is-active"
                : "editor-tool-button"
            }
            aria-label="框内标点"
            aria-keyshortcuts={shortcutAria(shortcuts["add-inside"])}
            title={`框内标点 · 快捷键 ${shortcutLabel(shortcuts["add-inside"])}（画布或工具栏聚焦时）`}
            aria-pressed={toolMode === "add" && newMarkerType === "inside"}
            onClick={() => chooseAddTool("inside")}
          >
            <MessageSquarePlus size={15} />
            框内标点
            <kbd className="editor-tool-keycap" aria-hidden="true">
              {shortcutLabel(shortcuts["add-inside"])}
            </kbd>
          </button>
          <button
            type="button"
            className={
              toolMode === "add" && newMarkerType === "outside"
                ? "editor-tool-button is-active"
                : "editor-tool-button"
            }
            aria-label="框外标点"
            aria-keyshortcuts={shortcutAria(shortcuts["add-outside"])}
            title={`框外标点 · 快捷键 ${shortcutLabel(shortcuts["add-outside"])}（画布或工具栏聚焦时）`}
            aria-pressed={toolMode === "add" && newMarkerType === "outside"}
            onClick={() => chooseAddTool("outside")}
          >
            <MessageSquarePlus size={15} />
            框外标点
            <kbd className="editor-tool-keycap" aria-hidden="true">
              {shortcutLabel(shortcuts["add-outside"])}
            </kbd>
          </button>
          <button
            type="button"
            className={`editor-tool-button${toolMode === "move-marker" ? " is-active" : ""}`}
            aria-label="移动标点"
            aria-keyshortcuts={shortcutAria(shortcuts.move)}
            title={`移动标点 · 快捷键 ${shortcutLabel(shortcuts.move)}（画布或工具栏聚焦时）`}
            aria-pressed={toolMode === "move-marker"}
            onClick={() => chooseTool("move-marker")}
          >
            <Move size={15} />
            移动标点
            <kbd className="editor-tool-keycap" aria-hidden="true">
              {shortcutLabel(shortcuts.move)}
            </kbd>
          </button>
        </div>

        <IconButton
          label="快捷键设置"
          size="sm"
          onClick={() => setShowShortcutSettings(true)}
        >
          <Keyboard size={15} />
        </IconButton>

        <div className="marker-demo__zoom">
          <IconButton
            label="缩小"
            size="sm"
            onClick={() => setZoom((value) => Math.max(40, value - 10))}
          >
            <Minus size={15} />
          </IconButton>
          <span>{Math.round(zoom)}%</span>
          <IconButton
            label="放大"
            size="sm"
            onClick={() => setZoom((value) => Math.min(300, value + 10))}
          >
            <Plus size={15} />
          </IconButton>
        </div>
        <div className={`marker-demo__save marker-demo__save--${saveState}`}>
          {saveState === "saved" ? <Check size={15} /> : <Cloud size={15} />}
          <span>
            {saveState === "saved" ? "演示状态：已保存" : "演示状态：保存中…"}
          </span>
        </div>
      </div>

      <div className="marker-demo__body">
        <div
          ref={stageRef}
          tabIndex={0}
          className="marker-demo__stage"
          data-tool={toolMode}
          aria-label="示例漫画标记画布"
          onPointerDown={startPan}
          onPointerMove={handlePointerMove}
          onPointerUp={stopDragging}
          onPointerCancel={stopDragging}
        >
          <div
            className="marker-artboard"
            style={{ transform: `translate3d(${pan.x}px, ${pan.y}px, 0)` }}
            onClick={addMarker}
          >
            <div
              ref={artboardRef}
              className="marker-artboard-content"
              style={{ transform: `scale(${zoom / 100})` }}
            >
              <div className="marker-artboard__panel marker-artboard__panel--one" />
              <div className="marker-artboard__panel marker-artboard__panel--two" />
              <div className="marker-artboard__panel marker-artboard__panel--three" />
              <div className="marker-artboard__bubble marker-artboard__bubble--one" />
              <div className="marker-artboard__bubble marker-artboard__bubble--two" />
              <div className="marker-artboard__character marker-artboard__character--one" />
              <div className="marker-artboard__character marker-artboard__character--two" />
            </div>

            {markers.map((marker, index) => (
              <MarkerTooltip
                key={`${marker.id}:${zoom}:${pan.x}:${pan.y}:${toolMode}`}
                text={marker.text}
              >
                <button
                  type="button"
                  className={`translation-marker translation-marker--${marker.positionType} ${marker.id === selectedId ? "is-selected" : ""}`}
                  style={{
                    left: `${50 + (marker.x - 50) * (zoom / 100)}%`,
                    top: `${50 + (marker.y - 50) * (zoom / 100)}%`,
                  }}
                  aria-label={`选择第 ${index + 1} 条${markerTypeLabel[marker.positionType]}翻译`}
                  onPointerDown={(event) => startMarkerDrag(event, marker)}
                  onClick={(event) => {
                    event.stopPropagation();
                    setSelectedId(marker.id);
                  }}
                >
                  {index + 1}
                </button>
              </MarkerTooltip>
            ))}
          </div>
        </div>

        <aside className="marker-demo__list" aria-label="翻译条目">
          <div className="marker-demo__list-header">
            <div>
              <span className="eyebrow">PAGE 01</span>
              <h3>翻译文本</h3>
            </div>
            <Badge tone="brand">{markers.length} 条</Badge>
          </div>

          <div
            className="translation-list"
            tabIndex={0}
            role="region"
            aria-label="演示标记列表"
          >
            {markers.map((marker, index) => (
              <button
                type="button"
                key={marker.id}
                className={`translation-row ${marker.id === selectedId ? "is-selected" : ""}`}
                onClick={() => setSelectedId(marker.id)}
              >
                <span className="translation-row__number">{index + 1}</span>
                <span className="translation-row__type">
                  {markerTypeLabel[marker.positionType]}
                </span>
                <span className={marker.text ? "" : "is-placeholder"}>
                  {marker.text || "等待录入译文…"}
                </span>
              </button>
            ))}
          </div>

          {selectedMarker ? (
            <div className="translation-editor">
              <div className="translation-editor__head">
                <label htmlFor="translation-text">
                  标记 {selectedIndex + 1}
                </label>
                <div
                  className="translation-editor__marker-type"
                  role="group"
                  aria-label="标记类型"
                >
                  {(["inside", "outside"] as const).map((positionType) => (
                    <button
                      key={positionType}
                      type="button"
                      className={
                        selectedMarker.positionType === positionType
                          ? "is-active"
                          : ""
                      }
                      aria-pressed={
                        selectedMarker.positionType === positionType
                      }
                      onClick={() => updateSelectedType(positionType)}
                    >
                      {markerTypeLabel[positionType]}
                    </button>
                  ))}
                </div>
                <div className="translation-editor__order">
                  <IconButton
                    label="删除标记"
                    size="sm"
                    onClick={removeSelected}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                </div>
              </div>
              <textarea
                id="translation-text"
                value={selectedMarker.text}
                onChange={(event) => updateSelected(event.target.value)}
                placeholder="只需录入译文；原文保留在图片中。"
                rows={4}
              />
              <div className="translation-editor__meta">
                <span>译者 · 星野</span>
                <span>{selectedMarker.text.length} 字</span>
              </div>
            </div>
          ) : (
            <div className="translation-editor translation-editor--empty">
              选择框内或框外标点工具，在画面中创建第一条翻译标记。
            </div>
          )}

          <div className="marker-demo__footer">
            <Button variant="ghost" size="sm">
              暂存并退出
            </Button>
            <Button size="sm">确认本页</Button>
          </div>
        </aside>
      </div>
    </div>
  );
}
