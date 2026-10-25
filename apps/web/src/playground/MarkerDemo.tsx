import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from "react";
import {
  Check,
  Cloud,
  Hand,
  MessageSquarePlus,
  Minus,
  Move,
  Plus,
  Trash2,
} from "lucide-react";
import { Badge, Button, IconButton } from "../components/ui";
import { useAltWheelZoom } from "../features/editor/use-alt-wheel-zoom";
import { MarkerTooltip } from "../components/MarkerTooltip";

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

  useAltWheelZoom({
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

  function addMarker(event: MouseEvent<HTMLDivElement>) {
    if (toolMode !== "add") return;

    const bounds = event.currentTarget.getBoundingClientRect();
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
    <div className="marker-demo">
      <div className="marker-demo__toolbar">
        <div
          className="marker-demo__tools"
          role="toolbar"
          aria-label="图片操作工具"
        >
          <button
            type="button"
            className={toolMode === "pan" ? "is-active" : ""}
            aria-pressed={toolMode === "pan"}
            onClick={() => chooseTool("pan")}
          >
            <Hand size={15} />
            移动画布
          </button>
          <button
            type="button"
            className={
              toolMode === "add" && newMarkerType === "inside"
                ? "is-active"
                : ""
            }
            aria-pressed={toolMode === "add" && newMarkerType === "inside"}
            onClick={() => chooseAddTool("inside")}
          >
            <MessageSquarePlus size={15} />
            框内标点
          </button>
          <button
            type="button"
            className={
              toolMode === "add" && newMarkerType === "outside"
                ? "is-active"
                : ""
            }
            aria-pressed={toolMode === "add" && newMarkerType === "outside"}
            onClick={() => chooseAddTool("outside")}
          >
            <MessageSquarePlus size={15} />
            框外标点
          </button>
          <button
            type="button"
            className={toolMode === "move-marker" ? "is-active" : ""}
            aria-pressed={toolMode === "move-marker"}
            onClick={() => chooseTool("move-marker")}
          >
            <Move size={15} />
            移动标点
          </button>
        </div>

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
            ref={artboardRef}
            className="marker-artboard"
            style={{
              transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom / 100})`,
            }}
            onClick={addMarker}
          >
            <div className="marker-artboard__panel marker-artboard__panel--one" />
            <div className="marker-artboard__panel marker-artboard__panel--two" />
            <div className="marker-artboard__panel marker-artboard__panel--three" />
            <div className="marker-artboard__bubble marker-artboard__bubble--one" />
            <div className="marker-artboard__bubble marker-artboard__bubble--two" />
            <div className="marker-artboard__character marker-artboard__character--one" />
            <div className="marker-artboard__character marker-artboard__character--two" />

            {markers.map((marker, index) => (
              <MarkerTooltip
                key={`${marker.id}:${zoom}:${pan.x}:${pan.y}:${toolMode}`}
                text={marker.text}
              >
                <button
                  type="button"
                  className={`translation-marker translation-marker--${marker.positionType} ${marker.id === selectedId ? "is-selected" : ""}`}
                  style={{ left: `${marker.x}%`, top: `${marker.y}%` }}
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

          <div className="translation-list">
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
