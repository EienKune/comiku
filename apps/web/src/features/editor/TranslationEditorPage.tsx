import { workImageKey } from "../workspace/use-work-image-url";
import { EditorPagePreview } from "./EditorPagePreview";
import { EditorSubmissionCancelAction } from "./EditorSubmissionCancelAction";
import { useConfirmation } from "../../components/use-confirmation";
import { refreshReviewViews } from "../workspace/review-cache";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { components } from "@comiku/api-client";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  CloudOff,
  Download,
  FileText,
  FileWarning,
  Grab,
  Grid2X2,
  HardDrive,
  ImageIcon,
  Keyboard,
  LoaderCircle,
  Maximize2,
  Move,
  Plus,
  Save,
  Trash2,
  Upload,
  Users,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Link, Navigate, useParams } from "react-router";
import { ReviewRequestActions } from "../workspace/ReviewRequestActions";
import { SkipProofreadingButton } from "../workspace/SkipProofreadingButton";
import { Badge, Button, IconButton, SelectControl } from "../../components/ui";
import { isDisplayableImageUrl } from "../../components/media-url";
import { OptionalSection } from "../../components/OptionalSection";
import { MarkerTooltip } from "../../components/MarkerTooltip";
import { useAccount } from "../account/account-context";
import { authenticatedFetch, client, unwrap } from "../account/api";
import {
  createTranslationDraft,
  deleteTranslationDraft,
  loadTranslationDraft,
  reapplyDraftContent,
  reconcileTranslationDraft,
  saveTranslationDraft,
  type EditableTranslationEntry,
  type EditableTranslationImage,
  type TranslationDraftRecord,
  type TranslationImage,
} from "./draft-storage";
import { getPageWriteAccess, type PageEditor } from "./page-access";
import { mergeServerImage } from "./merge-server-image";
import { useCanvasWheelZoom } from "./use-canvas-wheel-zoom";
import { useMarkerReorder } from "./use-marker-reorder";
import {
  captureShortcut,
  isShortcutControl,
  shortcutAria,
  shortcutLabel,
} from "./shortcuts/editor-shortcuts";
import { useEditorShortcuts } from "./shortcuts/use-editor-shortcuts";
import { EditorShortcutDialog } from "./shortcuts/EditorShortcutDialog";
import "../../components/marker-hit-area.css";
import "../../components/editor-tool-keycap.css";
import { EditorReferenceTools } from "./reference/EditorReferenceTools";
import { useSymbolInsertion } from "./reference/use-symbol-insertion";
import { checkTranslationPunctuation } from "./punctuation/check-punctuation";
import { SubmissionPunctuationWarnings } from "./punctuation/SubmissionPunctuationWarnings";
import "./translation-editor.css";

type MarkerPosition = components["schemas"]["MarkerPositionType"];
type WorkStage = components["schemas"]["WorkStage"];
type TranslationPresence = components["schemas"]["TranslationPresenceDto"];
type TranslationPresenceMode = components["schemas"]["TranslationPresenceMode"];
type LabelPlusImportPreview =
  components["schemas"]["LabelPlusImportPreviewDto"];
type EditorTool = "add-inside" | "add-outside" | "move" | "pan";
type SaveState =
  "saved" | "local" | "syncing" | "offline" | "failed" | "conflict";

const autosaveDelay = 3000;
const presenceHeartbeatDelay = 30_000;
const localIdPrefix = "local:";
const markerCoordinateScale = 1_000;

type DraftConflictKind = "recovery" | "content" | "epoch";
type EditorStateSignal = Pick<
  components["schemas"]["TranslationEditorDto"],
  "workRevision" | "editorEpoch" | "workflowStatus" | "reviewStatus"
>;

type MarkerUndo = {
  entryId: string;
  imageId: string;
  epoch: number;
  revision: number;
  uncertain: boolean;
};

const tools: {
  value: EditorTool;
  label: string;
  icon: typeof Grab;
}[] = [
  { value: "pan", label: "移动画布", icon: Grab },
  { value: "add-inside", label: "添加框内", icon: Plus },
  { value: "add-outside", label: "添加框外", icon: CircleDot },
  { value: "move", label: "移动标记", icon: Move },
];

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeMarkerCoordinate(value: number) {
  return Math.round(value * markerCoordinateScale) / markerCoordinateScale;
}

function entryContentMatches(
  left: EditableTranslationEntry,
  right: EditableTranslationEntry,
) {
  return (
    left.markerX === right.markerX &&
    left.markerY === right.markerY &&
    left.markerPositionType === right.markerPositionType &&
    left.translatedText === right.translatedText &&
    left.note === right.note
  );
}

function statusCopy(state: SaveState, savedAt: Date | null) {
  switch (state) {
    case "syncing":
      return "正在保存到服务端";
    case "local":
      return "已写入本地草稿";
    case "offline":
      return "离线，本地草稿待同步";
    case "failed":
      return "保存失败，本地草稿仍保留";
    case "conflict":
      return "检测到版本冲突";
    default:
      return savedAt
        ? `服务端已保存 ${savedAt.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`
        : "内容已与服务端同步";
  }
}

function SaveStateIcon({ state }: { state: SaveState }) {
  if (state === "syncing")
    return <LoaderCircle className="ui-spin" size={16} />;
  if (state === "saved") return <Check size={16} />;
  if (state === "local") return <HardDrive size={16} />;
  if (state === "offline") return <CloudOff size={16} />;
  return <AlertTriangle size={16} />;
}

async function updateEditorPresence(
  workId: string,
  mode: TranslationPresenceMode,
) {
  const result = await client.POST(
    "/api/works/{workId}/translations/presence",
    {
      params: { path: { workId } },
      body: { mode },
    },
  );
  if (mode === "edit" && result.response.status === 403) {
    const viewing = await unwrap(
      await client.POST("/api/works/{workId}/translations/presence", {
        params: { path: { workId } },
        body: { mode: "view" },
      }),
    );
    return { ...viewing, viewOnly: true };
  }
  return { ...(await unwrap(result)), viewOnly: false };
}

function stageCopy(stage: WorkStage) {
  return stage === "translate" ? "翻译" : "校对";
}

const reviewStatusCopy = {
  needs_review: "作品只读挂起，本地草稿保留",
  blocked: "作品已阻塞",
} as const;

