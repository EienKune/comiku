import {
  extractTypesetSession,
  matchTypesetSessionFiles,
  uploadTypesetFiles,
} from "./typeset-upload-transfer";
import { useImageUrl } from "../../components/use-image-url";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  CircleAlert,
  LoaderCircle,
  Upload,
  X,
} from "lucide-react";
import type { components } from "@comiku/api-client";
import { Button, SelectField } from "../../components/ui";
import { ImageLightbox } from "../../components/ImageLightbox";
import { isDisplayableImageUrl } from "../../components/media-url";
import { useAccount } from "../account/account-context";
import { client, unwrap } from "../account/api";
import { useAction } from "../account/use-action";
import { Feedback } from "../account/forms";
import {
  initialTypesetUploadImages,
  suggestedTypesetPageId,
  orderedTypesetPageMappings,
  typesetUploadGroupProblem,
  type UploadImage,
} from "./typeset-upload-plan";
import { refreshTypesetWork } from "./typeset-batch-api";
import {
  prepareLocalTypesetImages,
  releaseLocalTypesetImages,
  type LocalTypesetImage,
} from "./typeset-local-files";

type Session = components["schemas"]["TypesetUploadSessionDto"];
type Plan = components["schemas"]["TypesetUploadPlanDto"] & {
  status?: "uploaded" | "failed";
  message?: string;
  stageSubmitted?: boolean;
  workCompleted?: boolean;
  refreshWarning?: string;
};
type Collaboration = components["schemas"]["TypesetCollaborationStateDto"];
type Target = components["schemas"]["TypesetHandoffManifestItemDto"];

function PreviewImage({
  sessionId,
  image,
  onPreview,
}: {
  sessionId: string;
  image: UploadImage;
  onPreview: () => void;
}) {
  const thumb = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(
    typeof IntersectionObserver === "undefined",
  );
  useEffect(() => {
    if (visible || !thumb.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "160px" },
    );
    observer.observe(thumb.current);
    return () => observer.disconnect();
  }, [visible]);
  const query = useImageUrl(
    ["thumbnail", "typeset-upload-image", sessionId, image.id],
    async () =>
      unwrap(
        await client.GET(
          "/api/typeset/upload-sessions/{id}/images/{imageId}/url",
          {
            params: {
              path: { id: sessionId, imageId: image.id },
              query: { variant: "thumbnail" },
            },
          },
        ),
      ),
    visible && !image.localUrl,
  );
  const src = image.localUrl ?? query.data?.url;
  return (
    <button
      type="button"
      ref={thumb}
      className="workspace-upload-thumb"
      aria-label={`预览 ${image.sourceName}`}
      onClick={onPreview}
    >
      {src && (image.localUrl || isDisplayableImageUrl(src)) ? (
        <img src={src} alt={image.sourceName} loading="lazy" />
      ) : (
        <span>{query.isError ? "预览加载失败" : "加载预览…"}</span>
      )}
    </button>
  );
}

function UploadLightbox({
  sessionId,
  images,
  index,
  onClose,
  onChange,
}: {
  sessionId: string;
  images: UploadImage[];
  index: number;
  onClose: () => void;
  onChange: (index: number) => void;
}) {
  const image = images[index];
  const query = useImageUrl(
    ["typeset-upload-image", sessionId, image.id],
    async () =>
      unwrap(
        await client.GET(
          "/api/typeset/upload-sessions/{id}/images/{imageId}/url",
          { params: { path: { id: sessionId, imageId: image.id } } },
        ),
      ),
    !image.localUrl,
  );
  return (
    <ImageLightbox
      src={
        image.localUrl
          ? image.localUrl
          : query.data?.url && isDisplayableImageUrl(query.data.url)
            ? query.data.url
            : undefined
      }
      alt={image.sourceName}
      loading={query.isPending}
      index={index}
      count={images.length}
      onClose={onClose}
      onPrevious={index > 0 ? () => onChange(index - 1) : undefined}
      onNext={index + 1 < images.length ? () => onChange(index + 1) : undefined}
    />
  );
}

