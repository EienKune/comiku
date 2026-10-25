import { refreshReviewViews } from "../workspace/review-cache";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useQuery } from "@tanstack/react-query";
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
  HardDrive,
  ImageIcon,
  LoaderCircle,
  Maximize2,
  Move,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  Upload,
  UserRoundCheck,
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
import {
  authenticatedFetch,
  client,
  queryClient,
  unwrap,
} from "../account/api";
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
import { useAltWheelZoom } from "./use-alt-wheel-zoom";
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

function mergeServerImage(
  serverImage: TranslationImage,
  localImage: EditableTranslationImage | undefined,
  dirtyIds: Set<string>,
): EditableTranslationImage {
  if (!localImage) return serverImage;
  return {
    ...serverImage,
    entries: serverImage.entries.map((serverEntry) => {
      const localEntry = localImage.entries.find(
        (entry) => entry.id === serverEntry.id,
      );
      return localEntry && dirtyIds.has(serverEntry.id)
        ? {
            ...serverEntry,
            markerX: localEntry.markerX,
            markerY: localEntry.markerY,
            markerPositionType: localEntry.markerPositionType,
            translatedText: localEntry.translatedText,
            note: localEntry.note,
          }
        : serverEntry;
    }),
  };
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
  return unwrap(
    await client.POST("/api/works/{workId}/translations/presence", {
      params: { path: { workId } },
      body: { mode },
    }),
  );
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
  const [images, setImages] = useState<EditableTranslationImage[]>([]);
  const imagesRef = useRef<EditableTranslationImage[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageJump, setPageJump] = useState("1");
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
  const [draftConflictKind, setDraftConflictKind] =
    useState<DraftConflictKind | null>(null);
  const [draftHydrated, setDraftHydrated] = useState(false);
  const initializedKey = useRef<string | null>(null);
  const saveTimers = useRef(new Map<string, number>());
  const serverMutationQueue = useRef<Promise<void>>(Promise.resolve());
  const stageSubmissionInFlight = useRef(false);
  const entryRefs = useRef(new Map<string, HTMLElement>());
  const imageRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLElement>(null);
  const markerUndoStack = useRef<MarkerUndo[]>([]);
  const markerCreations = useRef(new Map<string, MarkerUndo>());
  const undoFailure = useRef(0);
  const undoPending = useRef(0);
  const editorHeadRef = useRef({
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
  const [showEntryChoice, setShowEntryChoice] = useState(false);
  const [entryChoicePending, setEntryChoicePending] = useState(false);
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
    queryFn: async () =>
      unwrap(
        await client.GET("/api/works/{workId}/translations", {
          params: { path: { workId } },
        }),
      ),
    enabled: Boolean(workId && user.permissions.includes("works:read")),
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
  });
  const editorDataRef = useRef(editor.data);
  editorDataRef.current = editor.data;

  const currentImage = images[pageIndex];
  const imageUrl = useQuery({
    queryKey: ["work-image", workId, currentImage?.id],
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

  const currentEntries = useMemo(
    () => currentImage?.entries ?? [],
    [currentImage],
  );
  const hasLocalEntry = images.some((image) =>
    image.entries.some((entry) => entry.localOnly),
  );
  const hasUnsaved = dirtyEntryIds.size > 0 || hasLocalEntry;
  const writable = Boolean(
    editor.data?.canEdit && presenceMode === "edit" && !recoveryDraft,
  );
  const writableRef = useRef(writable);
  writableRef.current = writable;
  useAltWheelZoom({
    canvas: canvasRef,
    image: imageRef,
    zoom,
    offset,
    ready: Boolean(currentImage && imageUrl.data?.url),
    onChange: (next) => {
      drag.current = null;
      setZoom(next.zoom);
      setOffset(next.offset);
    },
  });
  const submissionStage = editor.data?.submissionStage ?? null;
  const cancelableSubmissionStage =
    editor.data?.cancelableSubmissionStage ?? null;
  const otherActiveEditors = activeParticipants
    .filter(
      (participant) =>
        participant.mode === "edit" && !participant.isCurrentSession,
    )
    .filter(
      (participant, index, participants) =>
        participants.findIndex(
          ({ userId }) => userId === participant.userId,
        ) === index,
    );
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

  function chooseViewMode() {
    setPresenceMode("view");
    setShowEntryChoice(false);
    void updateEditorPresence(workId, "view")
      .then((presence) => setActiveParticipants(presence.items))
      .catch(() => undefined);
  }

  async function enterCollaboration() {
    const current = editorDataRef.current;
    if (!current || entryChoicePending) return;
    setEntryChoicePending(true);
    setMessage(null);
    try {
      if (
        current.joinableStage === "translate" ||
        current.joinableStage === "proofread"
      ) {
        const joined = await unwrap(
          await client.POST("/api/works/{id}/stages/join", {
            params: { path: { id: workId } },
            body: {
              stage: current.joinableStage,
              expectedRevision: current.workRevision,
              idempotencyKey: crypto.randomUUID(),
            },
          }),
        );
        queryClient.setQueryData(["work", workId], joined);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["works"] }),
          queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
          queryClient.invalidateQueries({ queryKey: ["dashboard-works"] }),
        ]);
        const refreshed = await editor.refetch();
        if (!refreshed.data?.canEdit) {
          throw new Error("加入协作后未能取得编辑权限，请刷新页面重试");
        }
        replaceEditorHead(refreshed.data);
      }
      const presence = await updateEditorPresence(workId, "edit");
      setActiveParticipants(presence.items);
      setPresenceMode("edit");
      setShowEntryChoice(false);
    } catch (error) {
      setPresenceMode("view");
      setMessage(error instanceof Error ? error.message : "进入协作失败");
    } finally {
      setEntryChoicePending(false);
    }
  }

  async function previewLabelPlus(file: File) {
    if (
      !editor.data ||
      !writable ||
      hasUnsaved ||
      editor.data.reviewStatus !== "normal"
    )
      return;
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
      setLabelPlusFile(file);
      setLabelPlusPreview(preview);
      setLabelPlusStage(
        editor.data.submissionStage ?? editor.data.editStages[0] ?? null,
      );
    } catch (error) {
      setSaveState("failed");
      setMessage(error instanceof Error ? error.message : "无法解析 LabelPlus");
    } finally {
      setLabelPlusOperation(null);
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
      !writable ||
      hasUnsaved ||
      current.reviewStatus !== "normal"
    ) {
      return;
    }
    setLabelPlusOperation("import");
    setMessage(null);
    const body = new FormData();
    body.append("file", labelPlusFile);
    body.append("stage", labelPlusStage);
    body.append("expectedRevision", String(current.workRevision));
    body.append("expectedEditorEpoch", String(current.editorEpoch));
    body.append("idempotencyKey", crypto.randomUUID());
    try {
      const imported = await unwrap(
        await client.POST("/api/works/{workId}/labelplus/imports", {
          params: { path: { workId } },
          body: body as never,
        }),
      );
      queryClient.setQueryData(["translation-editor", workId], imported);
      replaceEditorHead(imported);
      replaceImages(imported.images);
      replaceDirty(new Set());
      setPageIndex(0);
      setPageJump("1");
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
      setSaveState("conflict");
      setMessage(error instanceof Error ? error.message : "LabelPlus 导入失败");
    } finally {
      setLabelPlusOperation(null);
    }
  }

  async function exportLabelPlus() {
    const current = editorDataRef.current;
    if (
      !current ||
      !current.canExportLabelPlus ||
      hasUnsaved ||
      labelPlusPending
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
    editorEpoch: number;
    latestVersion: { id: string } | null;
  }) {
    markerUndoStack.current = [];
    undoFailure.current++;
    editorHeadRef.current = {
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
    if (!stillUnsaved) {
      void deleteTranslationDraft(user.id, workId).catch(() => undefined);
    }
  }

  function resetViewport() {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }

  function goToPage(nextIndex: number) {
    markerUndoStack.current = [];
    if (!images.length) return;
    const safeIndex = clamp(nextIndex, 0, images.length - 1);
    setPageIndex(safeIndex);
    setPageJump(String(safeIndex + 1));
    setSelectedEntryId(null);
    resetViewport();
  }

  function submitPageJump(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const requestedPage = Number(pageJump);
    if (!Number.isInteger(requestedPage) || requestedPage < 1) {
      setPageJump(String(pageIndex + 1));
      return;
    }
    goToPage(requestedPage - 1);
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

  async function enterConflict(
    localImages: EditableTranslationImage[],
    reason: string,
  ) {
    markerUndoStack.current = [];
    undoFailure.current++;
    for (const timer of saveTimers.current.values()) window.clearTimeout(timer);
    saveTimers.current.clear();
    setMessage(reason);
    setSaveState("conflict");
    setDraftConflictKind("content");
    const localDraft = createTranslationDraft(
      user.id,
      workId,
      localImages,
      editorHeadRef.current,
    );
    setRecoveryDraft(localDraft);
    replaceDirty(new Set());
    await saveTranslationDraft(localDraft).catch(() => undefined);
    try {
      const latest = await unwrap(
        await client.GET("/api/works/{workId}/translations", {
          params: { path: { workId } },
        }),
      );
      const crossedEpoch =
        latest.editorEpoch !== (localDraft.editorEpoch ?? 0) ||
        (latest.latestVersion?.id ?? null) !==
          (localDraft.latestVersionId ?? null);
      setDraftConflictKind(crossedEpoch ? "epoch" : "content");
      queryClient.setQueryData(["translation-editor", workId], latest);
      replaceEditorHead(latest);
      replaceImages(latest.images);
    } catch {
      setMessage("检测到版本冲突，同时无法重新读取服务端内容。请稍后重试。");
    }
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
    return enqueueServerMutation(() => performSaveEntry(entryId));
  }

  async function performSaveEntry(entryId: string) {
    const entry = imagesRef.current
      .flatMap((image) => image.entries)
      .find((item) => item.id === entryId);
    if (!entry || entry.localOnly || !dirtyRef.current.has(entryId)) return;
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
          expectedRevision: sent.revision,
          expectedEditorEpoch: editorHeadRef.current.editorEpoch,
          markerX: sent.markerX,
          markerY: sent.markerY,
          markerPositionType: sent.markerPositionType,
          translatedText: sent.translatedText,
          note: sent.note?.trim() || null,
        },
      });
      if (result.response.status === 409) {
        await enterConflict(
          imagesRef.current,
          "此条目已被其他参与者更新。请选择服务端内容，或明确重新应用本地译文。",
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

  function syncCreatedEntry(entryId: string) {
    return enqueueServerMutation(() => performSyncCreatedEntry(entryId));
  }

  async function performSyncCreatedEntry(entryId: string) {
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
          markerX: entry.markerX,
          markerY: entry.markerY,
          markerPositionType: entry.markerPositionType,
          expectedImageRevision: image.translationRevision,
          expectedEditorEpoch: editorHeadRef.current.editorEpoch,
          idempotencyKey: entry.idempotencyKey,
        },
      });
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
      updateImages((allImages) =>
        allImages.map((item) =>
          item.id === image.id
            ? mergeServerImage(savedImage, item, dirtyRef.current)
            : item,
        ),
      );
      clearDirty(entryId);
      setSelectedEntryId(created?.id ?? null);
      finishServerMutation();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "标记创建失败");
      setSaveState(navigator.onLine ? "failed" : "offline");
    } finally {
      setCreatingEntry(false);
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
    return enqueueServerMutation(async () => {
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
      !window.confirm("这个标记已有译文，确定删除吗？")
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
          expectedRevision: entry.revision,
          expectedImageRevision: image.translationRevision,
          expectedEditorEpoch: editorHeadRef.current.editorEpoch,
        },
      });
      if (result.response.status === 409) {
        await enterConflict(imagesRef.current, "删除前条目或图片顺序已更新。");
        return false;
      }
      const savedImage = await unwrap(result);
      applyMutationMeta(savedImage.mutation);
      updateImages((allImages) =>
        allImages.map((image) =>
          image.id === savedImage.id
            ? mergeServerImage(savedImage, image, dirtyRef.current)
            : image,
        ),
      );
      clearDirty(entry.id);
      setSelectedEntryId(null);
      finishServerMutation();
      return true;
    } catch (error) {
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
      !editor.data ||
      !submissionStage ||
      !writable ||
      hasUnsaved ||
      !online ||
      saveState === "syncing" ||
      editor.data.reviewStatus !== "normal"
    ) {
      return;
    }
    if (
      editor.data.collaborationMode === "multi" &&
      !editor.data.multiStageReady
    ) {
      setMessage("多人协作还有页面未分配、未完成或完成后又被修改。");
      return;
    }
    if (
      !window.confirm(
        `确定提交${submissionStage === "translate" ? "翻译" : "校对"}阶段吗？服务器当前内容将保存为不可变版本。`,
      )
    ) {
      return;
    }
    stageSubmissionInFlight.current = true;
    setSaveState("syncing");
    setMessage(null);
    try {
      const result = await client.POST("/api/works/{id}/stages/submit", {
        params: { path: { id: workId } },
        body: {
          stage: submissionStage,
          expectedRevision: editor.data.workRevision,
          expectedEditorEpoch: editor.data.editorEpoch,
          idempotencyKey: crypto.randomUUID(),
        },
      });
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
        `阶段已提交并生成不可变版本 ${refreshed.data?.latestVersion?.versionNumber ?? ""}。`,
      );
    } catch (error) {
      setSaveState("failed");
      setMessage(error instanceof Error ? error.message : "阶段提交失败");
    } finally {
      stageSubmissionInFlight.current = false;
    }
  }

  async function cancelCurrentSubmission() {
    if (
      stageSubmissionInFlight.current ||
      !editor.data ||
      !cancelableSubmissionStage ||
      hasUnsaved ||
      !online ||
      saveState === "syncing"
    ) {
      return;
    }
    if (
      !window.confirm(
        `确定取消${stageCopy(cancelableSubmissionStage)}提交吗？已保存内容和不可变版本会保留，作品将回退到${stageCopy(cancelableSubmissionStage)}中。`,
      )
    ) {
      return;
    }
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
      if (result.response.status === 409) {
        setSaveState("conflict");
        setMessage("下游已经开始或作品状态已变化，不能取消提交。");
        await editor.refetch();
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
      setSaveState("failed");
      setMessage(error instanceof Error ? error.message : "取消提交失败");
    } finally {
      stageSubmissionInFlight.current = false;
    }
  }

  async function completeMyPart() {
    if (
      !editor.data ||
      !submissionStage ||
      editor.data.collaborationMode !== "multi" ||
      !writable ||
      hasUnsaved ||
      !online ||
      saveState === "syncing" ||
      editor.data.reviewStatus !== "normal"
    ) {
      return;
    }
    if (!editor.data.assignedImageIds.length) {
      setMessage("请先在作品协调页选择本人负责的页码。");
      return;
    }
    setSaveState("syncing");
    setMessage(null);
    try {
      const updatedWork = await unwrap(
        await client.POST("/api/works/{id}/stages/contributions/complete", {
          params: { path: { id: workId } },
          body: {
            stage: submissionStage as "translate" | "proofread",
            expectedRevision: editor.data.workRevision,
            expectedEditorEpoch: editor.data.editorEpoch,
            idempotencyKey: crypto.randomUUID(),
          },
        }),
      );
      queryClient.setQueryData(["work", workId], updatedWork);
      const refreshed = await editor.refetch();
      if (refreshed.data) replaceEditorHead(refreshed.data);
      setSavedAt(new Date());
      setSaveState("saved");
      setMessage("本人负责的页面已完成；页面再次修改后需要重新确认。");
    } catch (error) {
      setSaveState("failed");
      setMessage(error instanceof Error ? error.message : "完成分工失败");
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

  function stagePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest(".translation-page-controls")) {
      return;
    }
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
    selectEntry(entryId);
    if (tool === "move" && writable) {
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { kind: "marker", entryId };
    }
  }

  function stagePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
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
    setSaveState("syncing");
    try {
      const latest = await unwrap(
        await client.GET("/api/works/{workId}/translations", {
          params: { path: { workId } },
        }),
      );
      queryClient.setQueryData(["translation-editor", workId], latest);
      replaceEditorHead(latest);
      replaceImages(latest.images);
      replaceDirty(new Set());
      setRecoveryDraft(null);
      setDraftConflictKind(null);
      setMessage(null);
      setSaveState("saved");
      await deleteTranslationDraft(user.id, workId).catch(() => undefined);
    } catch {
      setSaveState("conflict");
      setMessage("暂时无法读取服务端最新内容，请保持本地草稿并稍后重试。");
    }
  }

  async function reapplyLocalDraft() {
    if (!recoveryDraft) return;
    setSaveState("syncing");
    try {
      const latest = await unwrap(
        await client.GET("/api/works/{workId}/translations", {
          params: { path: { workId } },
        }),
      );
      queryClient.setQueryData(["translation-editor", workId], latest);
      replaceEditorHead(latest);
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
        replaceImages(recoveryDraft.images);
        replaceDirty(reconciliation.dirtyEntryIds);
        setRecoveryDraft(null);
        setDraftConflictKind(null);
        setMessage("已恢复本地草稿，正在同步到云端。");
        setSaveState("local");
        void syncAll();
        return;
      }
      const reapplied = reapplyDraftContent(
        latest.images,
        recoveryDraft.images,
      );
      replaceImages(reapplied.images);
      replaceDirty(reapplied.dirtyEntryIds);
      setRecoveryDraft(null);
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
    } catch {
      setSaveState("conflict");
      setMessage("暂时无法读取服务端最新内容，本地草稿仍然保留。");
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
    void updateEditorPresence(workId, "view")
      .then(async (presence) => {
        if (cancelled) return;
        setActiveParticipants(presence.items);
        const anotherEditor = presence.items.some(
          (item) => item.mode === "edit" && !item.isCurrentSession,
        );
        if (initialEditor.joinableStage || anotherEditor) {
          setPresenceMode("view");
          setShowEntryChoice(true);
          return;
        }
        if (!initialEditor.canEdit) {
          setPresenceMode("view");
          return;
        }
        try {
          const editing = await updateEditorPresence(workId, "edit");
          if (!cancelled) {
            setActiveParticipants(editing.items);
            setPresenceMode("edit");
          }
        } catch {
          if (!cancelled) {
            setPresenceMode("edit");
            setMessage("协作状态暂时不可用，版本校验与自动保存仍然有效。");
          }
        }
      })
      .catch(() => {
        if (cancelled) return;
        const anotherEditor = initialEditor.activeParticipants.some(
          (item) => item.mode === "edit" && !item.isCurrentSession,
        );
        if (initialEditor.joinableStage || anotherEditor) {
          setPresenceMode("view");
          setShowEntryChoice(true);
        } else {
          setPresenceMode(initialEditor.canEdit ? "edit" : "view");
        }
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
    const timer = window.setInterval(() => {
      void updateEditorPresence(workId, presenceMode)
        .then((presence) => {
          if (!cancelled) setActiveParticipants(presence.items);
        })
        .catch(() => undefined);
    }, presenceHeartbeatDelay);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [presenceMode, workId]);

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
          replaceImages(initialEditor.images);
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
    if (!draftHydrated || recoveryDraft) return;
    if (!hasUnsaved) {
      void deleteTranslationDraft(user.id, workId).catch(() => undefined);
      return;
    }
    const draft = createTranslationDraft(
      user.id,
      workId,
      images,
      editorHeadRef.current,
    );
    void saveTranslationDraft(draft).catch(() => {
      setMessage("无法写入浏览器本地草稿，请不要关闭页面。");
      setSaveState("failed");
    });
  }, [draftHydrated, hasUnsaved, images, recoveryDraft, user.id, workId]);

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
    <div className="translation-editor">
      {showEntryChoice && (
        <div className="translation-entry-choice-backdrop">
          <section
            className="translation-entry-choice"
            role="dialog"
            aria-modal="true"
            aria-labelledby="translation-entry-choice-title"
          >
            <div className="translation-entry-choice-icon">
              <Users size={22} />
            </div>
            <div>
              <p>协作状态</p>
              <h2 id="translation-entry-choice-title">
                {otherActiveEditors.length
                  ? "已有成员正在编辑"
                  : editor.data.joinableStage
                    ? `加入${stageCopy(editor.data.joinableStage)}协作`
                    : "进入协作编辑"}
              </h2>
            </div>
            {otherActiveEditors.length > 0 && (
              <ul>
                {otherActiveEditors.map((participant, index) => (
                  <li key={`${participant.userId}:${index}`}>
                    <UserRoundCheck size={16} />
                    <span>{participant.displayName}</span>
                    <small>正在编辑</small>
                  </li>
                ))}
              </ul>
            )}
            <p className="translation-entry-choice-copy">
              {editor.data.joinableStage
                ? `加入后会将你记录为${stageCopy(editor.data.joinableStage)}协作者，并允许共同编辑。`
                : "协作编辑允许多人同时工作；保存时仍会校验条目版本，冲突内容不会被静默覆盖。"}
            </p>
            <div className="translation-entry-choice-actions">
              <Button
                variant="secondary"
                disabled={entryChoicePending}
                onClick={chooseViewMode}
              >
                仅查看
              </Button>
              {(editor.data.canEdit || editor.data.joinableStage) && (
                <Button
                  loading={entryChoicePending}
                  onClick={() => void enterCollaboration()}
                >
                  {editor.data.joinableStage
                    ? `加入${stageCopy(editor.data.joinableStage)}协作`
                    : "进入协作"}
                </Button>
              )}
            </div>
          </section>
        </div>
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
            第 {Math.min(pageIndex + 1, images.length || 1)} / {images.length}{" "}
            页 · 正式版本 {editor.data.latestVersion?.versionNumber ?? 0}
            {editor.data.collaborationMode === "multi" &&
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
        {presenceMode === "view" &&
          (editor.data.canEdit || editor.data.joinableStage) && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowEntryChoice(true)}
            >
              加入协作
            </Button>
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
          <Button
            size="sm"
            variant="secondary"
            leadingIcon={<RotateCcw size={15} />}
            disabled={
              hasUnsaved ||
              !online ||
              saveState === "syncing" ||
              Boolean(recoveryDraft)
            }
            onClick={() => void cancelCurrentSubmission()}
          >
            取消{stageCopy(cancelableSubmissionStage)}提交
          </Button>
        )}
        {submissionStage && (
          <>
            {editor.data.collaborationMode === "multi" && (
              <Button
                size="sm"
                variant="secondary"
                disabled={
                  !writable ||
                  editor.data.contributionCurrent ||
                  !editor.data.assignedImageIds.length ||
                  hasUnsaved ||
                  !online ||
                  saveState === "syncing" ||
                  editor.data.reviewStatus !== "normal"
                }
                onClick={() => void completeMyPart()}
              >
                {editor.data.contributionCurrent
                  ? "分工已完成"
                  : "完成我的部分"}
              </Button>
            )}
            <Button
              size="sm"
              disabled={
                !writable ||
                hasUnsaved ||
                !online ||
                saveState === "syncing" ||
                editor.data.reviewStatus !== "normal" ||
                (editor.data.collaborationMode === "multi" &&
                  !editor.data.multiStageReady)
              }
              title={
                editor.data.reviewStatus !== "normal"
                  ? "审核事项解决前不能提交阶段"
                  : editor.data.collaborationMode === "multi" &&
                      !editor.data.multiStageReady
                    ? "还有页面未分配、未完成或完成后又被修改"
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
              className={tool === value ? "is-active" : ""}
              aria-pressed={tool === value}
              aria-label={label}
              disabled={!writable && value !== "pan"}
              onClick={() => {
                markerUndoStack.current = [];
                setTool(value);
              }}
            >
              <ToolIcon size={16} />
              <span>{label}</span>
            </button>
          ))}
        </div>
        <div className="translation-file-actions">
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
              user.roles.includes("admin")) && (
              <Button
                size="sm"
                variant="secondary"
                leadingIcon={<Upload size={15} />}
                loading={labelPlusOperation === "preview"}
                disabled={
                  !writable ||
                  hasUnsaved ||
                  editor.data.reviewStatus !== "normal"
                }
                title={
                  editor.data.reviewStatus !== "normal"
                    ? "审核事项解决前不能导入正式版本"
                    : hasUnsaved
                      ? "请先同步当前本地修改"
                      : undefined
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
              leadingIcon={<Download size={15} />}
              loading={labelPlusOperation === "export"}
              disabled={hasUnsaved}
              title={hasUnsaved ? "请先同步当前本地修改" : undefined}
              onClick={() => void exportLabelPlus()}
            >
              导出 LabelPlus
            </Button>
          )}
        </div>
        <div className="translation-zoom-group">
          <IconButton
            size="sm"
            label="缩小"
            onClick={() => setZoom((value) => clamp(value - 0.2, 0.4, 3))}
          >
            <ZoomOut size={16} />
          </IconButton>
          <span>{Math.round(zoom * 100)}%</span>
          <IconButton
            size="sm"
            label="放大"
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
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void resolveWithServer()}
                >
                  使用服务端版本
                </Button>
                <Button size="sm" onClick={() => void reapplyLocalDraft()}>
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
          </div>
        )}
      </div>
      <main className="translation-editor-main">
        <section
          ref={canvasRef}
          tabIndex={0}
          aria-label="图片标记画布，Alt 加滚轮缩放，Ctrl 加 Z 撤销连续新标点"
          className={`translation-canvas is-tool-${tool}`}
          onPointerDown={stagePointerDown}
          onPointerMove={stagePointerMove}
          onPointerUp={stagePointerUp}
          onPointerCancel={stagePointerUp}
        >
          {currentImage && isDisplayableImageUrl(imageUrl.data?.url) ? (
            <div
              className="translation-image-layer"
              style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
            >
              <div
                className="translation-image-frame"
                style={
                  {
                    transform: `scale(${zoom})`,
                    "--translation-marker-scale": 1 / zoom,
                  } as React.CSSProperties
                }
              >
                <img
                  ref={imageRef}
                  src={imageUrl.data!.url}
                  alt={`第 ${pageIndex + 1} 页`}
                  draggable={false}
                />
                {currentEntries.map((entry, index) => (
                  <MarkerTooltip
                    key={`${entry.id}:${zoom}:${offset.x}:${offset.y}:${tool}`}
                    text={entry.translatedText}
                  >
                    <button
                      type="button"
                      className={`translation-marker is-${entry.markerPositionType}${selectedEntryId === entry.id ? " is-selected" : ""}${entry.localOnly ? " is-local" : ""}`}
                      style={{
                        left: `${entry.markerX * 100}%`,
                        top: `${entry.markerY * 100}%`,
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
          ) : imageUrl.isPending ? (
            <div className="translation-canvas-empty">
              <LoaderCircle className="ui-spin" />
              正在加载图片…
            </div>
          ) : (
            <div className="translation-canvas-empty">
              <ImageIcon />
              当前图片暂时无法显示
            </div>
          )}
          <div className="translation-page-controls">
            <IconButton
              label="上一页"
              disabled={pageIndex === 0}
              onClick={() => goToPage(pageIndex - 1)}
            >
              <ChevronLeft />
            </IconButton>
            <form className="translation-page-jump" onSubmit={submitPageJump}>
              <label htmlFor="translation-page-jump">页码</label>
              <input
                id="translation-page-jump"
                type="number"
                min={1}
                max={Math.max(1, images.length)}
                inputMode="numeric"
                value={pageJump}
                disabled={!images.length}
                aria-label={`跳转页码，共 ${images.length} 页`}
                onChange={(event) => setPageJump(event.target.value)}
                onBlur={() => {
                  if (!pageJump) setPageJump(String(pageIndex + 1));
                }}
              />
              <span>/ {images.length}</span>
            </form>
            <IconButton
              label="下一页"
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
            <p className="translation-readonly-notice">
              {recoveryDraft
                ? "请先处理本地与云端内容，再继续编辑。"
                : presenceMode === "view" &&
                    (editor.data.canEdit || editor.data.joinableStage)
                  ? "当前以只读方式查看；加入协作后可以保存修改。"
                  : "需要先加入翻译或校对协作，才能保存修改。"}
            </p>
          )}
          <div className="translation-entry-list">
            {currentEntries.length ? (
              currentEntries.map((entry, index) => (
                <article
                  key={entry.id}
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
                    <Badge
                      tone={
                        entry.markerPositionType === "inside"
                          ? "translation"
                          : "violet"
                      }
                    >
                      {entry.markerPositionType === "inside" ? "框内" : "框外"}
                    </Badge>
                    {entry.localOnly && <Badge tone="warning">待创建</Badge>}
                    <div className="translation-entry-actions">
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
                      value={entry.translatedText}
                      disabled={!writable || entry.localOnly}
                      placeholder={
                        entry.localOnly ? "标记同步后即可输入" : "输入对应译文"
                      }
                      onFocus={() => selectEntry(entry.id)}
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
                        disabled={!writable || entry.localOnly}
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
                <p>选择“添加框内”或“添加框外”，再点击图片中的文字位置。</p>
              </div>
            )}
          </div>
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