export function TranslationEditorPage() {
  const { id: workId = "" } = useParams();
  const user = useAccount();
  const queryClient = useQueryClient();
  const shortcuts = useEditorShortcuts(user.id);
  const [showShortcutSettings, setShowShortcutSettings] = useState(false);
  const shortcutComposing = useRef(false);
  const [images, setImages] = useState<EditableTranslationImage[]>([]);
  const imagesRef = useRef<EditableTranslationImage[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [showPagePreview, setShowPagePreview] = useState(false);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [tool, setTool] = useState<EditorTool>("pan");
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [dirtyEntryIds, setDirtyEntryIds] = useState<Set<string>>(new Set());
  const dirtyRef = useRef(new Set<string>());
  const [recoveryDraft, setRecoveryDraft] =
    useState<TranslationDraftRecord | null>(null);
  const recoveryDraftRef = useRef(recoveryDraft);
  recoveryDraftRef.current = recoveryDraft;
  const editorScope = `${user.id}:${workId}`;
  const editorScopeRef = useRef(editorScope);
  const reconciliationSequence = useRef(0);
  const [refreshingScope, setRefreshingScope] = useState<string | null>(null);
  const refreshingScopeRef = useRef<string | null>(null);
  const observedStageHead = useRef<Pick<
    EditorStateSignal,
    "workRevision" | "editorEpoch"
  > | null>(null);
  const stageRefreshTask = useRef<Promise<
    components["schemas"]["TranslationEditorDto"] | undefined
  > | null>(null);
  if (editorScopeRef.current !== editorScope) {
    editorScopeRef.current = editorScope;
    reconciliationSequence.current++;
    refreshingScopeRef.current = null;
    observedStageHead.current = null;
    stageRefreshTask.current = null;
  }
  const stageRefreshing = refreshingScope === editorScope;
  const [draftConflictKind, setDraftConflictKind] =
    useState<DraftConflictKind | null>(null);
  const [draftHydrated, setDraftHydrated] = useState(false);
  const initializedKey = useRef<string | null>(null);
  const saveTimers = useRef(new Map<string, number>());
  const serverMutationQueue = useRef<Promise<void>>(Promise.resolve());
  const stageSubmissionInFlight = useRef(false);
  const entryRefs = useRef(new Map<string, HTMLElement>());
  const entryListRef = useRef<HTMLDivElement>(null);
  const editorMounted = useRef(false);
  const reorderRunning = useRef(false);
  const [reorderPending, setReorderPending] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLElement>(null);
  const markerUndoStack = useRef<MarkerUndo[]>([]);
  const markerCreations = useRef(new Map<string, MarkerUndo>());
  const undoFailure = useRef(0);
  const undoPending = useRef(0);
  const editorHeadRef = useRef({
    workRevision: 0,
    editorEpoch: 0,
    latestVersionId: null as string | null,
  });
  const [creatingEntry, setCreatingEntry] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [presenceMode, setPresenceMode] =
    useState<TranslationPresenceMode | null>(null);
  const [activeParticipants, setActiveParticipants] = useState<
    TranslationPresence[]
  >([]);
  const [labelPlusFile, setLabelPlusFile] = useState<File | null>(null);
  const [labelPlusPreview, setLabelPlusPreview] =
    useState<LabelPlusImportPreview | null>(null);
  const [labelPlusStage, setLabelPlusStage] = useState<WorkStage | null>(null);
  const [labelPlusOperation, setLabelPlusOperation] = useState<
    "preview" | "import" | "export" | null
  >(null);
  const [showReviewDialog, setShowReviewDialog] = useState(false);
  const [reviewReason, setReviewReason] = useState("");
  const [reviewPending, setReviewPending] = useState(false);
  const labelPlusInputRef = useRef<HTMLInputElement>(null);
  const presenceStartedKey = useRef<string | null>(null);
  const drag = useRef<
    | { kind: "pan"; x: number; y: number; startX: number; startY: number }
    | { kind: "marker"; entryId: string }
    | null
  >(null);

  const editor = useQuery({
    queryKey: ["translation-editor", workId],
    queryFn: async ({ signal }) =>
      unwrap(
        await client.GET("/api/works/{workId}/translations", {
          params: { path: { workId } },
          signal,
        }),
      ),
    enabled: Boolean(workId && user.permissions.includes("works:read")),
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const editorDataRef = useRef(editor.data);
  editorDataRef.current = editor.data;

  const currentImage = images[pageIndex];
  const pageNumber = currentImage ? pageIndex + 1 : 0;
  const imageUrl = useQuery({
    queryKey: [...workImageKey(workId, currentImage?.id), "editor"],
    queryFn: async () =>
      unwrap(
        await client.GET("/api/works/{workId}/images/{imageId}/url", {
          params: {
            path: { workId, imageId: currentImage!.id },
          },
        }),
      ),
    enabled: Boolean(currentImage),
    staleTime: 4 * 60 * 1000,
  });
  const [imageRetry, setImageRetry] = useState(0);
  const imageRequestKey = `${currentImage?.id ?? ""}:${imageUrl.data?.url ?? ""}:${imageRetry}`;
  const [imageLoad, setImageLoad] = useState<{
    key: string;
    phase: "loading" | "ready" | "failed";
  }>({ key: imageRequestKey, phase: "loading" });
  if (imageLoad.key !== imageRequestKey)
    setImageLoad({ key: imageRequestKey, phase: "loading" });
  const imageReady =
    imageLoad.key === imageRequestKey && imageLoad.phase === "ready";
  const imageFailed =
    (imageLoad.key === imageRequestKey && imageLoad.phase === "failed") ||
    (!imageUrl.isFetching &&
      (imageUrl.isError ||
        (imageUrl.isSuccess && !isDisplayableImageUrl(imageUrl.data?.url))));

  useEffect(() => {
    drag.current = null;
  }, [imageRequestKey]);

  const currentEntries = useMemo(
    () => currentImage?.entries ?? [],
    [currentImage],
  );
  const hasLocalEntry = images.some((image) =>
    image.entries.some((entry) => entry.localOnly),
  );
  const hasUnsaved = dirtyEntryIds.size > 0 || hasLocalEntry;
  const showingLocalRecovery = Boolean(
    recoveryDraft && images === recoveryDraft.images,
  );
  const pageEditor = editor.data as PageEditor | undefined;
  const pageEditable =
    !pageEditor?.editableImageIds ||
    Boolean(
      currentImage && pageEditor.editableImageIds.includes(currentImage.id),
    );
  const writable = Boolean(
    editor.data?.canEdit &&
    presenceMode === "edit" &&
    !stageRefreshing &&
    !recoveryDraft &&
    pageEditable,
  );
  const canSubmitStage = Boolean(
    editor.data?.canEdit &&
    presenceMode === "edit" &&
    !recoveryDraft &&
    !stageRefreshing,
  );
  function pageAccess(imageId: string) {
    const current = editorDataRef.current as PageEditor | undefined;
    if (refreshingScopeRef.current === editorScope || !current?.canEdit)
      throw new Error("当前阶段没有编辑权限，本地草稿已保留，请核对最新状态。");
    return getPageWriteAccess(current, imageId);
  }
  const stageContentReady =
    editor.data?.submissionStage !== "translate" ||
    (draftHydrated &&
      initializedKey.current === `${user.id}:${workId}` &&
      editor.isSuccess &&
      !editor.isFetching &&
      labelPlusOperation !== "import" &&
      !reviewPending &&
      !reorderPending);
  const confirmation = useConfirmation([
    workId,
    editor.data?.workRevision,
    editor.data?.editorEpoch,
    editor.data?.latestVersion?.id,
    editor.data?.submissionStage,
    editor.data?.reviewStatus,
    editor.data?.multiStageReady,
    editor.data?.canEdit,
    stageContentReady,
    writable,
    images,
    hasUnsaved,
    online,
    saveState,
  ]);
  const writableRef = useRef(writable);
  writableRef.current = writable;
  const referenceScope = `${workId}:${currentImage?.id ?? ""}:${editor.data?.editorEpoch ?? 0}`;
  const markerEditsAvailable = Boolean(
    writable &&
    draftHydrated &&
    initializedKey.current === `${user.id}:${workId}` &&
    labelPlusOperation !== "import" &&
    !reviewPending,
  );
  const markerWorkspaceScope = JSON.stringify([
    user.id,
    workId,
    editor.data?.editorEpoch ?? 0,
    editor.data?.latestVersion?.id ?? null,
  ]);
  const reorderScope = JSON.stringify([
    markerWorkspaceScope,
    currentImage?.id ?? null,
    currentImage?.translationRevision ?? null,
  ]);
  const canReorder =
    markerEditsAvailable &&
    online &&
    currentEntries.length > 1 &&
    !currentEntries.some((entry) => entry.localOnly);
  const reorderContext = useRef({
    workspace: markerWorkspaceScope,
    scope: reorderScope,
    allowed: canReorder,
  });
  reorderContext.current = {
    workspace: markerWorkspaceScope,
    scope: reorderScope,
    allowed: canReorder,
  };
  useEffect(() => {
    editorMounted.current = true;
    return () => {
      editorMounted.current = false;
    };
  }, []);
  const markerReorder = useMarkerReorder({
    ids: currentEntries.map((entry) => entry.id),
    scope: reorderScope,
    listRef: entryListRef,
    disabled: !canReorder || reorderPending,
    caption: (id) =>
      `标记 ${currentEntries.findIndex((entry) => entry.id === id) + 1}`,
    onReorder: (id, beforeId) => void reorderMarker(id, beforeId),
  });
  const symbolInsertion = useSymbolInsertion({
    scope: referenceScope,
    writable,
    selectedEntryId,
    entries: currentEntries,
  });
  useCanvasWheelZoom({
    canvas: canvasRef,
    image: imageRef,
    zoom,
    offset,
    ready: imageReady,
    onChange: (next) => {
      drag.current = null;
      setZoom(next.zoom);
      setOffset(next.offset);
    },
  });
  const submissionStage = editor.data?.submissionStage ?? null;
  const cancelableSubmissionStage =
    editor.data?.collaborationMode === "multi" &&
    submissionStage === "proofread" &&
    editor.data.cancelableSubmissionStage === "translate"
      ? null
      : (editor.data?.cancelableSubmissionStage ?? null);
  const activeUserCount = new Set(
    activeParticipants.map(({ userId }) => userId),
  ).size;
  const activeEditingUserCount = new Set(
    activeParticipants
      .filter(({ mode }) => mode === "edit")
      .map(({ userId }) => userId),
  ).size;
  const labelPlusPending = labelPlusOperation !== null;

  function replaceImages(next: EditableTranslationImage[]) {
    imagesRef.current = next;
    setImages(next);
  }

  function updateImages(
    updater: (
      current: EditableTranslationImage[],
    ) => EditableTranslationImage[],
  ) {
    const next = updater(imagesRef.current);
    replaceImages(next);
  }

  function replaceDirty(next: Set<string>) {
    dirtyRef.current = next;
    setDirtyEntryIds(next);
  }

  async function previewLabelPlus(file: File) {
    if (
      !editor.data ||
      !writable ||
      hasUnsaved ||
      editor.data.reviewStatus !== "normal"
    )
      return;
    const isCurrent = requestStillCurrent();
    if (file.size > 2 * 1024 * 1024) {
      setMessage("LabelPlus 文件不能超过 2 MiB。");
      setSaveState("failed");
      return;
    }
    setLabelPlusOperation("preview");
    setMessage(null);
    const body = new FormData();
    body.append("file", file);
    try {
      const preview = await unwrap(
        await client.POST("/api/works/{workId}/labelplus/imports/preview", {
          params: { path: { workId } },
          body: body as never,
        }),
      );
      if (!isCurrent()) return;
      setLabelPlusFile(file);
      setLabelPlusPreview(preview);
      setLabelPlusStage(
        editor.data.submissionStage ?? editor.data.editStages[0] ?? null,
      );
    } catch (error) {
      if (!isCurrent()) return;
      setSaveState("failed");
      setMessage(error instanceof Error ? error.message : "无法解析 LabelPlus");
    } finally {
      if (isCurrent()) setLabelPlusOperation(null);
    }
  }

  async function confirmLabelPlusImport() {
    const current = editorDataRef.current;
    if (
      !current ||
      !labelPlusFile ||
      !labelPlusPreview?.canImport ||
      !labelPlusStage ||
      labelPlusPending ||
      reorderRunning.current ||
      !writable ||
      hasUnsaved ||
      current.reviewStatus !== "normal"
    ) {
      return;
    }
    const isCurrent = requestStillCurrent();
    setLabelPlusOperation("import");
    setMessage(null);
    const body = new FormData();
    body.append("file", labelPlusFile);
    body.append("stage", labelPlusStage);
    body.append("expectedRevision", String(current.workRevision));
    body.append("expectedEditorEpoch", String(current.editorEpoch));
    body.append("idempotencyKey", crypto.randomUUID());
    body.append("expectedContentBaseline", labelPlusPreview.contentBaseline);
    try {
      const targetIds = [
        ...new Set(
          labelPlusPreview.mappings.map((mapping) => mapping.targetImageId),
        ),
      ];
      if (!isCurrent()) return;
      body.append(
        "pageAccess",
        JSON.stringify(
          targetIds.map((imageId) => ({ imageId, ...pageAccess(imageId) })),
        ),
      );
      const imported = await unwrap(
        await client.POST("/api/works/{workId}/labelplus/imports", {
          params: { path: { workId } },
          body: body as never,
        }),
      );
      if (!isCurrent()) return;
      queryClient.setQueryData(["translation-editor", workId], imported);
      replaceEditorHead(imported);
      replaceImages(imported.images);
      replaceDirty(new Set());
      setPageIndex(0);
      setShowPagePreview(false);
      setSelectedEntryId(null);
      await deleteTranslationDraft(user.id, workId).catch(() => undefined);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["works"] }),
        queryClient.invalidateQueries({ queryKey: ["work", workId] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard-works"] }),
      ]);
      setLabelPlusPreview(null);
      setLabelPlusFile(null);
      setSavedAt(new Date());
      setSaveState("saved");
      setMessage(
        `已导入 ${labelPlusPreview.imageCount} 个图片章节和 ${labelPlusPreview.markerCount} 个标记，并生成正式版本。`,
      );
    } catch (error) {
      if (!isCurrent()) return;
      setSaveState("conflict");
      setMessage(error instanceof Error ? error.message : "LabelPlus 导入失败");
    } finally {
      if (isCurrent()) setLabelPlusOperation(null);
    }
  }

  async function exportLabelPlus() {
    const current = editorDataRef.current;
    if (
      !current ||
      !current.canExportLabelPlus ||
      hasUnsaved ||
      labelPlusPending ||
      reorderRunning.current
    ) {
      return;
    }
    setLabelPlusOperation("export");
    setMessage(null);
    try {
      const exported = await unwrap(
        await client.POST("/api/works/{workId}/labelplus/exports", {
          params: { path: { workId } },
          body: {
            expectedRevision: current.workRevision,
            expectedEditorEpoch: current.editorEpoch,
            idempotencyKey: crypto.randomUUID(),
          },
        }),
      );
      const response = await authenticatedFetch(exported.downloadUrl);
      if (!response.ok) {
        throw new Error("翻译包已生成，但下载失败，请重试");
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = exported.fileName;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
      const refreshed = await editor.refetch();
      if (refreshed.data) {
        replaceEditorHead(refreshed.data);
        replaceImages(refreshed.data.images);
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["work", workId] }),
        queryClient.invalidateQueries({ queryKey: ["works"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard-works"] }),
      ]);
      setMessage(
        `已生成 ${exported.imageCount} 个章节、${exported.markerCount} 个标记的 LabelPlus 文件。`,
      );
    } catch (error) {
      setSaveState("failed");
      setMessage(error instanceof Error ? error.message : "LabelPlus 导出失败");
    } finally {
      setLabelPlusOperation(null);
    }
  }

  async function openReviewCase() {
    const current = editorDataRef.current;
    const trimmedReason = reviewReason.trim();
    if (
      !current ||
      !user.permissions.includes("works:review:raise") ||
      current.workflowStatus === "archived" ||
      current.reviewStatus !== "normal" ||
      !trimmedReason ||
      hasUnsaved ||
      !online ||
      saveState === "syncing" ||
      recoveryDraft ||
      reviewPending
    ) {
      return;
    }
    setReviewPending(true);
    setMessage(null);
    try {
      await unwrap(
        await client.POST("/api/works/{workId}/reviews", {
          params: { path: { workId } },
          body: {
            expectedRevision: current.workRevision,
            idempotencyKey: crypto.randomUUID(),
            reason: trimmedReason,
            expectedEditorEpoch: current.editorEpoch,
          },
        }),
      );
      const refreshed = await editor.refetch();
      if (!refreshed.data)
        throw new Error("审核事项已创建，但刷新作品状态失败");
      setShowReviewDialog(false);
      await refreshReviewViews(workId);
      setReviewReason("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["work", workId] }),
        queryClient.invalidateQueries({ queryKey: ["works"] }),
        queryClient.invalidateQueries({ queryKey: ["reviews"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard-works"] }),
      ]);
      setMessage(
        "内容审核已发起，作品只读挂起；制作与云端保存暂停，本地草稿保留。",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "审核事项创建失败");
      await editor.refetch();
    } finally {
      setReviewPending(false);
    }
  }

  function replaceEditorHead(editorData: {
    workRevision?: number;
    editorEpoch: number;
    latestVersion: { id: string } | null;
  }) {
    markerUndoStack.current = [];
    undoFailure.current++;
    editorHeadRef.current = {
      workRevision:
        editorData.workRevision ?? editorHeadRef.current.workRevision,
      editorEpoch: editorData.editorEpoch,
      latestVersionId: editorData.latestVersion?.id ?? null,
    };
  }

  function applyMutationMeta(
    mutation: components["schemas"]["TranslationMutationMetaDto"] | undefined,
  ) {
    if (!mutation) return;
    editorHeadRef.current = {
      ...editorHeadRef.current,
      workRevision: mutation.workRevision,
      editorEpoch: mutation.editorEpoch,
    };
    queryClient.setQueryData(
      ["translation-editor", workId],
      (current: typeof editor.data) =>
        current
          ? {
              ...current,
              workRevision: mutation.workRevision,
              editorEpoch: mutation.editorEpoch,
              workflowStatus: mutation.workflowStatus,
              submissionStage: mutation.submissionStage,
              cancelableSubmissionStage: null,
            }
          : current,
    );
  }

  function markDirty(entryId: string) {
    const next = new Set(dirtyRef.current).add(entryId);
    replaceDirty(next);
    setSaveState(online ? "local" : "offline");
  }

  function clearDirty(entryId: string) {
    const next = new Set(dirtyRef.current);
    next.delete(entryId);
    replaceDirty(next);
    return next;
  }

  function finishServerMutation() {
    setSavedAt(new Date());
    const stillUnsaved =
      dirtyRef.current.size > 0 ||
      imagesRef.current.some((image) =>
        image.entries.some((entry) => entry.localOnly),
      );
    setSaveState(
      stillUnsaved ? (navigator.onLine ? "local" : "offline") : "saved",
    );
    if (!stillUnsaved && !recoveryDraftRef.current) {
      void deleteTranslationDraft(user.id, workId).catch(() => undefined);
    }
  }

  function resetViewport() {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }

  async function goToPage(nextIndex: number) {
    markerUndoStack.current = [];
    if (!images.length) return;
    const safeIndex = clamp(nextIndex, 0, images.length - 1);
    setPageIndex(safeIndex);
    setSelectedEntryId(null);
    resetViewport();
  }

  function selectEntry(entryId: string, focusText = false) {
    setSelectedEntryId(entryId);
    if (focusText) {
      requestAnimationFrame(() => {
        const card = entryRefs.current.get(entryId);
        card?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
        card?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
      });
    }
  }

  function selectEntryFromShortcut(entryId: string) {
    selectEntry(entryId);
    const list = entryListRef.current;
    const card = entryRefs.current.get(entryId);
    if (!list || !card) return;
    const viewport = list.getBoundingClientRect();
    const row = card.getBoundingClientRect();
    if (row.top < viewport.top) list.scrollTop += row.top - viewport.top;
    else if (row.bottom > viewport.bottom)
      list.scrollTop += Math.min(
        row.bottom - viewport.bottom,
        row.top - viewport.top,
      );
  }

  function requestStillCurrent() {
    const sequence = reconciliationSequence.current;
    return () =>
      editorMounted.current &&
      editorScopeRef.current === editorScope &&
      reconciliationSequence.current === sequence;
  }

  function stageChangeMessage(
    previous: components["schemas"]["TranslationEditorDto"] | undefined,
    latest: components["schemas"]["TranslationEditorDto"],
    operation: "observe" | "cancel" = "observe",
  ) {
    if (
      (previous?.workflowStatus === "pending_proofread" ||
        previous?.workflowStatus === "proofreading") &&
      latest.workflowStatus === "translating"
    )
      return "其他翻译成员已撤回提交，作品已退回翻译中。旧校对编辑已停止；你的翻译提交状态已更新。";
    if (
      latest.workflowStatus === "proofreading" &&
      (operation === "cancel" || previous?.workflowStatus !== "proofreading")
    )
      return "校对已开始保存，翻译提交已不能撤回；已更新当前状态。";
    if (
      [
        "pending_typeset",
        "typesetting",
        "pending_publish",
        "published",
      ].includes(latest.workflowStatus) &&
      (operation === "cancel" ||
        previous?.workflowStatus !== latest.workflowStatus)
    )
      return "校对已提交，翻译提交已不能撤回；已更新当前状态。";
    if (operation === "cancel")
      return "作品阶段或版本已变化，本次未能取消提交；已更新当前状态。";
    if (
      previous?.workflowStatus === latest.workflowStatus &&
      previous.reviewStatus === latest.reviewStatus &&
      previous.editorEpoch === latest.editorEpoch &&
      previous.latestVersion?.id === latest.latestVersion?.id
    )
      return "本页编辑权限已变化，已读取当前阶段；本地草稿保留供核对。";
    return "作品阶段或正式版本已变化，已更新当前状态，请核对后继续。";
  }

  function refreshStageState(
    reason?: string,
    signal?: Pick<EditorStateSignal, "workRevision" | "editorEpoch">,
  ) {
    if (signal)
      observedStageHead.current = {
        workRevision: Math.max(
          observedStageHead.current?.workRevision ?? 0,
          signal.workRevision,
        ),
        editorEpoch: Math.max(
          observedStageHead.current?.editorEpoch ?? 0,
          signal.editorEpoch,
        ),
      };
    if (stageRefreshTask.current) return stageRefreshTask.current;
    const previous = editorDataRef.current;
    reconciliationSequence.current++;
    const isCurrent = requestStillCurrent();
    refreshingScopeRef.current = editorScope;
    setRefreshingScope(editorScope);
    markerUndoStack.current = [];
    undoFailure.current++;
    setCreatingEntry(false);
    setLabelPlusOperation(null);
    drag.current = null;
    for (const timer of saveTimers.current.values()) window.clearTimeout(timer);
    saveTimers.current.clear();
    const localDraft =
      recoveryDraftRef.current ??
      (dirtyRef.current.size ||
      imagesRef.current.some((image) =>
        image.entries.some((entry) => entry.localOnly),
      )
        ? createTranslationDraft(
            user.id,
            workId,
            imagesRef.current,
            editorHeadRef.current,
            Date.now(),
            dirtyRef.current,
          )
        : null);
    if (localDraft) {
      recoveryDraftRef.current = localDraft;
      setRecoveryDraft(localDraft);
      setDraftConflictKind("epoch");
      replaceDirty(new Set());
      void saveTranslationDraft(localDraft).catch(() => undefined);
    }
    setSaveState("conflict");
    setMessage(reason ?? "正在读取当前阶段，旧编辑已暂停。");
    const task = (async () => {
      try {
        await queryClient.cancelQueries({
          queryKey: ["translation-editor", workId],
          exact: true,
        });
        if (!isCurrent()) return;
        const latest = await unwrap(
          await client.GET("/api/works/{workId}/translations", {
            params: { path: { workId } },
          }),
        );
        if (!isCurrent()) return;
        if (
          latest.workRevision < editorHeadRef.current.workRevision ||
          latest.editorEpoch < editorHeadRef.current.editorEpoch ||
          latest.workRevision <
            (observedStageHead.current?.workRevision ?? 0) ||
          latest.editorEpoch < (observedStageHead.current?.editorEpoch ?? 0)
        )
          throw new Error("读取到旧的作品状态，请稍后重试；本地草稿已保留。");
        queryClient.setQueryData(["translation-editor", workId], latest);
        editorDataRef.current = latest;
        setPresenceMode(latest.canEdit ? "edit" : "view");
        replaceEditorHead(latest);
        replaceImages(localDraft ? localDraft.images : latest.images);
        setLabelPlusPreview(null);
        setLabelPlusFile(null);
        refreshingScopeRef.current = null;
        setRefreshingScope(null);
        setSaveState(localDraft ? "conflict" : "saved");
        setMessage(reason ?? stageChangeMessage(previous, latest));
        return latest;
      } catch (error) {
        if (isCurrent())
          setMessage(
            error instanceof Error
              ? error.message
              : "无法读取当前阶段；旧编辑已暂停，本地草稿仍保留，请重试。",
          );
      } finally {
        if (isCurrent()) stageRefreshTask.current = null;
      }
    })();
    stageRefreshTask.current = task;
    return task;
  }

  const refreshStageStateRef = useRef(refreshStageState);
  refreshStageStateRef.current = refreshStageState;
  const observeEditorState = useRef<
    (signal: Partial<EditorStateSignal>) => Promise<void>
  >(() => Promise.resolve());
  observeEditorState.current = async (signal) => {
    const current = editorDataRef.current;
    if (
      !current ||
      initializedKey.current !== editorScope ||
      typeof signal.workRevision !== "number" ||
      typeof signal.editorEpoch !== "number" ||
      !signal.workflowStatus ||
      !signal.reviewStatus ||
      signal.workRevision < editorHeadRef.current.workRevision ||
      signal.editorEpoch < editorHeadRef.current.editorEpoch
    )
      return;
    if (
      current.workflowStatus === "pending_translate" &&
      signal.workflowStatus === "translating" &&
      signal.editorEpoch === editorHeadRef.current.editorEpoch &&
      signal.reviewStatus === current.reviewStatus &&
      refreshingScopeRef.current !== editorScope
    ) {
      const next = {
        ...current,
        workflowStatus: signal.workflowStatus,
        workRevision: signal.workRevision,
      };
      editorDataRef.current = next;
      replaceEditorHead(next);
      queryClient.setQueryData(["translation-editor", workId], next);
      return;
    }
    if (
      signal.workflowStatus !== current.workflowStatus ||
      signal.reviewStatus !== current.reviewStatus ||
      signal.editorEpoch !== editorHeadRef.current.editorEpoch ||
      refreshingScopeRef.current === editorScope
    )
      await refreshStageState(undefined, {
        workRevision: signal.workRevision,
        editorEpoch: signal.editorEpoch,
      });
  };

  async function enterConflict(
    localImages: EditableTranslationImage[],
    reason: string,
    isCurrent: () => boolean = () => true,
  ) {
    if (!isCurrent()) return;
    const currentScope = editorScope;
    const sequence = ++reconciliationSequence.current;
    const previous = editorDataRef.current;
    const conflictIsCurrent = () =>
      editorMounted.current &&
      editorScopeRef.current === currentScope &&
      sequence === reconciliationSequence.current;
    markerUndoStack.current = [];
    undoFailure.current++;
    for (const timer of saveTimers.current.values()) window.clearTimeout(timer);
    saveTimers.current.clear();
    setMessage(reason);
    setSaveState("conflict");
    setDraftConflictKind("content");
    const localDraft =
      recoveryDraftRef.current ??
      createTranslationDraft(
        user.id,
        workId,
        localImages,
        editorHeadRef.current,
        Date.now(),
        dirtyRef.current,
      );
    setRecoveryDraft(localDraft);
    recoveryDraftRef.current = localDraft;
    replaceDirty(new Set());
    await saveTranslationDraft(localDraft).catch(() => undefined);
    if (!conflictIsCurrent()) return;
    try {
      const latest = await unwrap(
        await client.GET("/api/works/{workId}/translations", {
          params: { path: { workId } },
        }),
      );
      if (!conflictIsCurrent()) return;
      const crossedEpoch =
        latest.editorEpoch !== (localDraft.editorEpoch ?? 0) ||
        (latest.latestVersion?.id ?? null) !==
          (localDraft.latestVersionId ?? null);
      setDraftConflictKind(crossedEpoch ? "epoch" : "content");
      queryClient.setQueryData(["translation-editor", workId], latest);
      replaceEditorHead(latest);
      const rolledBack =
        (previous?.workflowStatus === "pending_proofread" ||
          previous?.workflowStatus === "proofreading") &&
        latest.workflowStatus === "translating";
      replaceImages(rolledBack ? localDraft.images : latest.images);
      if (rolledBack) setMessage(stageChangeMessage(previous, latest));
    } catch {
      if (conflictIsCurrent())
        setMessage("检测到版本冲突，同时无法重新读取服务端内容。请稍后重试。");
    }
  }

  async function reconcileServerImage(
    serverImage: TranslationImage,
    acknowledgedLocalEntryId?: string,
    conflictMessage = "图片标记已保存，但尚未同步的译文已被其他参与者修改或删除。本地原稿已保留供核对。",
  ) {
    const local = imagesRef.current.find(
      (image) => image.id === serverImage.id,
    );
    const merged = mergeServerImage(
      serverImage,
      local,
      dirtyRef.current,
      acknowledgedLocalEntryId,
    );
    const next = imagesRef.current.map((image) =>
      image.id === serverImage.id ? merged.image : image,
    );
    replaceImages(next);
    if (merged.conflictedEntryIds.size) {
      await enterConflict(next, conflictMessage);
      return false;
    }
    return true;
  }

  function enqueueServerMutation<T>(operation: () => Promise<T>): Promise<T> {
    const queued = serverMutationQueue.current.then(operation, operation);
    serverMutationQueue.current = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  function saveEntry(entryId: string) {
    const isCurrent = requestStillCurrent();
    return enqueueServerMutation(() =>
      isCurrent() ? performSaveEntry(entryId) : Promise.resolve(),
    );
  }

  async function performSaveEntry(entryId: string) {
    if (
      refreshingScopeRef.current === editorScope ||
      !editorDataRef.current?.canEdit
    )
      return;
    const isCurrent = requestStillCurrent();
    const entry = imagesRef.current
      .flatMap((image) => image.entries)
      .find((item) => item.id === entryId);
    if (!entry || entry.localOnly || !dirtyRef.current.has(entryId)) return;
    const image = imagesRef.current.find((image) =>
      image.entries.some((item) => item.id === entryId),
    );
    const access = editorDataRef.current as PageEditor | undefined;
    if (
      access?.editableImageIds &&
      (!image || !access.editableImageIds.includes(image.id))
    ) {
      setSaveState("conflict");
      setMessage("此页分工或提交状态已变化，本地草稿保留，请刷新后核对。");
      return;
    }
    if (!navigator.onLine) {
      setSaveState("offline");
      return;
    }
    const sent = { ...entry };
    setSaveState("syncing");
    setMessage(null);
    try {
      const result = await client.PATCH("/api/translation-entries/{entryId}", {
        params: { path: { entryId } },
        body: {
          ...pageAccess(
            imagesRef.current.find((image) =>
              image.entries.some((item) => item.id === entryId),
            )!.id,
          ),
          expectedRevision: sent.revision,
          expectedEditorEpoch: editorHeadRef.current.editorEpoch,
          markerX: sent.markerX,
          markerY: sent.markerY,
          markerPositionType: sent.markerPositionType,
          translatedText: sent.translatedText,
          note: sent.note?.trim() || null,
        },
      });
      if (!isCurrent()) return;
      if (result.response.status === 409) {
        await enterConflict(
          imagesRef.current,
          "此条目已被其他参与者更新。请选择服务端内容，或明确重新应用本地译文。",
          isCurrent,
        );
        return;
      }
      const saved = await unwrap(result);
      applyMutationMeta(saved.mutation);
      const current = imagesRef.current
        .flatMap((image) => image.entries)
        .find((item) => item.id === entryId);
      const changedWhileSaving = Boolean(
        current && !entryContentMatches(current, sent),
      );
      updateImages((allImages) =>
        allImages.map((image) => ({
          ...image,
          entries: image.entries.map((item) =>
            item.id === entryId
              ? changedWhileSaving && current
                ? { ...current, revision: saved.revision }
                : saved
              : item,
          ),
        })),
      );
      if (changedWhileSaving) {
        setSaveState(navigator.onLine ? "local" : "offline");
        scheduleSave(entryId);
      } else {
        clearDirty(entryId);
        finishServerMutation();
      }
    } catch (error) {
      if (!isCurrent()) return;
      setMessage(error instanceof Error ? error.message : "保存失败");
      setSaveState(navigator.onLine ? "failed" : "offline");
    }
  }

  function scheduleSave(entryId: string) {
    const previous = saveTimers.current.get(entryId);
    if (previous) window.clearTimeout(previous);
    saveTimers.current.set(
      entryId,
      window.setTimeout(() => {
        saveTimers.current.delete(entryId);
        void saveEntry(entryId);
      }, autosaveDelay),
    );
  }

  function updateEntry(
    entryId: string,
    update: Partial<EditableTranslationEntry>,
    debounce = true,
  ) {
    if (
      !writableRef.current ||
      recoveryDraftRef.current ||
      refreshingScopeRef.current === editorScope
    )
      return;
    updateImages((allImages) =>
      allImages.map((image) => ({
        ...image,
        entries: image.entries.map((entry) =>
          entry.id === entryId ? { ...entry, ...update } : entry,
        ),
      })),
    );
    markDirty(entryId);
    if (debounce) scheduleSave(entryId);
  }

  function changeMarkerPosition(entryId: string, value: string) {
    if (
      !markerEditsAvailable ||
      !writableRef.current ||
      stageSubmissionInFlight.current ||
      (value !== "inside" && value !== "outside")
    )
      return;
    const entry = imagesRef.current
      .find((image) => image.id === currentImage?.id)
      ?.entries.find((item) => item.id === entryId);
    if (!entry || entry.localOnly || entry.markerPositionType === value) return;
    markerUndoStack.current = [];
    selectEntry(entry.id);
    updateEntry(entry.id, { markerPositionType: value });
  }

  async function reorderMarker(entryId: string, beforeMarkerId: string | null) {
    if (!currentImage || !canReorder || reorderRunning.current) return;
    const { id: imageId, translationRevision } = currentImage;
    const { editorEpoch, latestVersionId } = editorHeadRef.current;
    const ordered = currentImage.entries.map((entry) => entry.id);
    const next = ordered.filter((id) => id !== entryId);
    const target =
      beforeMarkerId === null ? next.length : next.indexOf(beforeMarkerId);
    if (next.length === ordered.length || target < 0) return;
    next.splice(target, 0, entryId);
    if (next.every((id, index) => id === ordered[index])) return;
    const isCurrent = requestStillCurrent();
    const sameWorkspace = () =>
      isCurrent() &&
      editorMounted.current &&
      reorderContext.current.workspace === markerWorkspaceScope &&
      editorHeadRef.current.editorEpoch === editorEpoch &&
      editorHeadRef.current.latestVersionId === latestVersionId;
    reorderRunning.current = true;
    setReorderPending(true);
    markerUndoStack.current = [];
    try {
      await enqueueServerMutation(async () => {
        if (!sameWorkspace()) return;
        const live = imagesRef.current.find((image) => image.id === imageId);
        if (
          !reorderContext.current.allowed ||
          reorderContext.current.scope !== reorderScope ||
          !writableRef.current ||
          !navigator.onLine ||
          stageSubmissionInFlight.current ||
          !live ||
          live.translationRevision !== translationRevision ||
          live.entries.length !== ordered.length ||
          live.entries.some(
            (entry, index) => entry.localOnly || entry.id !== ordered[index],
          )
        ) {
          setMessage("标记顺序或编辑状态已变化，请重新调整。");
          return;
        }
        setSaveState("syncing");
        setMessage(null);
        let rejected = false;
        try {
          const result = await client.POST(
            "/api/work-images/{imageId}/markers/{entryId}/reorder",
            {
              params: { path: { imageId, entryId } },
              body: {
                beforeMarkerId,
                ...pageAccess(imageId),
                expectedImageRevision: translationRevision,
                expectedEditorEpoch: editorEpoch,
              },
            },
          );
          if (!sameWorkspace()) return;
          if (result.response.status === 409) {
            await enterConflict(
              imagesRef.current,
              "标记顺序或编辑版本已变化，请核对服务端内容。",
              sameWorkspace,
            );
            return;
          }
          rejected =
            result.response.status >= 400 && result.response.status < 500;
          const savedImage = await unwrap(result);
          if (
            savedImage.id !== imageId ||
            savedImage.translationRevision !== translationRevision + 1 ||
            savedImage.entries.length !== next.length ||
            savedImage.entries.some((entry, index) => entry.id !== next[index])
          )
            throw new Error("服务端未返回已确认的标记顺序");
          applyMutationMeta(savedImage.mutation);
          if (
            !(await reconcileServerImage(
              savedImage,
              undefined,
              "标记顺序已保存，但有译文同时被其他参与者修改。请确认保留哪一版译文。",
            ))
          )
            return;
          finishServerMutation();
        } catch (error) {
          if (!sameWorkspace()) return;
          if (!rejected) {
            await enterConflict(
              imagesRef.current,
              "无法确认排序结果，请核对服务端顺序。",
              sameWorkspace,
            );
            return;
          }
          setMessage(
            error instanceof Error ? error.message : "标记顺序保存失败",
          );
          setSaveState("failed");
        }
      });
    } finally {
      reorderRunning.current = false;
      if (editorMounted.current) setReorderPending(false);
    }
  }

  function syncCreatedEntry(entryId: string) {
    const isCurrent = requestStillCurrent();
    return enqueueServerMutation(() =>
      isCurrent() ? performSyncCreatedEntry(entryId) : Promise.resolve(),
    );
  }

  async function performSyncCreatedEntry(entryId: string) {
    if (
      refreshingScopeRef.current === editorScope ||
      !editorDataRef.current?.canEdit
    )
      return;
    const isCurrent = requestStillCurrent();
    const image = imagesRef.current.find((item) =>
      item.entries.some((entry) => entry.id === entryId),
    );
    const entry = image?.entries.find((item) => item.id === entryId);
    if (!image || !entry?.localOnly || !entry.idempotencyKey) return;
    if (!navigator.onLine) {
      setSaveState("offline");
      return;
    }
    setCreatingEntry(true);
    setSaveState("syncing");
    setMessage(null);
    const knownServerIds = new Set(
      image.entries.filter((item) => !item.localOnly).map((item) => item.id),
    );
    const creation = markerCreations.current.get(entryId);
    if (creation) creation.uncertain = true;
    try {
      const result = await client.POST("/api/work-images/{imageId}/markers", {
        params: { path: { imageId: image.id } },
        body: {
          ...pageAccess(image.id),
          markerX: entry.markerX,
          markerY: entry.markerY,
          markerPositionType: entry.markerPositionType,
          expectedImageRevision: image.translationRevision,
          expectedEditorEpoch: editorHeadRef.current.editorEpoch,
          idempotencyKey: entry.idempotencyKey,
        },
      });
      if (!isCurrent()) return;
      if (result.response.status === 409) {
        await enterConflict(
          imagesRef.current,
          "图片标记已被其他参与者调整，本地新标记未覆盖服务端顺序。",
        );
        return;
      }
      const savedImage = await unwrap(result);
      applyMutationMeta(savedImage.mutation);
      const additions = savedImage.entries.filter(
        (item) => !knownServerIds.has(item.id),
      );
      const created =
        additions.length === 1 && additions[0].createdById === user.id
          ? additions[0]
          : undefined;
      if (creation && created) {
        creation.entryId = created.id;
        creation.revision = created.revision;
        creation.epoch = editorHeadRef.current.editorEpoch;
        creation.uncertain = false;
      } else if (creation) {
        markerUndoStack.current = [];
        undoFailure.current++;
        setMessage("云端标点已变化，已停止连续撤销，请检查当前图片。");
      }
      clearDirty(entryId);
      setSelectedEntryId(created?.id ?? null);
      if (!(await reconcileServerImage(savedImage, entryId))) return;
      finishServerMutation();
    } catch (error) {
      if (!isCurrent()) return;
      setMessage(error instanceof Error ? error.message : "标记创建失败");
      setSaveState(navigator.onLine ? "failed" : "offline");
    } finally {
      if (isCurrent()) setCreatingEntry(false);
    }
  }

  function createEntry(
    markerPositionType: MarkerPosition,
    x: number,
    y: number,
  ) {
    const liveImage = imagesRef.current.find(
      (image) => image.id === currentImage?.id,
    );
    if (
      !liveImage ||
      !writable ||
      creatingEntry ||
      reorderRunning.current ||
      undoPending.current > 0 ||
      liveImage.entries.some((entry) => entry.localOnly)
    ) {
      return;
    }
    const id = `${localIdPrefix}${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const entry: EditableTranslationEntry = {
      id,
      workImageId: liveImage.id,
      orderIndex: liveImage.entries.length,
      markerX: x,
      markerY: y,
      markerPositionType,
      translatedText: "",
      note: null,
      revision: 0,
      createdById: user.id,
      updatedById: user.id,
      createdAt: now,
      updatedAt: now,
      localOnly: true,
      idempotencyKey: crypto.randomUUID(),
    };
    const next = imagesRef.current.map((image) =>
      image.id === liveImage.id
        ? { ...image, entries: [...image.entries, entry] }
        : image,
    );
    replaceImages(next);
    const undo: MarkerUndo = {
      entryId: id,
      imageId: liveImage.id,
      epoch: editorHeadRef.current.editorEpoch,
      revision: 0,
      uncertain: false,
    };
    markerCreations.current.set(id, undo);
    markerUndoStack.current.push(undo);
    markDirty(id);
    setSelectedEntryId(id);
    void syncCreatedEntry(id);
  }

  function removeEntry(entry: EditableTranslationEntry) {
    markerUndoStack.current = [];
    const isCurrent = requestStillCurrent();
    return enqueueServerMutation(async () => {
      if (
        !isCurrent() ||
        refreshingScopeRef.current === editorScope ||
        !editorDataRef.current?.canEdit
      )
        return;
      const creation = markerCreations.current.get(entry.id);
      const id = creation?.entryId ?? entry.id;
      const image = imagesRef.current.find((image) =>
        image.entries.some((entry) => entry.id === id),
      );
      const latest = image?.entries.find((entry) => entry.id === id);
      if (image && latest) await performRemoveEntry(latest, image, creation);
    });
  }

  async function performRemoveEntry(
    entry: EditableTranslationEntry,
    image: EditableTranslationImage,
    creation?: MarkerUndo,
  ) {
    const isCurrent = requestStillCurrent();
    if (entry.localOnly) {
      if (creation?.uncertain) {
        setMessage("创建结果尚未确认，请先同步标点，再使用删除按钮。");
        return false;
      }
      updateImages((allImages) =>
        allImages.map((image) => ({
          ...image,
          entries: image.entries.filter((item) => item.id !== entry.id),
        })),
      );
      clearDirty(entry.id);
      setSelectedEntryId(null);
      finishServerMutation();
      return true;
    }
    if (
      entry.translatedText.trim() &&
      !(await confirmation.confirm({
        title: "删除已有译文的标记？",
        description: "这个标记已有译文，删除后该标记及译文会一并移除。",
        confirmLabel: "删除标记",
        danger: true,
      }))
    ) {
      return false;
    }
    if (!navigator.onLine) {
      setMessage("离线时不能删除已同步标点，请联网后重试。");
      return false;
    }
    setSaveState("syncing");
    try {
      const result = await client.DELETE("/api/translation-entries/{entryId}", {
        params: { path: { entryId: entry.id } },
        body: {
          ...pageAccess(image.id),
          expectedRevision: entry.revision,
          expectedImageRevision: image.translationRevision,
          expectedEditorEpoch: editorHeadRef.current.editorEpoch,
        },
      });
      if (!isCurrent()) return false;
      if (result.response.status === 409) {
        await enterConflict(imagesRef.current, "删除前条目或图片顺序已更新。");
        return false;
      }
      const savedImage = await unwrap(result);
      applyMutationMeta(savedImage.mutation);
      clearDirty(entry.id);
      setSelectedEntryId(null);
      if (!(await reconcileServerImage(savedImage))) return false;
      finishServerMutation();
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      setMessage(error instanceof Error ? error.message : "删除失败");
      setSaveState("failed");
      return false;
    }
  }

  function undoMarker() {
    if (
      !writableRef.current ||
      (tool !== "add-inside" && tool !== "add-outside")
    )
      return false;
    const record = markerUndoStack.current.pop();
    if (!record) return false;
    const failure = undoFailure.current;
    undoPending.current++;
    void enqueueServerMutation(async () => {
      if (failure !== undoFailure.current) return;
      const image = imagesRef.current.find(
        (image) => image.id === record.imageId,
      );
      const entry = image?.entries.find((entry) => entry.id === record.entryId);
      if (
        !writableRef.current ||
        record.epoch !== editorHeadRef.current.editorEpoch ||
        !image ||
        !entry ||
        entry.revision !== record.revision ||
        entry.translatedText ||
        entry.note
      ) {
        markerUndoStack.current = [];
        undoFailure.current++;
        setMessage("标点、权限或内容版本已变化，已停止连续撤销。");
        return;
      }
      if (!(await performRemoveEntry(entry, image, record))) {
        markerUndoStack.current = [];
        undoFailure.current++;
      }
    }).finally(() => {
      undoPending.current--;
    });
    return true;
  }

  async function syncAll() {
    for (const entry of imagesRef.current.flatMap((image) => image.entries)) {
      if (entry.localOnly) await syncCreatedEntry(entry.id);
      else if (dirtyRef.current.has(entry.id)) await saveEntry(entry.id);
    }
  }

  async function submitCurrentStage() {
    if (
      stageSubmissionInFlight.current ||
      reorderRunning.current ||
      !stageContentReady ||
      !editor.data ||
      !submissionStage ||
      !canSubmitStage ||
      !online ||
      saveState === "syncing" ||
      editor.data.reviewStatus !== "normal"
    ) {
      return;
    }
    const isCurrent = requestStillCurrent();
    stageSubmissionInFlight.current = true;
    try {
      await syncAll();
      if (!isCurrent()) return;
      if (
        dirtyRef.current.size ||
        imagesRef.current.some((image) =>
          image.entries.some((entry) => entry.localOnly),
        )
      )
        throw new Error("保存尚未完成，不能提交。请先处理保存失败或版本冲突。");
      let pageHeads:
        | { imageId: string; generation: number; draftRevision: number }[]
        | undefined;
      const before = editorDataRef.current as PageEditor | undefined;
      const pendingBefore =
        before?.pageAssignments?.filter(
          (page) => page.userId === user.id && !page.submittedAt,
        ) ?? [];
      if (
        submissionStage === "translate" &&
        pendingBefore.some((page) => page.draftRevision !== undefined)
      ) {
        const refreshed = await editor.refetch();
        if (!isCurrent()) return;
        if (!refreshed.data) throw new Error("无法读取提交版本，请重试。");
        if (
          dirtyRef.current.size ||
          imagesRef.current.some((image) =>
            image.entries.some((entry) => entry.localOnly),
          )
        )
          throw new Error("同步期间内容又有修改，请重新提交；本地输入已保留。");
        const latest = refreshed.data as PageEditor;
        const pending =
          latest.pageAssignments?.filter(
            (page) => page.userId === user.id && !page.submittedAt,
          ) ?? [];
        const changed =
          pending.length !== pendingBefore.length ||
          pending.some((page) => {
            const previous = pendingBefore.find(
              (row) => row.workImageId === page.workImageId,
            );
            const local = imagesRef.current.find(
              (image) => image.id === page.workImageId,
            );
            const cloud = latest.images.find(
              (image) => image.id === page.workImageId,
            );
            return (
              !previous ||
              previous.generation !== page.generation ||
              !local ||
              !cloud ||
              local.entries.length !== cloud.entries.length ||
              local.entries.some(
                (entry, index) =>
                  entry.id !== cloud.entries[index]?.id ||
                  !entryContentMatches(entry, cloud.entries[index]),
              )
            );
          });
        replaceEditorHead(latest);
        replaceImages(latest.images);
        if (changed || latest.submissionStage !== "translate")
          throw new Error(
            "云端负责页或归属已变化，已载入最新内容。请核对后重新提交。",
          );
        pageHeads = pending.map((page) => ({
          imageId: page.workImageId,
          generation: page.generation,
          draftRevision: page.draftRevision!,
        }));
      }
      // Let autosave metadata and draft controls commit before pinning confirmation.
      // Otherwise the successful save itself immediately invalidates the dialog.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      if (!isCurrent()) return;
      const warnings =
        submissionStage === "translate"
          ? checkTranslationPunctuation(
              imagesRef.current.filter(
                (image) =>
                  !editor.data?.assignedImageIds.length ||
                  editor.data.assignedImageIds.includes(image.id),
              ),
            )
          : [];
      if (
        (submissionStage !== "translate" || warnings.length > 0) &&
        !(await confirmation.confirm({
          title: `提交${submissionStage === "translate" ? "翻译" : "校对"}阶段？`,
          description:
            submissionStage === "translate"
              ? "提交本人待提交页，全部必需页交齐后自动进入待校对。"
              : "提交当前云端完整校对版本，其他校对不必逐人确认完成。",
          confirmLabel: warnings.length ? "仍然提交" : "确认提交",
          ...(warnings.length > 0 && {
            cancelLabel: "返回修改",
            details: <SubmissionPunctuationWarnings results={warnings} />,
          }),
        }))
      )
        return;
      if (!isCurrent()) return;
      setSaveState("syncing");
      setMessage(null);
      const result = await client.POST("/api/works/{id}/stages/submit", {
        params: { path: { id: workId } },
        body: {
          stage: submissionStage,
          ...(pageHeads && { pageHeads }),
          expectedRevision: editorHeadRef.current.workRevision,
          expectedEditorEpoch: editorHeadRef.current.editorEpoch,
          idempotencyKey: crypto.randomUUID(),
        },
      });
      if (!isCurrent()) return;
      if (result.response.status === 409) {
        setSaveState("conflict");
        setMessage("云端作品状态或正式版本已经变化，请重新加载后确认。");
        const refreshed = await editor.refetch();
        if (refreshed.data) {
          replaceEditorHead(refreshed.data);
          replaceImages(refreshed.data.images);
        }
        return;
      }
      const updatedWork = await unwrap(result);
      queryClient.setQueryData(["work", workId], updatedWork);
      await deleteTranslationDraft(user.id, workId).catch(() => undefined);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["works"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard-works"] }),
      ]);
      const refreshed = await editor.refetch();
      if (refreshed.data) {
        replaceEditorHead(refreshed.data);
        replaceImages(refreshed.data.images);
      }
      replaceDirty(new Set());
      setSavedAt(new Date());
      setSaveState("saved");
      setMessage(
        submissionStage === "translate"
          ? "本人负责页已提交；全部必需页交齐后自动待校对。"
          : "校对完整云端版本已提交。",
      );
    } catch (error) {
      if (!isCurrent()) return;
      setSaveState("failed");
      setMessage(error instanceof Error ? error.message : "阶段提交失败");
    } finally {
      stageSubmissionInFlight.current = false;
    }
  }

  async function cancelCurrentSubmission() {
    if (
      refreshingScopeRef.current === editorScope ||
      stageSubmissionInFlight.current ||
      !editor.data ||
      !cancelableSubmissionStage ||
      hasUnsaved ||
      !online ||
      saveState === "syncing"
    ) {
      return;
    }
    const isCurrent = requestStillCurrent();
    if (
      !(await confirmation.confirm({
        title: `取消${stageCopy(cancelableSubmissionStage)}提交？`,
        description: `已保存内容和不可变版本会保留，作品将回退到${stageCopy(cancelableSubmissionStage)}中。`,
        confirmLabel: "取消提交",
        danger: true,
      }))
    ) {
      return;
    }
    if (!isCurrent()) return;
    stageSubmissionInFlight.current = true;
    setSaveState("syncing");
    setMessage(null);
    try {
      const result = await client.POST(
        "/api/works/{id}/stages/submission/cancel",
        {
          params: { path: { id: workId } },
          body: {
            stage: cancelableSubmissionStage as "translate" | "proofread",
            expectedRevision: editor.data.workRevision,
            expectedEditorEpoch: editor.data.editorEpoch,
            idempotencyKey: crypto.randomUUID(),
          },
        },
      );
      if (!isCurrent()) return;
      if (result.response.status === 409) {
        setSaveState("conflict");
        const latest = await refreshStageState();
        if (latest) {
          setSaveState("conflict");
          setMessage(stageChangeMessage(editor.data, latest, "cancel"));
        }
        return;
      }
      const updatedWork = await unwrap(result);
      queryClient.setQueryData(["work", workId], updatedWork);
      await deleteTranslationDraft(user.id, workId).catch(() => undefined);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["works"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard-works"] }),
      ]);
      const refreshed = await editor.refetch();
      if (refreshed.data) {
        replaceEditorHead(refreshed.data);
        replaceImages(refreshed.data.images);
      }
      replaceDirty(new Set());
      setSavedAt(new Date());
      setSaveState("saved");
      setMessage(
        `${stageCopy(cancelableSubmissionStage)}提交已取消，可以继续修改。`,
      );
    } catch (error) {
      if (!isCurrent()) return;
      setSaveState("failed");
      setMessage(error instanceof Error ? error.message : "取消提交失败");
    } finally {
      stageSubmissionInFlight.current = false;
    }
  }

  function pointFromEvent(event: ReactPointerEvent, allowOutside = false) {
    const rectangle = imageRef.current?.getBoundingClientRect();
    if (!rectangle || rectangle.width === 0 || rectangle.height === 0)
      return null;
    if (
      !allowOutside &&
      (event.clientX < rectangle.left ||
        event.clientX > rectangle.right ||
        event.clientY < rectangle.top ||
        event.clientY > rectangle.bottom)
    ) {
      return null;
    }
    return {
      x: normalizeMarkerCoordinate(
        clamp((event.clientX - rectangle.left) / rectangle.width, 0, 1),
      ),
      y: normalizeMarkerCoordinate(
        clamp((event.clientY - rectangle.top) / rectangle.height, 0, 1),
      ),
    };
  }

  function selectTool(value: EditorTool) {
    markerUndoStack.current = [];
    setTool(value);
  }

  function toolShortcut(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (
      event.defaultPrevented ||
      event.repeat ||
      shortcutComposing.current ||
      event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229 ||
      !draftHydrated ||
      recoveryDraft ||
      !currentImage ||
      drag.current ||
      markerReorder.dragActiveRef.current ||
      document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')
    )
      return;
    const target = event.target;
    if (
      !(target instanceof Element) ||
      target.closest(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="spinbutton"], [role="slider"]',
      )
    )
      return;
    const captured = captureShortcut(event.nativeEvent);
    if (!captured || !("shortcut" in captured)) return;
    const next = tools.find(
      (item) => shortcuts.bindings[item.value] === captured.shortcut,
    );
    if (next) {
      if (
        !target.closest(".translation-canvas, .translation-tool-group") ||
        (!imageReady && next.value !== "pan") ||
        (!writable && next.value !== "pan") ||
        (reorderRunning.current &&
          (next.value === "add-inside" || next.value === "add-outside"))
      )
        return;
      if (
        !target.closest(".translation-tool-group") &&
        isShortcutControl(target)
      )
        return;
      event.preventDefault();
      // Tool changes remount marker tooltips; retain a stable keyboard target.
      if (target.closest(".translation-marker"))
        canvasRef.current?.focus({ preventScroll: true });
      selectTool(next.value);
      return;
    }
    if (
      !target.closest(".translation-canvas, .translation-entry-list") ||
      isShortcutControl(target)
    )
      return;
    const key = captured.shortcut;
    if (
      key === shortcuts.bindings["previous-page"] ||
      key === shortcuts.bindings["next-page"]
    ) {
      event.preventDefault();
      const nextPage =
        pageIndex + (key === shortcuts.bindings["previous-page"] ? -1 : 1);
      if (nextPage >= 0 && nextPage < images.length) {
        // A marker may unmount when changing pages; retain the keyboard scope.
        if (target.closest(".translation-marker"))
          canvasRef.current?.focus({ preventScroll: true });
        goToPage(nextPage);
      }
    } else if (
      key === shortcuts.bindings["previous-marker"] ||
      key === shortcuts.bindings["next-marker"]
    ) {
      event.preventDefault();
      const index = currentEntries.findIndex(
        (entry) => entry.id === selectedEntryId,
      );
      const previous = key === shortcuts.bindings["previous-marker"];
      const nextIndex =
        index === -1
          ? previous
            ? currentEntries.length - 1
            : 0
          : index + (previous ? -1 : 1);
      const entry = currentEntries[nextIndex];
      if (entry) selectEntryFromShortcut(entry.id);
    }
  }

  function stagePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest(".translation-page-controls")) {
      return;
    }
    if (!imageReady) return;
    if (tool === "pan") {
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = {
        kind: "pan",
        x: event.clientX,
        y: event.clientY,
        startX: offset.x,
        startY: offset.y,
      };
      return;
    }
    if (
      (tool === "add-inside" || tool === "add-outside") &&
      !(event.target as HTMLElement).closest(".translation-marker")
    ) {
      const point = pointFromEvent(event);
      if (point) {
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        createEntry(
          tool === "add-inside" ? "inside" : "outside",
          point.x,
          point.y,
        );
      }
    }
  }

  function markerPointerDown(
    event: ReactPointerEvent<HTMLButtonElement>,
    entryId: string,
  ) {
    event.stopPropagation();
    if (!imageReady) return;
    selectEntry(entryId);
    if (tool === "move" && writable) {
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { kind: "marker", entryId };
    }
  }

  function stagePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!imageReady) return;
    if (drag.current?.kind === "pan") {
      setOffset({
        x: drag.current.startX + event.clientX - drag.current.x,
        y: drag.current.startY + event.clientY - drag.current.y,
      });
    } else if (drag.current?.kind === "marker") {
      const point = pointFromEvent(event, true);
      if (point) {
        updateEntry(
          drag.current.entryId,
          { markerX: point.x, markerY: point.y },
          false,
        );
      }
    }
  }

  function stagePointerUp() {
    if (drag.current?.kind === "marker") scheduleSave(drag.current.entryId);
    drag.current = null;
  }

  async function resolveWithServer() {
    if (refreshingScopeRef.current === editorScope) return;
    const isCurrent = requestStillCurrent();
    setSaveState("syncing");
    try {
      const latest = await unwrap(
        await client.GET("/api/works/{workId}/translations", {
          params: { path: { workId } },
        }),
      );
      if (!isCurrent()) return;
      queryClient.setQueryData(["translation-editor", workId], latest);
      replaceEditorHead(latest);
      replaceImages(latest.images);
      replaceDirty(new Set());
      setRecoveryDraft(null);
      recoveryDraftRef.current = null;
      setDraftConflictKind(null);
      setMessage(null);
      setSaveState("saved");
      await deleteTranslationDraft(user.id, workId).catch(() => undefined);
    } catch {
      if (!isCurrent()) return;
      setSaveState("conflict");
      setMessage("暂时无法读取服务端最新内容，请保持本地草稿并稍后重试。");
    }
  }

  async function reapplyLocalDraft() {
    if (!recoveryDraft || refreshingScopeRef.current === editorScope) return;
    const isCurrent = requestStillCurrent();
    setSaveState("syncing");
    try {
      const latest = await unwrap(
        await client.GET("/api/works/{workId}/translations", {
          params: { path: { workId } },
        }),
      );
      if (!isCurrent()) return;
      queryClient.setQueryData(["translation-editor", workId], latest);
      replaceEditorHead(latest);
      const access = latest as PageEditor;
      if (!latest.canEdit)
        throw new Error(
          "当前阶段没有编辑权限，本地草稿已保留；请先撤回自己的提交或取得当前阶段的编辑资格。",
        );
      const target = reapplyDraftContent(
        latest.images,
        recoveryDraft.images,
        recoveryDraft.dirtyEntryIds,
      );
      if (target.legacy || target.conflictedEntryIds.size)
        throw new Error(
          "本地草稿缺少可靠修改记录，或对应云端条目已变化；已保留本地原稿供复制核对。",
        );
      if (
        access.editableImageIds &&
        target.images.some(
          (image) =>
            !access.editableImageIds!.includes(image.id) &&
            image.entries.some((entry) => target.dirtyEntryIds.has(entry.id)),
        )
      )
        throw new Error(
          "本地草稿含无权修改或已提交的页，已保留供核对，请先取得这些页的编辑资格。",
        );
      if (draftConflictKind === "recovery") {
        const reconciliation = reconcileTranslationDraft(
          latest.images,
          recoveryDraft,
          editorHeadRef.current,
        );
        if (!reconciliation.compatible) {
          replaceImages(latest.images);
          setDraftConflictKind(reconciliation.conflict);
          setSaveState("conflict");
          setMessage(
            reconciliation.conflict === "epoch"
              ? "恢复期间云端产生了新的正式版本，请重新选择处理方式。"
              : "恢复期间云端内容发生变化，请重新选择处理方式。",
          );
          return;
        }
        replaceImages(reconciliation.images);
        replaceDirty(reconciliation.dirtyEntryIds);
        setRecoveryDraft(null);
        recoveryDraftRef.current = null;
        setDraftConflictKind(null);
        setMessage("已恢复本地草稿，正在同步到云端。");
        setSaveState("local");
        void syncAll();
        return;
      }
      const reapplied = reapplyDraftContent(
        latest.images,
        recoveryDraft.images,
        recoveryDraft.dirtyEntryIds,
      );
      if (reapplied.legacy || reapplied.conflictedEntryIds.size)
        throw new Error("对应云端条目已变化，本地原稿已保留供复制核对。");
      replaceImages(reapplied.images);
      replaceDirty(reapplied.dirtyEntryIds);
      setRecoveryDraft(null);
      recoveryDraftRef.current = null;
      setDraftConflictKind(null);
      setMessage(
        reapplied.dirtyEntryIds.size
          ? draftConflictKind === "epoch"
            ? "已确认最新云端基线，本地输入将按当前正常编辑资格保存。"
            : "已重新应用本地内容，将在 3000ms 后保存。"
          : "服务端结构已变化，没有可安全重新应用的本地内容。",
      );
      setSaveState(reapplied.dirtyEntryIds.size ? "local" : "saved");
      for (const entryId of reapplied.dirtyEntryIds) scheduleSave(entryId);
    } catch (error) {
      if (!isCurrent()) return;
      setSaveState("conflict");
      setMessage(
        error instanceof Error
          ? error.message
          : "暂时无法读取服务端最新内容，本地草稿仍然保留。",
      );
    }
  }

  useEffect(() => {
    if (!editor.isSuccess) return;
    const initialEditor = editorDataRef.current;
    const key = `${user.id}:${workId}`;
    if (!initialEditor || presenceStartedKey.current === key) return;
    presenceStartedKey.current = key;
    setActiveParticipants(initialEditor.activeParticipants);
    let cancelled = false;
    const mode = initialEditor.canEdit ? "edit" : "view";
    setPresenceMode(mode);
    void updateEditorPresence(workId, mode)
      .then(async (presence) => {
        if (cancelled) return;
        setActiveParticipants(presence.items);
        setPresenceMode(presence.viewOnly ? "view" : mode);
        await observeEditorState.current(
          presence as Partial<EditorStateSignal>,
        );
      })
      .catch(() => {
        if (!cancelled)
          setMessage("协作状态暂时不可用，版本校验与自动保存仍然有效。");
      });
    return () => {
      cancelled = true;
      if (presenceStartedKey.current === key) {
        presenceStartedKey.current = null;
        void client.DELETE("/api/works/{workId}/translations/presence", {
          params: { path: { workId } },
          body: {},
        });
      }
    };
  }, [editor.isSuccess, user.id, workId]);

  useEffect(() => {
    if (!presenceMode) return;
    let cancelled = false;
    let pending = false;
    const scope = editorScope;
    const check = () => {
      if (pending || document.hidden || !navigator.onLine) return;
      pending = true;
      void updateEditorPresence(workId, presenceMode)
        .then(async (presence) => {
          if (cancelled || editorScopeRef.current !== scope) return;
          setActiveParticipants(presence.items);
          await observeEditorState.current(
            presence as Partial<EditorStateSignal>,
          );
          if (!cancelled && presence.viewOnly) setPresenceMode("view");
        })
        .catch(() => undefined)
        .finally(() => {
          pending = false;
        });
    };
    const timer = window.setInterval(check, presenceHeartbeatDelay);
    window.addEventListener("focus", check);
    window.addEventListener("online", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
      window.removeEventListener("online", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [presenceMode, workId, editorScope]);

  useEffect(() => {
    const key = `${user.id}:${workId}`;
    if (
      !editor.data ||
      editor.isFetching ||
      editor.isError ||
      initializedKey.current === key
    )
      return;
    const initialEditor = editor.data;
    replaceEditorHead(initialEditor);
    setDraftHydrated(false);
    setRecoveryDraft(null);
    recoveryDraftRef.current = null;
    replaceDirty(new Set());
    let cancelled = false;
    void loadTranslationDraft(user.id, workId)
      .then((draft) => {
        if (cancelled) return;
        if (!draft) {
          replaceImages(initialEditor.images);
          initializedKey.current = key;
          setDraftHydrated(true);
          return;
        }
        const reconciliation = reconcileTranslationDraft(
          initialEditor.images,
          draft,
          editorHeadRef.current,
        );
        if (reconciliation.compatible) {
          if (reconciliation.dirtyEntryIds.size) {
            replaceImages(initialEditor.images);
            setRecoveryDraft(draft);
            setDraftConflictKind("recovery");
            setSaveState("conflict");
            setMessage(
              "发现 7 天保留期内尚未同步的本地草稿，请选择使用云端或恢复本地内容。",
            );
          } else {
            replaceImages(initialEditor.images);
            replaceDirty(new Set());
            setSaveState("saved");
          }
        } else {
          replaceImages(
            initialEditor.workflowStatus === "translating" &&
              reconciliation.conflict === "epoch"
              ? draft.images
              : initialEditor.images,
          );
          setRecoveryDraft(draft);
          setDraftConflictKind(reconciliation.conflict);
          setSaveState("conflict");
          setMessage(
            reconciliation.conflict === "epoch"
              ? "云端已经产生新的正式版本，本地草稿不能自动跨越提交边界。"
              : "本地草稿与云端内容均有变化，请选择如何处理。",
          );
        }
        initializedKey.current = key;
        setDraftHydrated(true);
      })
      .catch(() => {
        if (!cancelled) {
          replaceImages(initialEditor.images);
          setMessage("本地草稿存储不可用，服务端编辑仍可继续。");
          initializedKey.current = key;
          setDraftHydrated(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [editor.data, editor.isError, editor.isFetching, user.id, workId]);

  useEffect(() => {
    if (
      !draftHydrated ||
      recoveryDraft ||
      initializedKey.current !== `${user.id}:${workId}`
    )
      return;
    if (!hasUnsaved) {
      void deleteTranslationDraft(user.id, workId).catch(() => undefined);
      return;
    }
    const draft = createTranslationDraft(
      user.id,
      workId,
      images,
      editorHeadRef.current,
      Date.now(),
      dirtyRef.current,
    );
    void saveTranslationDraft(draft).catch(() => {
      setMessage((current) =>
        recoveryDraftRef.current
          ? `${current ?? "检测到版本冲突。"} 浏览器本地存储不可用，请不要关闭页面。`
          : "无法写入浏览器本地草稿，请不要关闭页面。",
      );
      setSaveState((current) => (current === "conflict" ? current : "failed"));
    });
  }, [
    draftHydrated,
    hasUnsaved,
    images,
    dirtyEntryIds,
    recoveryDraft,
    user.id,
    workId,
  ]);

  useEffect(() => {
    function onlineHandler() {
      setOnline(true);
      if (dirtyRef.current.size) {
        setSaveState("local");
        void syncAll();
      }
    }
    function offlineHandler() {
      setOnline(false);
      if (dirtyRef.current.size) setSaveState("offline");
    }
    window.addEventListener("online", onlineHandler);
    window.addEventListener("offline", offlineHandler);
    return () => {
      window.removeEventListener("online", onlineHandler);
      window.removeEventListener("offline", offlineHandler);
    };
  });

  useEffect(
    () => () => {
      for (const timer of saveTimers.current.values())
        window.clearTimeout(timer);
    },
    [],
  );

  useEffect(() => {
    function clear() {
      markerUndoStack.current = [];
    }
    function focus(event: FocusEvent) {
      const target = event.target as HTMLElement;
      if (
        !canvasRef.current?.contains(target) ||
        target.closest("input,textarea,[contenteditable=true]")
      )
        clear();
    }
    function visibility() {
      if (document.hidden) clear();
    }
    function key(event: KeyboardEvent) {
      if (
        event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "z" &&
        !event.isComposing &&
        canvasRef.current?.contains(document.activeElement) &&
        !(event.target as HTMLElement).closest(
          "input,textarea,[contenteditable=true]",
        )
      ) {
        if (undoMarker()) event.preventDefault();
      }
    }
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
  });

  const selectedEntry = useMemo(
    () => currentEntries.find((entry) => entry.id === selectedEntryId),
    [currentEntries, selectedEntryId],
  );

  if (!user.permissions.includes("works:read"))
    return <Navigate to="/" replace />;
  if (
    editor.isPending ||
    (editor.isFetching && initializedKey.current !== `${user.id}:${workId}`)
  )
    return <div className="translation-editor-state">正在打开翻译工作区…</div>;
  if (editor.isError || !editor.data)
    return (
      <div className="translation-editor-state">
        <AlertTriangle />
        <p>{editor.error?.message ?? "无法读取翻译草稿"}</p>
        <Button onClick={() => void editor.refetch()}>重新加载</Button>
        <Link to={`/works/${workId}`}>返回作品详情</Link>
      </div>
    );

  return (
    <div
      className="translation-editor"
      onKeyDown={toolShortcut}
      onCompositionStartCapture={() => {
        shortcutComposing.current = true;
      }}
      onCompositionEndCapture={() => {
        shortcutComposing.current = false;
      }}
    >
      {confirmation.dialog}
      {showPagePreview && (
        <EditorPagePreview
          workId={workId}
          images={images}
          currentIndex={pageIndex}
          onClose={() => setShowPagePreview(false)}
          onNavigate={goToPage}
        />
      )}
      {showShortcutSettings && (
        <EditorShortcutDialog
          bindings={shortcuts.bindings}
          notice={shortcuts.notice}
          onSave={shortcuts.save}
          onClose={() => setShowShortcutSettings(false)}
        />
      )}
      {labelPlusPreview && (
        <div className="translation-entry-choice-backdrop">
          <section
            className="translation-entry-choice translation-labelplus-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="labelplus-preview-title"
          >
            <div className="translation-entry-choice-icon">
              <FileText size={22} />
            </div>
            <div>
              <p>LABELPLUS 导入预览</p>
              <h2 id="labelplus-preview-title">{labelPlusFile?.name}</h2>
            </div>
            <p className="translation-entry-choice-copy">
              将按章节顺序覆盖当前服务端草稿。成功后会保留原文件、生成不可变版本并切换编辑
              epoch。
            </p>
            <div className="translation-labelplus-summary">
              <strong>{labelPlusPreview.imageCount}</strong>
              <span>图片章节</span>
              <strong>{labelPlusPreview.markerCount}</strong>
              <span>译文标记</span>
            </div>
            <div className="translation-labelplus-mappings">
              {labelPlusPreview.mappings.map((mapping, index) => (
                <div key={mapping.targetImageId}>
                  <span>{index + 1}</span>
                  <strong>{mapping.sourceFileName}</strong>
                  <small>
                    → {mapping.targetFileName} · {mapping.markerCount} 个标记
                  </small>
                </div>
              ))}
            </div>
            {labelPlusPreview.warnings.length > 0 && (
              <div className="translation-labelplus-warnings">
                <strong>解析提示</strong>
                {labelPlusPreview.warnings.map((warning, index) => (
                  <p key={`${warning.code}:${warning.line}:${index}`}>
                    第 {warning.line} 行：{warning.message}
                  </p>
                ))}
              </div>
            )}
            {labelPlusPreview.blockingIssues.length > 0 && (
              <div className="translation-labelplus-blocking">
                <strong>暂不能导入</strong>
                {labelPlusPreview.blockingIssues.map((issue) => (
                  <p key={issue}>{issue}</p>
                ))}
              </div>
            )}
            {editor.data.editStages.length > 1 && (
              <label className="translation-labelplus-stage">
                <span>以哪项职责导入</span>
                <SelectControl
                  value={labelPlusStage ?? ""}
                  onValueChange={(value) =>
                    setLabelPlusStage(value as WorkStage)
                  }
                >
                  {editor.data.editStages.map((stage) => (
                    <option key={stage} value={stage}>
                      {stageCopy(stage)}
                    </option>
                  ))}
                </SelectControl>
              </label>
            )}
            <div className="translation-entry-choice-actions">
              <Button
                variant="secondary"
                disabled={labelPlusOperation === "import"}
                onClick={() => {
                  setLabelPlusPreview(null);
                  setLabelPlusFile(null);
                }}
              >
                取消
              </Button>
              <Button
                loading={labelPlusOperation === "import"}
                disabled={!labelPlusPreview.canImport || !labelPlusStage}
                onClick={() => void confirmLabelPlusImport()}
              >
                覆盖并导入
              </Button>
            </div>
          </section>
        </div>
      )}
      {showReviewDialog && (
        <div className="translation-entry-choice-backdrop">
          <section
            className="translation-entry-choice translation-review-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="translation-review-title"
          >
            <div className="translation-entry-choice-icon">
              <FileWarning size={22} />
            </div>
            <div>
              <p>流程事项</p>
              <h2 id="translation-review-title">内容审核</h2>
            </div>
            <p className="translation-entry-choice-copy">
              主流程阶段保持不变。事项解决前作品只读挂起，本地草稿保留，云端保存和制作推进暂停。
            </p>
            <label className="translation-review-reason">
              <span>问题与需要确认的内容</span>
              <textarea
                autoFocus
                required
                maxLength={2000}
                rows={5}
                value={reviewReason}
                placeholder="说明原作品需要讨论的问题"
                onChange={(event) => setReviewReason(event.target.value)}
              />
              <small>{reviewReason.length} / 2000</small>
            </label>
            <div className="translation-entry-choice-actions">
              <Button
                variant="secondary"
                disabled={reviewPending}
                onClick={() => {
                  setShowReviewDialog(false);
                  setReviewReason("");
                }}
              >
                取消
              </Button>
              <Button
                loading={reviewPending}
                disabled={!reviewReason.trim()}
                onClick={() => void openReviewCase()}
              >
                内容审核
              </Button>
            </div>
          </section>
        </div>
      )}
      <header className="translation-editor-header">
        <Link className="translation-editor-back" to={`/works/${workId}`}>
          <ArrowLeft size={17} />
          返回作品
        </Link>
        <div className="translation-editor-title">
          <strong>
            {editor.data.title?.trim() ||
              `#${editor.data.workNumber} · 待定标题`}
          </strong>
          <span>
            {images.length ? `第 ${pageNumber} / ${images.length} 页` : "0 页"}{" "}
            · 正式版本 {editor.data.latestVersion?.versionNumber ?? 0}
            {editor.data.collaborationMode === "multi" &&
              editor.data.submissionStage !== "proofread" &&
              ` · 我的分工 ${editor.data.assignedImageIds.length} 页`}
          </span>
        </div>
        {activeParticipants.length > 0 && (
          <div
            className="translation-presence-summary"
            title={activeParticipants
              .map(
                (participant) =>
                  `${participant.displayName}（${participant.mode === "edit" ? "编辑" : "查看"}）`,
              )
              .join("、")}
          >
            <Users size={15} />
            <span>
              {activeEditingUserCount} 人编辑 · {activeUserCount} 人在线
            </span>
          </div>
        )}
        <div className={`translation-save-state is-${saveState}`} role="status">
          <SaveStateIcon state={saveState} />
          <span>{statusCopy(saveState, savedAt)}</span>
        </div>
        {writable && (
          <Button
            size="sm"
            variant="secondary"
            leadingIcon={<Save size={15} />}
            disabled={!hasUnsaved || !online || saveState === "syncing"}
            onClick={() => void syncAll()}
          >
            {!online
              ? "等待联网"
              : saveState === "syncing"
                ? "保存中"
                : hasUnsaved
                  ? "保存草稿"
                  : "已保存"}
          </Button>
        )}
        {user.permissions.includes("works:review:raise") &&
          editor.data.reviewStatus === "normal" &&
          editor.data.workflowStatus !== "archived" && (
            <Button
              size="sm"
              variant="secondary"
              leadingIcon={<FileWarning size={15} />}
              disabled={
                hasUnsaved ||
                !online ||
                reorderPending ||
                saveState === "syncing" ||
                Boolean(recoveryDraft)
              }
              title={
                hasUnsaved || recoveryDraft
                  ? "请先同步或处理当前本地内容"
                  : !online
                    ? "恢复联网后才能发起流程事项"
                    : undefined
              }
              onClick={() => setShowReviewDialog(true)}
            >
              内容审核
            </Button>
          )}
        {user.canSkipProofreading &&
          editor.data.workflowStatus === "pending_proofread" && (
            <SkipProofreadingButton
              workId={workId}
              available={editor.data.canSkipProofreading}
              reason={editor.data.skipProofreadingUnavailableReason}
              disabled={
                hasUnsaved ||
                !online ||
                saveState === "syncing" ||
                Boolean(recoveryDraft)
              }
              onSkipped={async () => {
                await deleteTranslationDraft(user.id, workId).catch(
                  () => undefined,
                );
                const refreshed = await editor.refetch();
                if (refreshed.data) {
                  replaceEditorHead(refreshed.data);
                  replaceImages(refreshed.data.images);
                }
                setMessage("已跳过校对，作品进入待嵌字。");
              }}
            />
          )}
        {cancelableSubmissionStage && (
          <EditorSubmissionCancelAction
            label={`取消${stageCopy(cancelableSubmissionStage)}提交`}
            secondary={Boolean(submissionStage)}
            disabled={
              stageRefreshing ||
              hasUnsaved ||
              !online ||
              saveState === "syncing" ||
              Boolean(recoveryDraft)
            }
            onCancel={() => void cancelCurrentSubmission()}
          />
        )}
        {submissionStage && (
          <>
            <Button
              size="sm"
              disabled={
                stageRefreshing ||
                !stageContentReady ||
                !canSubmitStage ||
                !online ||
                saveState === "syncing" ||
                editor.data.reviewStatus !== "normal"
              }
              title={
                editor.data.reviewStatus !== "normal"
                  ? "审核事项解决前不能提交阶段"
                  : undefined
              }
              onClick={() => void submitCurrentStage()}
            >
              提交{submissionStage === "translate" ? "翻译" : "校对"}
            </Button>
          </>
        )}
      </header>
      <div className="translation-editor-toolbar" aria-label="编辑工具">
        <div className="translation-tool-group">
          {tools.map(({ value, label, icon: ToolIcon }) => (
            <button
              type="button"
              key={value}
              className={`editor-tool-button${tool === value ? " is-active" : ""}`}
              aria-pressed={tool === value}
              aria-label={label}
              aria-keyshortcuts={shortcutAria(shortcuts.bindings[value])}
              title={`${label} · 快捷键 ${shortcutLabel(shortcuts.bindings[value])}（画布或工具栏聚焦时）`}
              disabled={
                ((!writable || !imageReady) && value !== "pan") ||
                (reorderPending &&
                  (value === "add-inside" || value === "add-outside"))
              }
              onClick={() => selectTool(value)}
            >
              <ToolIcon size={16} />
              <span className="translation-tool-label">{label}</span>
              <kbd className="editor-tool-keycap" aria-hidden="true">
                {shortcutLabel(shortcuts.bindings[value])}
              </kbd>
            </button>
          ))}
        </div>
        <div className="translation-file-actions">
          <Button
            size="sm"
            variant="secondary"
            className="translation-file-button"
            leadingIcon={<Keyboard size={15} />}
            aria-label="快捷键"
            title="快捷键"
            onClick={() => setShowShortcutSettings(true)}
          >
            快捷键
          </Button>
          <input
            ref={labelPlusInputRef}
            type="file"
            accept=".txt,.labelplus,text/plain"
            aria-label="选择 LabelPlus 文件"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void previewLabelPlus(file);
            }}
          />
          {editor.data.editStages.length > 0 &&
            (editor.data.collaborationMode === "single" ||
              editor.data.editStages.includes("proofread") ||
              (editor.data.images.length > 0 &&
                editor.data.editableImageIds?.length ===
                  editor.data.images.length)) && (
              <Button
                size="sm"
                variant="secondary"
                className="translation-file-button"
                leadingIcon={<Upload size={15} />}
                aria-label="导入 LabelPlus"
                loading={labelPlusOperation === "preview"}
                disabled={
                  !writable ||
                  hasUnsaved ||
                  reorderPending ||
                  editor.data.reviewStatus !== "normal"
                }
                title={
                  editor.data.reviewStatus !== "normal"
                    ? "审核事项解决前不能导入正式版本"
                    : hasUnsaved
                      ? "请先同步当前本地修改"
                      : "导入 LabelPlus"
                }
                onClick={() => labelPlusInputRef.current?.click()}
              >
                导入 LabelPlus
              </Button>
            )}
          {editor.data.canExportLabelPlus && (
            <Button
              size="sm"
              variant="secondary"
              className="translation-file-button"
              leadingIcon={<Download size={15} />}
              aria-label="导出 LabelPlus"
              loading={labelPlusOperation === "export"}
              disabled={hasUnsaved || reorderPending}
              title={hasUnsaved ? "请先同步当前本地修改" : "导出 LabelPlus"}
              onClick={() => void exportLabelPlus()}
            >
              导出 LabelPlus
            </Button>
          )}
          <EditorReferenceTools
            key={referenceScope}
            insert={symbolInsertion.insert}
            status={symbolInsertion.status}
          />
        </div>
        <div className="translation-zoom-group">
          <IconButton
            size="sm"
            label="缩小"
            disabled={!imageReady}
            onClick={() => setZoom((value) => clamp(value - 0.2, 0.4, 3))}
          >
            <ZoomOut size={16} />
          </IconButton>
          <span>{Math.round(zoom * 100)}%</span>
          <IconButton
            size="sm"
            label="放大"
            disabled={!imageReady}
            onClick={() => setZoom((value) => clamp(value + 0.2, 0.4, 3))}
          >
            <ZoomIn size={16} />
          </IconButton>
          <IconButton size="sm" label="重置视图" onClick={resetViewport}>
            <Maximize2 size={16} />
          </IconButton>
        </div>
      </div>
      <div className="translation-editor-notices">
        {editor.data.reviewStatus !== "normal" && (
          <section
            className={`translation-review-status is-${editor.data.reviewStatus}`}
            aria-label="当前审核状态"
          >
            <FileWarning size={18} />
            <div>
              <strong>{reviewStatusCopy[editor.data.reviewStatus]}</strong>
              <p>
                {editor.data.openReviewCase?.resolutionNote ||
                  editor.data.openReviewCase?.reason ||
                  "事项解决前只允许查看，本地草稿保留；自动保存、提交和导入已暂停。"}
              </p>
              {editor.data.openReviewCase && (
                <small>
                  由 {editor.data.openReviewCase.openedByName} 发起 ·
                  主流程阶段保持不变
                </small>
              )}
            </div>
            {editor.data.openReviewCase && (
              <ReviewRequestActions
                reviewId={editor.data.openReviewCase.id}
                workId={workId}
                disabled={!online}
                onUpdated={async () => {
                  if (hasUnsaved) {
                    await enterConflict(
                      imagesRef.current,
                      "审核状态已更新，请确认最新云端基线后恢复本地草稿。",
                    );
                    return;
                  }
                  const refreshed = await editor.refetch();
                  if (refreshed.data) {
                    replaceEditorHead(refreshed.data);
                    replaceImages(refreshed.data.images);
                    setPresenceMode(refreshed.data.canEdit ? "edit" : "view");
                  }
                }}
              />
            )}
          </section>
        )}
        {message && (
          <div className={`translation-editor-message is-${saveState}`}>
            <span>{message}</span>
            {recoveryDraft && (
              <div>
                {showingLocalRecovery && (
                  <p>
                    正在显示未同步本地稿，可选取复制；该内容尚未写入当前阶段。使用服务端版本会放弃这份本地稿。
                  </p>
                )}
                {!showingLocalRecovery && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => replaceImages(recoveryDraft.images)}
                  >
                    查看本地草稿
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={stageRefreshing || saveState === "syncing"}
                  onClick={() => void resolveWithServer()}
                >
                  使用服务端版本
                </Button>
                <Button
                  size="sm"
                  disabled={stageRefreshing || saveState === "syncing"}
                  onClick={() => void reapplyLocalDraft()}
                >
                  {draftConflictKind === "recovery"
                    ? "恢复本地草稿"
                    : draftConflictKind === "epoch"
                      ? "按最新基线恢复本地内容"
                      : "重新应用本地内容"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setMessage("本地草稿已保留；解决冲突前编辑器保持只读。")
                  }
                >
                  暂不处理
                </Button>
              </div>
            )}
            {!recoveryDraft && (
              <button type="button" onClick={() => setMessage(null)}>
                关闭
              </button>
            )}
            {stageRefreshing && (
              <Button size="sm" onClick={() => void refreshStageState()}>
                重新读取当前状态
              </Button>
            )}
          </div>
        )}
      </div>
      <main className="translation-editor-main">
        <section
          ref={canvasRef}
          tabIndex={0}
          aria-label="图片标记画布，滚轮缩放，Ctrl 加 Z 撤销连续新标点"
          className={`translation-canvas is-tool-${tool}`}
          onPointerDown={stagePointerDown}
          onPointerMove={stagePointerMove}
          onPointerUp={stagePointerUp}
          onPointerCancel={stagePointerUp}
        >
          {currentImage && isDisplayableImageUrl(imageUrl.data?.url) ? (
            <div
              key={imageRequestKey}
              className="translation-image-layer"
              aria-hidden={!imageReady}
              style={{
                visibility: imageReady ? "visible" : "hidden",
                transform: `translate(${offset.x}px, ${offset.y}px)`,
              }}
            >
              <div className="translation-image-frame">
                <img
                  ref={imageRef}
                  src={imageUrl.data!.url}
                  alt={`第 ${pageIndex + 1} 页`}
                  style={{ transform: `scale(${zoom})` }}
                  draggable={false}
                  onLoad={(event) => {
                    if (event.currentTarget === imageRef.current)
                      setImageLoad({ key: imageRequestKey, phase: "ready" });
                  }}
                  onError={(event) => {
                    if (event.currentTarget === imageRef.current)
                      setImageLoad({ key: imageRequestKey, phase: "failed" });
                  }}
                />
                {imageReady &&
                  currentEntries.map((entry, index) => (
                    <MarkerTooltip
                      key={`${entry.id}:${zoom}:${offset.x}:${offset.y}:${tool}`}
                      text={entry.translatedText}
                    >
                      <button
                        type="button"
                        className={`translation-marker is-${entry.markerPositionType}${selectedEntryId === entry.id ? " is-selected" : ""}${entry.localOnly ? " is-local" : ""}`}
                        style={{
                          left: `${(0.5 + (entry.markerX - 0.5) * zoom) * 100}%`,
                          top: `${(0.5 + (entry.markerY - 0.5) * zoom) * 100}%`,
                        }}
                        aria-label={`标记 ${index + 1}`}
                        onPointerDown={(event) =>
                          markerPointerDown(event, entry.id)
                        }
                        onClick={() => selectEntry(entry.id, true)}
                      >
                        {index + 1}
                      </button>
                    </MarkerTooltip>
                  ))}
              </div>
            </div>
          ) : null}
          {!currentImage && (
            <div className="translation-canvas-empty">
              <ImageIcon />
              暂无原图
            </div>
          )}
          {currentImage &&
            !imageReady &&
            (imageFailed ? (
              <div className="translation-canvas-empty" role="alert">
                <ImageIcon />第 {pageIndex + 1} 页图片加载失败
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setImageRetry((attempt) => attempt + 1);
                    void imageUrl.refetch();
                  }}
                >
                  重试加载图片
                </Button>
              </div>
            ) : (
              <div className="translation-canvas-empty" role="status">
                <LoaderCircle className="ui-spin" />
                正在加载第 {pageIndex + 1} 页
              </div>
            ))}
          <div className="translation-page-controls">
            <IconButton
              label="上一页"
              title={`上一页 · 快捷键 ${shortcutLabel(shortcuts.bindings["previous-page"])}（画布或标记列表聚焦时）`}
              aria-keyshortcuts={shortcutAria(
                shortcuts.bindings["previous-page"],
              )}
              disabled={pageIndex === 0}
              onClick={() => goToPage(pageIndex - 1)}
            >
              <ChevronLeft />
            </IconButton>
            <button
              type="button"
              className="translation-page-preview-trigger"
              aria-haspopup="dialog"
              aria-expanded={showPagePreview}
              disabled={!images.length}
              aria-label={
                currentImage
                  ? `预览并跳转页面，当前第 ${pageNumber} 页，共 ${images.length} 页`
                  : "暂无可预览页面"
              }
              title="预览并跳转页面"
              onClick={() => setShowPagePreview(true)}
            >
              <Grid2X2 size={16} aria-hidden="true" />
              <span>
                {pageNumber} / {images.length}
              </span>
            </button>
            <IconButton
              label="下一页"
              title={`下一页 · 快捷键 ${shortcutLabel(shortcuts.bindings["next-page"])}（画布或标记列表聚焦时）`}
              aria-keyshortcuts={shortcutAria(shortcuts.bindings["next-page"])}
              disabled={pageIndex >= images.length - 1}
              onClick={() => goToPage(pageIndex + 1)}
            >
              <ChevronRight />
            </IconButton>
          </div>
        </section>

        <aside className="translation-entry-panel">
          <div className="translation-entry-heading">
            <div>
              <strong>译文条目</strong>
              <span>{currentEntries.length} 个标记</span>
            </div>
            {!writable && <Badge tone="neutral">只读</Badge>}
          </div>
          {!writable && (
            <div
              className="translation-page-permission"
              aria-label="本页编辑权限"
            >
              <p className="translation-readonly-notice">
                {recoveryDraft
                  ? "请先处理本地与云端内容，再继续编辑。"
                  : editor.data.reviewStatus !== "normal"
                    ? reviewStatusCopy[editor.data.reviewStatus]
                    : cancelableSubmissionStage
                      ? "已提交，取消本人提交后可修改。"
                      : pageEditor?.editableImageIds
                        ? "此页不在本人当前可编辑范围。"
                        : "请先认领职责。"}
              </p>
            </div>
          )}
          <div
            className="translation-entry-list"
            ref={entryListRef}
            tabIndex={0}
            role="region"
            aria-label="译文标记列表"
            aria-busy={reorderPending}
            {...markerReorder.listProps}
          >
            {currentEntries.length ? (
              currentEntries.map((entry, index) => (
                <article
                  {...markerReorder.rowProps(entry.id)}
                  // Discard native textarea history at work/epoch/write-access boundaries.
                  key={`${referenceScope}:${writable}:${entry.id}`}
                  ref={(node) => {
                    if (node) entryRefs.current.set(entry.id, node);
                    else entryRefs.current.delete(entry.id);
                  }}
                  className={`translation-entry-card${selectedEntryId === entry.id ? " is-selected" : ""}`}
                  onClick={() => selectEntry(entry.id)}
                >
                  <header>
                    <button
                      type="button"
                      className="translation-entry-number"
                      onClick={() => selectEntry(entry.id, true)}
                    >
                      {index + 1}
                    </button>
                    {writable && !entry.localOnly ? (
                      <SelectControl
                        className="translation-entry-position"
                        aria-label={`标记 ${index + 1} 的属性`}
                        value={entry.markerPositionType}
                        disabled={!markerEditsAvailable}
                        onValueChange={(value) =>
                          changeMarkerPosition(entry.id, value)
                        }
                      >
                        <option value="inside">框内</option>
                        <option value="outside">框外</option>
                      </SelectControl>
                    ) : (
                      <Badge
                        tone={
                          entry.markerPositionType === "inside"
                            ? "translation"
                            : "violet"
                        }
                      >
                        {entry.markerPositionType === "inside"
                          ? "框内"
                          : "框外"}
                      </Badge>
                    )}
                    {entry.localOnly && <Badge tone="warning">待创建</Badge>}
                    <div className="translation-entry-actions">
                      {writable &&
                        currentEntries.length > 1 &&
                        markerReorder.controls(entry.id)}
                      <IconButton
                        size="sm"
                        label="删除标记"
                        disabled={!writable}
                        onClick={() => void removeEntry(entry)}
                      >
                        <Trash2 size={15} />
                      </IconButton>
                    </div>
                  </header>
                  <label>
                    <span>译文</span>
                    <textarea
                      {...symbolInsertion.bindTextarea(entry.id)}
                      value={entry.translatedText}
                      readOnly={!writable || Boolean(entry.localOnly)}
                      placeholder={
                        entry.localOnly ? "标记同步后即可输入" : "输入对应译文"
                      }
                      onFocus={(event) => {
                        selectEntry(entry.id);
                        symbolInsertion.bindTextarea(entry.id).onFocus?.(event);
                      }}
                      onChange={(event) =>
                        updateEntry(entry.id, {
                          translatedText: event.target.value,
                        })
                      }
                    />
                  </label>
                  <OptionalSection
                    label={entry.note?.trim() ? "查看备注" : "添加备注（可选）"}
                    hasContent={Boolean(entry.note?.trim())}
                    defaultOpen={Boolean(entry.note?.trim())}
                  >
                    <label className="translation-note-field">
                      <span>备注</span>
                      <textarea
                        className="is-note"
                        value={entry.note ?? ""}
                        readOnly={!writable || Boolean(entry.localOnly)}
                        placeholder="可选，仅供协作说明"
                        onFocus={() => selectEntry(entry.id)}
                        onChange={(event) =>
                          updateEntry(entry.id, {
                            note: event.target.value.trim()
                              ? event.target.value
                              : null,
                          })
                        }
                      />
                    </label>
                  </OptionalSection>
                </article>
              ))
            ) : (
              <div className="translation-entry-empty">
                <CircleDot />
                <strong>这一页还没有标记</strong>
                {writable && imageReady && (
                  <p>选择“添加框内”或“添加框外”，再点击图片中的文字位置。</p>
                )}
              </div>
            )}
          </div>
          {markerReorder.feedback}
          {selectedEntry && (
            <div className="translation-selected-summary">
              当前选择：标记 {selectedEntry.orderIndex + 1}
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}