export function TypesetUploadDialog({
  open,
  onClose,
  onHandoff,
  onStatus,
}: {
  open: boolean;
  onClose: () => void;
  onHandoff: (workId: string) => void;
  onStatus: (message: string) => void;
}) {
  const user = useAccount();
  const dialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const active = useRef(true);
  const transfer = useRef<AbortController | null>(null);
  const uploadRetry = useRef<{ files: File[]; sessionId: string } | null>(null);
  const recoverySelection = useRef<{
    original: File[];
    files: File[];
    sessionId: string;
  } | null>(null);
  const localImages = useRef<LocalTypesetImage[]>([]);
  const selectedKey = useRef("");
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      transfer.current?.abort();
      releaseLocalTypesetImages(localImages.current);
    };
  }, []);
  const action = useAction();
  const [files, setFiles] = useState<File[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [recoverySessionId, setRecoverySessionId] = useState<string | null>(
    null,
  );
  const [images, setImages] = useState<UploadImage[]>([]);
  const [targets, setTargets] = useState<Target[]>([]);
  const [states, setStates] = useState<Record<string, Collaboration>>({});
  const [stateErrors, setStateErrors] = useState<Record<string, string>>({});
  const confirming = useRef(false);
  const [checks, setChecks] = useState<
    Record<string, { merge: boolean; content: boolean; manual: boolean }>
  >({});
  const [plans, setPlans] = useState<Plan[]>([]);
  const [uploaded, setUploaded] = useState<number[]>([]);
  const [progress, setProgress] = useState("");
  const [confirmationProgress, setConfirmationProgress] = useState<{
    current: number;
    total: number;
    workNumber: number;
  } | null>(null);
  const [preview, setPreview] = useState<{
    images: UploadImage[];
    index: number;
  } | null>(null);
  const storageKey = `comiku:typeset-upload-session:${user.id}`;
  const [savedId, setSavedId] = useState(() =>
    localStorage.getItem(storageKey),
  );
  const groups = useMemo(() => {
    const result = new Map<string, UploadImage[]>();
    for (const image of images.filter((image) => image.included))
      result.set(image.target, [...(result.get(image.target) ?? []), image]);
    return [...result.entries()];
  }, [images]);
  const pendingGroups = groups.filter(
    ([target]) => target && !uploaded.includes(Number(target)),
  );
  const retryPlans = plans.filter(
    (plan) => plan.previewId && !plan.error && plan.status !== "uploaded",
  );
  const confirmedPlans = plans.filter((plan) => plan.status === "uploaded");
  const completedCount = confirmedPlans.filter(
    (plan) => plan.stageSubmitted && plan.workCompleted !== false,
  ).length;
  const waitingCount = confirmedPlans.filter(
    (plan) => plan.stageSubmitted && plan.workCompleted === false,
  ).length;
  const savedCount = confirmedPlans.length - completedCount - waitingCount;
  const failedCount = plans.filter(
    (plan) => plan.status === "failed" || plan.error,
  ).length;
  const hasResults =
    confirmedPlans.length > 0 || plans.some((plan) => plan.status === "failed");
  const hasUnfinished =
    pendingGroups.length > 0 ||
    groups.some(([target]) => !target) ||
    !!session?.files.some((file) => file.error);
  const resultTitle = failedCount
    ? confirmedPlans.length
      ? "部分作品未完成"
      : "交稿未完成"
    : hasUnfinished
      ? "已提交部分作品"
      : savedCount
        ? "成图已保存，嵌字尚未提交"
        : waitingCount
          ? "本人已交稿，等待其他成员"
          : "交稿完成";
  const resultDetails = [
    completedCount ? `${completedCount} 部进入待发布` : "",
    waitingCount ? `${waitingCount} 部等待其他成员` : "",
    savedCount ? `${savedCount} 部仅保存成图，需到作品详情处理` : "",
    pendingGroups.length
      ? `${pendingGroups.length} 部未完成${failedCount ? "，可检查或重试" : ""}`
      : "",
    groups.some(([target]) => !target) ? "仍有未指定目标的图片" : "",
    session?.files.some((file) => file.error) ? "仍有文件未成功解析" : "",
  ]
    .filter(Boolean)
    .join("；");
  useEffect(() => {
    const element = dialog.current;
    if (element) {
      if (open && !preview) {
        if (typeof element.showModal === "function") element.showModal();
        else element.setAttribute("open", "");
      } else if (typeof element.close === "function") element.close();
      else element.removeAttribute("open");
    }
    return () => {
      if (typeof element?.close === "function") element.close();
    };
  }, [open, preview]);

  function applySession(result: Session) {
    setSession(result);
    setStates({});
    setStateErrors({});
    const receipts = result.receipts ?? [];
    setImages(
      initialTypesetUploadImages(result).map((image) => {
        const receipt = receipts.find((item) =>
          item.imageIds.includes(image.id),
        );
        return receipt
          ? { ...image, target: String(receipt.workNumber) }
          : image;
      }),
    );
    setUploaded(receipts.map((item) => item.workNumber));
    setPlans(
      receipts.map((item) => ({
        workNumber: item.workNumber,
        workId: item.workId,
        title: null,
        previewId: null,
        workRevision: null,
        editorEpoch: null,
        handoffStartedAt: null,
        imageCount: item.imageIds.length,
        error: null,
        status: "uploaded",
        stageSubmitted: item.stageSubmitted,
        workCompleted: item.workCompleted,
        message: item.stageSubmitted
          ? item.workCompleted
            ? "已上传成图并提交嵌字，进入待发布"
            : "已保存成图并提交本人负责页，等待其他成员"
          : "此会话已保存成图版本，未提交嵌字；请到作品详情处理",
      })),
    );
    setChecks({});
  }
  const targetKeys = groups
    .map(([target]) => target)
    .filter(Boolean)
    .join(",");
  useEffect(() => {
    if (!open || !images.length) return;
    let cancelled = false;
    void (async () => {
      for (const number of targetKeys.split(",")) {
        const target = targets.find(
          (item) => String(item.workNumber) === number,
        );
        if (!target || cancelled) continue;
        try {
          const state = await unwrap(
            await client.GET("/api/works/{workId}/typeset/collaboration", {
              params: { path: { workId: target.workId } },
            }),
          );
          if (!cancelled) {
            setStates((previous) => ({ ...previous, [number]: state }));
            setStateErrors((previous) => ({ ...previous, [number]: "" }));
          }
        } catch (error) {
          if (!cancelled)
            setStateErrors((previous) => ({
              ...previous,
              [number]:
                error instanceof Error ? error.message : "页映射加载失败",
            }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, images.length, targets, targetKeys]);

  async function getTargets() {
    const result = await unwrap(
      await client.GET("/api/typeset/handoff-manifest"),
    );
    setTargets(result.items);
  }
  async function extract(id: string) {
    transfer.current = new AbortController();
    const result = await extractTypesetSession(id, {
      onProgress: setProgress,
      signal: transfer.current.signal,
    });
    applySession(result);
    await getTargets();
    setProgress("");
  }
  function updateImages(update: (previous: UploadImage[]) => UploadImage[]) {
    setImages(update);
    setPlans((previous) =>
      previous.filter((plan) => plan.status === "uploaded"),
    );
  }
  function updateCheck(
    target: string,
    patch: Partial<{ merge: boolean; content: boolean; manual: boolean }>,
  ) {
    setChecks((previous) => ({
      ...previous,
      [target]: {
        ...(previous[target] ?? {
          merge: false,
          content: false,
          manual: false,
        }),
        ...patch,
      },
    }));
    setPlans((previous) =>
      previous.filter((plan) => plan.status === "uploaded"),
    );
  }
  async function upload() {
    await action.run(async () => {
      transfer.current = new AbortController();
      if (recoverySessionId) {
        let prepared: LocalTypesetImage[] = [];
        try {
          let selected = recoverySelection.current;
          if (
            !selected ||
            selected.sessionId !== recoverySessionId ||
            selected.original.length !== files.length ||
            selected.original.some((file, index) => file !== files[index])
          ) {
            let candidates = files;
            if (session?.files.every((file) => !file.archive)) {
              prepared = await prepareLocalTypesetImages(files, {
                signal: transfer.current.signal,
                onProgress: setProgress,
              });
              candidates = await matchTypesetSessionFiles(
                session,
                prepared.map((image) => image.file),
                {
                  allowExtraFiles: true,
                  signal: transfer.current.signal,
                },
              );
            }
            selected = {
              original: files,
              files: candidates,
              sessionId: recoverySessionId,
            };
            recoverySelection.current = selected;
          }
          const result = await uploadTypesetFiles(selected.files, {
            sessionId: recoverySessionId,
            signal: transfer.current.signal,
            onProgress: setProgress,
            onSession: applySession,
          });
          applySession(result);
          setRecoverySessionId(null);
          setFiles([]);
          if (fileInput.current) fileInput.current.value = "";
          await getTargets();
          setProgress("");
          recoverySelection.current = null;
          return;
        } finally {
          releaseLocalTypesetImages(prepared);
        }
      }
      const result = await prepareLocalTypesetImages(files, {
        signal: transfer.current.signal,
        onProgress: setProgress,
      });
      releaseLocalTypesetImages(localImages.current);
      localImages.current = result;
      setSession(null);
      setImages(result);
      setPlans([]);
      setUploaded([]);
      setChecks({});
      setStates({});
      uploadRetry.current = null;
      recoverySelection.current = null;
      selectedKey.current = "";
      setFiles([]);
      await getTargets();
      setProgress("");
    });
  }
  async function resume() {
    if (!savedId) return;
    await action.run(async () => {
      setProgress("正在恢复已上传文件…");
      const previous = await unwrap(
        await client.GET("/api/typeset/upload-sessions/{id}", {
          params: { path: { id: savedId } },
        }),
      );
      releaseLocalTypesetImages(localImages.current);
      localImages.current = [];
      uploadRetry.current = null;
      recoverySelection.current = null;
      selectedKey.current = "";
      setFiles([]);
      if (fileInput.current) fileInput.current.value = "";
      setUploaded([]);
      setRecoverySessionId(null);
      if (
        previous.files.some(
          (file) => !file.archive && file.status !== "processed",
        )
      ) {
        // Browser dimensions and original bytes are deliberately not persisted.
        // Keep the owned session and completed subset while asking for exact files.
        applySession(previous);
        setRecoverySessionId(previous.id);
        await getTargets();
        setProgress("");
        return;
      }
      if (
        previous.status === "previewed" &&
        previous.files.every((file) => file.status === "processed")
      ) {
        applySession(previous);
        await getTargets();
        setProgress("");
      } else await extract(previous.id);
    });
  }
  async function previewPlans() {
    await action.run(async () => {
      setProgress("正在检查作品状态与本人页映射…");
      let configured = groups.filter(
        ([target]) => target && !uploaded.includes(Number(target)),
      );
      if (!configured.length) throw new Error("请先指定需要上传的作品");
      // Ownership and selection are resolved before creating any upload session.
      configured = configured
        .map(([target, rows]) => {
          const state = states[target];
          if (!state) throw new Error(`#${target}：请等待作品状态加载`);
          if (!checks[target]?.content)
            throw new Error(`#${target}：请先预览核对成图`);
          const problem = typesetUploadGroupProblem(
            rows,
            checks[target]?.merge ?? false,
          );
          if (problem) throw new Error(`#${target}：${problem}`);
          if (state.collaborationMode !== "multi") return [target, rows];
          const participant = state.participants.find(
            (item) => item.userId === user.id,
          );
          const selected = rows.filter((image) => {
            const pageId = suggestedTypesetPageId(image, state.pages);
            if (!pageId)
              throw new Error(`${image.sourceName}：请明确选择本人原稿页`);
            return state.pages.some(
              (page) =>
                page.id === pageId &&
                page.assignment?.participantId === participant?.id &&
                !!participant,
            );
          });
          const mappedPages = selected.map((image) =>
            suggestedTypesetPageId(image, state.pages),
          );
          if (new Set(mappedPages).size !== mappedPages.length)
            throw new Error(`#${target}：同一原稿页只能选择一张成图`);
          return [target, selected];
        })
        .filter(([, rows]) => rows.length) as [string, UploadImage[]][];
      if (!configured.length) throw new Error("本次没有选中本人负责的成图");
      let currentSession = session;
      const ids: Record<string, string> = {};
      if (localImages.current.length) {
        const wanted = new Set(
          configured.flatMap(([, rows]) => rows.map((image) => image.id)),
        );
        const selected = localImages.current.filter((image) =>
          wanted.has(image.id),
        );
        const key = selected.map((image) => image.id).join();
        if (key !== selectedKey.current) {
          uploadRetry.current = null;
          selectedKey.current = key;
        }
        const selectedFiles =
          uploadRetry.current?.files ?? selected.map((image) => image.file);
        currentSession = await uploadTypesetFiles(selectedFiles, {
          requireComplete: true,
          sessionId: uploadRetry.current?.sessionId,
          onProgress: setProgress,
          onSession: (created) => {
            setSession(created);
            uploadRetry.current = {
              files: selectedFiles,
              sessionId: created.id,
            };
            localStorage.setItem(storageKey, created.id);
            setSavedId(created.id);
          },
        });
        const remote = currentSession.files.flatMap((file) => file.images);
        if (remote.length !== selected.length)
          throw new Error("文件校验结果不完整，请重试检查");
        selected.forEach((image, index) => {
          ids[image.id] = remote[index].id;
        });
      }
      if (!currentSession) throw new Error("请先选择成图");
      const result = await unwrap(
        await client.POST("/api/typeset/upload-sessions/{id}/plans", {
          params: { path: { id: currentSession.id } },
          body: {
            groups: configured.map(([target, rows]) => ({
              workNumber: Number(target),
              imageIds: rows.map((image) => ids[image.id] ?? image.id),
              mergeConfirmed: checks[target]?.merge ?? false,
              contentConfirmed: checks[target]?.content ?? false,
              manualTargetConfirmed:
                !!localImages.current.length ||
                (checks[target]?.manual ?? false),
              ...(states[target]?.collaborationMode === "multi"
                ? {
                    pageMappings: rows.map((image) => ({
                      imageId: ids[image.id] ?? image.id,
                      workImageId: suggestedTypesetPageId(
                        image,
                        states[target].pages,
                      ),
                    })),
                  }
                : {}),
            })),
          },
        }),
      );
      setPlans((previous) => [
        ...previous.filter((plan) => plan.status === "uploaded"),
        ...result.items,
      ]);
      setProgress("");
    });
  }
  async function confirm(rows: Plan[]) {
    if (!session || confirming.current) return;
    confirming.current = true;
    try {
      await action.run(async () => {
        let submitted = 0;
        let failed = 0;
        for (const [index, plan] of rows.entries()) {
          if (!active.current) break;
          if (!plan.previewId) continue;
          setConfirmationProgress({
            current: index + 1,
            total: rows.length,
            workNumber: plan.workNumber,
          });
          setProgress(`正在确认 #${plan.workNumber}`);
          onStatus(`成图上传 · 正在处理 #${plan.workNumber}`);
          try {
            const result = await unwrap(
              await client.POST("/api/typeset/upload-sessions/{id}/confirm", {
                params: { path: { id: session.id } },
                body: { previewId: plan.previewId },
              }),
            );
            setPlans((previous) =>
              previous.map((row) =>
                row.workNumber === plan.workNumber
                  ? {
                      ...row,
                      status: "uploaded",
                      stageSubmitted: result.stageSubmitted,
                      workCompleted: result.workCompleted,
                      refreshWarning: undefined,
                      message: result.stageSubmitted
                        ? result.workCompleted === false
                          ? "已保存成图并提交本人负责页，等待其他成员"
                          : "已上传成图并提交嵌字，进入待发布"
                        : "此会话已保存成图版本，未提交嵌字；请到作品详情处理",
                    }
                  : row,
              ),
            );
            setUploaded((previous) => [
              ...new Set([...previous, plan.workNumber]),
            ]);
            submitted++;
          } catch (error) {
            failed++;
            setPlans((previous) =>
              previous.map((row) =>
                row.workNumber === plan.workNumber
                  ? {
                      ...row,
                      status: "failed",
                      message:
                        error instanceof Error ? error.message : "确认失败",
                    }
                  : row,
              ),
            );
          }
          // A confirmed server receipt remains authoritative even when a
          // follow-up cache refresh fails. Keep processing the other works.
          if (plan.workId) {
            try {
              await refreshTypesetWork(plan.workId);
            } catch {
              setPlans((previous) =>
                previous.map((row) =>
                  row.workNumber === plan.workNumber
                    ? {
                        ...row,
                        refreshWarning:
                          "页面状态刷新失败，可重新打开作品查看最新状态。",
                      }
                    : row,
                ),
              );
            }
          }
        }
        setProgress("");
        onStatus(
          `成图批量处理结束：${submitted} 部已保存${failed ? `，${failed} 部未完成，可重试` : "，请查看交稿结果"}`,
        );
      });
    } finally {
      confirming.current = false;
      setConfirmationProgress(null);
    }
  }
  function move(imageId: string, delta: number, rows: UploadImage[]) {
    const position = rows.findIndex((image) => image.id === imageId),
      other = rows[position + delta];
    if (!other) return;
    updateImages((previous) => {
      const result = [...previous];
      const left = result.findIndex((image) => image.id === imageId),
        right = result.findIndex((image) => image.id === other.id);
      [result[left], result[right]] = [result[right], result[left]];
      return result;
    });
  }
  return (
    <>
      <dialog
        ref={dialog}
        aria-label="批量上传成图"
        className="workspace-business-dialog workspace-upload-dialog"
        onCancel={(event) => {
          event.preventDefault();
          if (!action.busy) onClose();
        }}
      >
        <header>
          <div>
            <h2>批量上传成图</h2>
            <p>
              逐作品核对图片与页序，检查提交条件后统一确认，上传并提交嵌字。
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            disabled={action.busy}
            aria-label="关闭成图上传"
            onClick={onClose}
          >
            <X size={18} />
          </Button>
        </header>
        <p>
          支持 PNG / JPEG / WebP 和 ZIP；每部作品 1–100 张、25 MiB/图、250
          MiB/版。ZIP 最多两层目录，不展开嵌套包。当前整批上限{" "}
          {session ? Math.round(session.maxTotalBytes / 1024 / 1024) : 512}{" "}
          MiB、{session?.maxWorks ?? 20} 部作品。
        </p>
        <div className="workspace-dialog-actions">
          <Button
            variant="secondary"
            leadingIcon={<Upload size={16} />}
            disabled={action.busy}
            onClick={() => fileInput.current?.click()}
          >
            {recoverySessionId ? "选择会话原文件" : "选择成图与 ZIP"}
          </Button>
          <input
            ref={fileInput}
            hidden
            type="file"
            multiple
            accept=".png,.jpg,.jpeg,.webp,.zip"
            disabled={action.busy}
            onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
          />
          <Button
            disabled={!files.length}
            loading={action.busy}
            onClick={() => void upload()}
          >
            {recoverySessionId ? "继续恢复上传" : "本地解析预览"}
          </Button>
          {recoverySessionId && (
            <Button
              variant="ghost"
              disabled={action.busy}
              onClick={() => {
                setRecoverySessionId(null);
                recoverySelection.current = null;
                releaseLocalTypesetImages(localImages.current);
                localImages.current = [];
                uploadRetry.current = null;
                selectedKey.current = "";
                setSession(null);
                setImages([]);
                setPlans([]);
                setUploaded([]);
                setChecks({});
                setStates({});
                setStateErrors({});
                setPreview(null);
                setFiles([]);
                if (fileInput.current) fileInput.current.value = "";
              }}
            >
              改为新建上传
            </Button>
          )}
          {savedId && (
            <Button
              variant="ghost"
              disabled={action.busy}
              onClick={() => void resume()}
            >
              恢复上次会话
            </Button>
          )}
        </div>
        {recoverySessionId && (
          <p role="status">
            重新选择此会话的全部原文件或原 ZIP 以继续校验：
            {session?.files.map((file) => file.sourceName).join("、")}
          </p>
        )}
        {!!files.length && (
          <p>
            已选 {files.length} 个文件，共{" "}
            {(
              files.reduce((total, file) => total + file.size, 0) /
              1024 /
              1024
            ).toFixed(1)}{" "}
            MiB
          </p>
        )}
        {action.busy && progress && (
          <p role="status" className="account-notice">
            {progress}
          </p>
        )}
        <Feedback error={action.error} success={action.success} />
        {session?.files
          .filter((file) => file.error)
          .map((file) => (
            <p className="account-error" role="alert" key={file.id}>
              {file.sourceName}：{file.error}
            </p>
          ))}
        {groups.map(([target, rows]) => {
          const plan = plans.find((item) => String(item.workNumber) === target);
          const problem = typesetUploadGroupProblem(
            rows,
            checks[target]?.merge ?? false,
          );
          const isUploaded = uploaded.includes(Number(target));
          const state = states[target];
          const isMulti = state?.collaborationMode === "multi";
          const participantId = state?.participants?.find(
            (p) => p.userId === user.id,
          )?.id;
          const ownPages =
            state?.pages?.filter(
              (page) =>
                !!participantId &&
                page.assignment?.participantId === participantId,
            ) ?? [];
          const orderPages =
            state?.pages?.length === rows.length ? state.pages : ownPages;
          const orderMapping = isMulti
            ? orderedTypesetPageMappings(rows, orderPages)
            : null;
          const archiveCount = new Set(
            rows
              .filter((image) => image.archive)
              .map((image) => image.uploadFileId),
          ).size;
          const needsMerge =
            archiveCount > 1 ||
            (archiveCount > 0 && rows.some((image) => !image.archive));
          return (
            <section className="workspace-upload-group" key={target}>
              <h3>
                {target
                  ? `#${target} · ${targets.find((work) => String(work.workNumber) === target)?.title || "待定标题"}`
                  : "待指定目标"}{" "}
                · {rows.length} 张{isUploaded ? " · 已处理" : ""}
              </h3>
              {problem && (
                <p className="account-error" role="alert">
                  {problem}
                </p>
              )}
              <div className="workspace-dialog-actions">
                <SelectField
                  label="本组成图目标"
                  value={target}
                  disabled={action.busy || isUploaded}
                  onValueChange={(value) =>
                    updateImages((previous) =>
                      previous.map((row) =>
                        rows.some((image) => image.id === row.id)
                          ? { ...row, target: value, workImageId: undefined }
                          : row,
                      ),
                    )
                  }
                >
                  <option value="">待指定</option>
                  {targets.map((work) => (
                    <option key={work.workId} value={String(work.workNumber)}>
                      #{work.workNumber} · {work.title || "待定标题"}
                    </option>
                  ))}
                </SelectField>
                {isMulti && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={action.busy || isUploaded || !orderMapping}
                    onClick={() =>
                      updateImages((previous) =>
                        previous.map((image) =>
                          orderMapping?.[image.id]
                            ? { ...image, workImageId: orderMapping[image.id] }
                            : image,
                        ),
                      )
                    }
                  >
                    按当前顺序对应
                    {orderPages.length === state.pages.length
                      ? "全部原稿"
                      : "本人负责页"}
                  </Button>
                )}
              </div>
              {stateErrors[target] && (
                <p role="alert" className="account-error">
                  {stateErrors[target]}
                </p>
              )}
              <div className="workspace-upload-image-grid">
                {rows.map((image, index) => (
                  <div className="workspace-upload-image" key={image.id}>
                    {(session || image.localUrl) && (
                      <PreviewImage
                        sessionId={session?.id ?? ""}
                        image={image}
                        onPreview={() => setPreview({ images: rows, index })}
                      />
                    )}
                    <strong>{image.sourceName}</strong>
                    <small>
                      {image.width} × {image.height}
                    </small>
                    {image.warnings.map((warning) => (
                      <small key={warning}>{warning}</small>
                    ))}
                    <SelectField
                      label="目标作品"
                      value={image.target}
                      disabled={action.busy || isUploaded}
                      onValueChange={(value) =>
                        updateImages((previous) =>
                          previous.map((row) =>
                            row.id === image.id
                              ? {
                                  ...row,
                                  target: value,
                                  workImageId: undefined,
                                }
                              : row,
                          ),
                        )
                      }
                    >
                      <option value="">待指定</option>
                      {image.target &&
                        !targets.some(
                          (work) => String(work.workNumber) === image.target,
                        ) && (
                          <option value={image.target}>
                            #{image.target} · 不在本人待办
                          </option>
                        )}
                      {targets.map((work) => (
                        <option value={work.workNumber} key={work.workId}>
                          #{work.workNumber} · {work.title || "待定标题"}
                        </option>
                      ))}
                    </SelectField>
                    {isMulti && (
                      <SelectField
                        label="对应原稿"
                        value={suggestedTypesetPageId(image, state.pages)}
                        disabled={action.busy || isUploaded}
                        onValueChange={(value) =>
                          updateImages((previous) =>
                            previous.map((row) =>
                              row.id === image.id
                                ? { ...row, workImageId: value }
                                : row,
                            ),
                          )
                        }
                      >
                        <option value="">请选择原稿页</option>
                        {state.pages.map((page) => (
                          <option key={page.id} value={page.id}>
                            第 {page.orderIndex + 1} 页
                            {page.assignment?.participantId === participantId &&
                            !!participantId
                              ? " · 本人"
                              : " · 将忽略"}
                          </option>
                        ))}
                      </SelectField>
                    )}
                    <div className="workspace-dialog-actions">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`上移 ${image.sourceName}`}
                        disabled={action.busy || isUploaded || index === 0}
                        onClick={() => move(image.id, -1, rows)}
                      >
                        <ArrowUp size={15} />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`下移 ${image.sourceName}`}
                        disabled={
                          action.busy || isUploaded || index === rows.length - 1
                        }
                        onClick={() => move(image.id, 1, rows)}
                      >
                        <ArrowDown size={15} />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={action.busy || isUploaded}
                        onClick={() =>
                          updateImages((previous) =>
                            previous.map((row) =>
                              row.id === image.id
                                ? { ...row, included: false }
                                : row,
                            ),
                          )
                        }
                      >
                        移除此项
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
              {!!target && !isUploaded && (
                <div className="workspace-upload-checks">
                  {needsMerge && (
                    <label>
                      <input
                        type="checkbox"
                        checked={checks[target]?.merge ?? false}
                        disabled={action.busy}
                        onChange={(event) =>
                          updateCheck(target, { merge: event.target.checked })
                        }
                      />
                      明确将本作品多包／裸图合并为一个版本
                    </label>
                  )}
                  {rows.some(
                    (image) => String(image.workNumber) !== target,
                  ) && (
                    <label>
                      <input
                        type="checkbox"
                        checked={checks[target]?.manual ?? false}
                        disabled={action.busy}
                        onChange={(event) =>
                          updateCheck(target, { manual: event.target.checked })
                        }
                      />
                      已核对缺失／冲突编号并确认人工目标
                    </label>
                  )}
                  <label>
                    <input
                      type="checkbox"
                      checked={checks[target]?.content ?? false}
                      disabled={action.busy}
                      onChange={(event) =>
                        updateCheck(target, { content: event.target.checked })
                      }
                    />
                    已预览核对，所选图片为成图（包含说明页）
                  </label>
                </div>
              )}
              {plan && (
                <div className="workspace-batch-item">
                  <p
                    className={
                      plan.error || plan.status === "failed"
                        ? "account-error"
                        : "account-notice"
                    }
                    role="status"
                  >
                    {plan.message ||
                      plan.error ||
                      `检查通过：保存 ${plan.savedImageCount ?? plan.imageCount} 张并提交${isMulti ? "本人负责页" : "嵌字"}${plan.ignored?.length ? `，忽略非本人负责的 ${plan.ignored.length} 张` : ""}`}
                  </p>
                  {plan.refreshWarning && (
                    <p className="account-notice">{plan.refreshWarning}</p>
                  )}
                  {plan.status === "failed" && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={action.busy}
                      onClick={() => void confirm([plan])}
                    >
                      重试此项
                    </Button>
                  )}
                  {plan.error?.includes("交接包") && plan.workId && (
                    <Button
                      size="sm"
                      disabled={action.busy}
                      onClick={() => {
                        onClose();
                        onHandoff(plan.workId!);
                      }}
                    >
                      下载该作品交接包
                    </Button>
                  )}
                </div>
              )}
            </section>
          );
        })}
        {images.some((image) => !image.included) && (
          <details>
            <summary>已移除的图片</summary>
            {images
              .filter((image) => !image.included)
              .map((image) => (
                <div key={image.id}>
                  {image.sourceName}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={action.busy}
                    onClick={() =>
                      updateImages((previous) =>
                        previous.map((row) =>
                          row.id === image.id
                            ? { ...row, included: true }
                            : row,
                        ),
                      )
                    }
                  >
                    恢复选择
                  </Button>
                </div>
              ))}
          </details>
        )}
        {!!images.length && (
          <footer className="workspace-upload-footer">
            {(confirmationProgress || hasResults) && (
              <div
                role="status"
                aria-label="批量交稿结果"
                className={`workspace-upload-result ${confirmationProgress ? "is-processing" : failedCount || hasUnfinished || savedCount ? "is-warning" : "is-complete"}`}
              >
                {confirmationProgress ? (
                  <LoaderCircle size={22} aria-hidden="true" />
                ) : failedCount || hasUnfinished || savedCount ? (
                  <CircleAlert size={22} aria-hidden="true" />
                ) : (
                  <CheckCircle2 size={22} aria-hidden="true" />
                )}
                <div>
                  <strong>
                    {confirmationProgress
                      ? `正在提交 ${confirmationProgress.current} / ${confirmationProgress.total} 部作品`
                      : resultTitle}
                  </strong>
                  <p>
                    {confirmationProgress
                      ? `正在处理 #${confirmationProgress.workNumber}，请保持窗口打开。`
                      : resultDetails}
                  </p>
                </div>
              </div>
            )}
            {!hasResults && !confirmationProgress && (
              <p className="account-notice">
                “检查提交条件”上传并校验本次选中的本人页，不保存版本或提交。文件名仅用于提示，请核对目标和页序。
              </p>
            )}
            <div className="workspace-dialog-actions">
              {pendingGroups.length > 0 && (
                <>
                  <Button
                    variant="secondary"
                    disabled={
                      action.busy ||
                      !pendingGroups.length ||
                      groups.some(
                        ([target]) =>
                          target &&
                          !uploaded.includes(Number(target)) &&
                          (!states[target] || !!stateErrors[target]),
                      )
                    }
                    onClick={() => void previewPlans()}
                  >
                    检查提交条件
                  </Button>
                  {(retryPlans.length > 0 || !hasResults) && (
                    <Button
                      loading={!!confirmationProgress}
                      disabled={action.busy || !retryPlans.length}
                      onClick={() => void confirm(retryPlans)}
                    >
                      {confirmationProgress
                        ? "正在提交嵌字"
                        : plans.some((plan) => plan.status === "failed")
                          ? "重试未完成作品"
                          : "确认上传并提交嵌字"}
                    </Button>
                  )}
                </>
              )}
              {hasResults && (
                <Button
                  variant={pendingGroups.length ? "secondary" : "primary"}
                  disabled={action.busy}
                  onClick={onClose}
                >
                  关闭
                </Button>
              )}
            </div>
          </footer>
        )}
        {groups.some(([target]) => !target) && (
          <p className="account-notice">
            未指定目标的图片会保留为待处理，不影响其他合法项目。
          </p>
        )}
      </dialog>
      {preview && (
        <UploadLightbox
          sessionId={session?.id ?? ""}
          images={preview.images}
          index={preview.index}
          onClose={() => setPreview(null)}
          onChange={(index) =>
            setPreview((previous) => (previous ? { ...previous, index } : null))
          }
        />
      )}
    </>
  );
}
