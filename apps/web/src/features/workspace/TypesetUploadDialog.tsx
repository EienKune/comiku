import { pollTransfer } from "./transfers-api";
import { useImageUrl } from "../../components/use-image-url";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Upload, X } from "lucide-react";
import type { components } from "@comiku/api-client";
import { Button, SelectField } from "../../components/ui";
import { ImageLightbox } from "../../components/ImageLightbox";
import { isDisplayableImageUrl } from "../../components/media-url";
import { useAccount } from "../account/account-context";
import { authenticatedFetch, client, unwrap } from "../account/api";
import { useAction } from "../account/use-action";
import { Feedback } from "../account/forms";
import {
  initialTypesetUploadImages,
  typesetUploadGroupProblem,
  uploadFileChecksum,
  typesetUploadContentType,
  type UploadImage,
} from "./typeset-upload-plan";
import { refreshTypesetWork } from "./typeset-batch-api";

type Session = components["schemas"]["TypesetUploadSessionDto"];
type Plan = components["schemas"]["TypesetUploadPlanDto"] & {
  status?: "uploaded" | "failed";
  message?: string;
};
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
  );
  const src = query.data?.url;
  return (
    <button
      type="button"
      className="workspace-upload-thumb"
      aria-label={`预览 ${image.sourceName}`}
      onClick={onPreview}
    >
      {src && isDisplayableImageUrl(src) ? (
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
  );
  return (
    <ImageLightbox
      src={
        query.data?.url && isDisplayableImageUrl(query.data.url)
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
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const action = useAction();
  const [files, setFiles] = useState<File[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [images, setImages] = useState<UploadImage[]>([]);
  const [targets, setTargets] = useState<Target[]>([]);
  const [checks, setChecks] = useState<
    Record<string, { merge: boolean; content: boolean; manual: boolean }>
  >({});
  const [plans, setPlans] = useState<Plan[]>([]);
  const [uploaded, setUploaded] = useState<number[]>([]);
  const [progress, setProgress] = useState("");
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
    setImages(initialTypesetUploadImages(result));
    setPlans([]);
    setChecks({});
  }
  async function getTargets() {
    const result = await unwrap(
      await client.GET("/api/typeset/handoff-manifest"),
    );
    setTargets(result.items);
  }
  async function extract(id: string) {
    const queued = await unwrap(
      await client.POST("/api/typeset/upload-sessions/{id}/extract", {
        params: { path: { id } },
        body: {},
      }),
    );
    const result = await pollTransfer(
      queued,
      async () =>
        unwrap(
          await client.GET("/api/typeset/upload-sessions/{id}", {
            params: { path: { id } },
          }),
        ),
      ["extracting"],
    );
    applySession(result);
    await getTargets();
    setProgress("");
  }
  function updateImages(update: (previous: UploadImage[]) => UploadImage[]) {
    setImages(update);
    setPlans([]);
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
    setPlans([]);
  }
  async function upload() {
    await action.run(async () => {
      if (!files.length) throw new Error("请选择成图或 ZIP");
      if (
        files.length > 200 ||
        files.reduce((total, file) => total + file.size, 0) >
          (session?.maxTotalBytes ?? 512 * 1024 * 1024)
      )
        throw new Error("所选文件超过整批数量或容量上限");
      const descriptors = [];
      for (const file of files) {
        const type = typesetUploadContentType(file);
        if (file.size > (type === "application/zip" ? 250 : 25) * 1024 * 1024)
          throw new Error(`${file.name} 超过单文件容量上限`);
        setProgress(`正在校验：${file.name}`);
        descriptors.push({
          sourceName: file.name,
          contentType: typesetUploadContentType(file),
          size: file.size,
          checksum: await uploadFileChecksum(file),
        });
      }
      const created = await unwrap(
        await client.POST("/api/typeset/upload-sessions", {
          body: { files: descriptors },
        }),
      );
      setSession(created);
      setUploaded([]);
      localStorage.setItem(storageKey, created.id);
      setSavedId(created.id);
      for (const item of created.files) {
        const index = created.files.findIndex((row) => row.id === item.id);
        if (!active.current) return;
        if (!item.upload) continue;
        setProgress(
          `正在上传 ${index + 1}/${files.length}：${item.sourceName}`,
        );
        try {
          const response = await authenticatedFetch(item.upload.url, {
            method: item.upload.method,
            headers: item.upload.headers,
            body: files[index],
          });
          if (!response.ok)
            setProgress(`${item.sourceName} 未上传成功，继续其他文件`);
        } catch {
          setProgress(`${item.sourceName} 上传连接中断，继续其他文件`);
        }
      }
      setFiles([]);
      setProgress("正在服务端受限解包与生成预览…");
      await extract(created.id);
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
      setUploaded([]);
      if (previous.status === "extracting")
        throw new Error("服务端仍在解析，可稍后再次恢复");
      await extract(previous.id);
    });
  }
  async function previewPlans() {
    if (!session) return;
    await action.run(async () => {
      const configured = groups.filter(
        ([target]) => target && !uploaded.includes(Number(target)),
      );
      if (!configured.length) throw new Error("请先指定需要上传的作品");
      const result = await unwrap(
        await client.POST("/api/typeset/upload-sessions/{id}/plans", {
          params: { path: { id: session.id } },
          body: {
            groups: configured.map(([target, rows]) => ({
              workNumber: Number(target),
              imageIds: rows.map((image) => image.id),
              mergeConfirmed: checks[target]?.merge ?? false,
              contentConfirmed: checks[target]?.content ?? false,
              manualTargetConfirmed: checks[target]?.manual ?? false,
            })),
          },
        }),
      );
      setPlans(result.items);
      setProgress("");
    });
  }
  async function confirm(rows: Plan[]) {
    if (!session) return;
    await action.run(async () => {
      for (const plan of rows) {
        if (!active.current) break;
        if (!plan.previewId) continue;
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
                    message: result.stageSubmitted
                      ? "已上传成图并提交嵌字，进入待发布"
                      : "此会话已保存成图版本，未提交嵌字；请到作品详情处理",
                  }
                : row,
            ),
          );
          setUploaded((previous) => [
            ...new Set([...previous, plan.workNumber]),
          ]);
          await refreshTypesetWork(result.workId);
        } catch (error) {
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
          if (plan.workId) await refreshTypesetWork(plan.workId);
        }
      }
      setProgress("");
      onStatus("成图批量上传已处理，请查看逐项结果");
    });
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
            选择成图与 ZIP
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
            上传并解析预览
          </Button>
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
              <div className="workspace-upload-image-grid">
                {rows.map((image, index) => (
                  <div className="workspace-upload-image" key={image.id}>
                    {session && (
                      <PreviewImage
                        sessionId={session.id}
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
                              ? { ...row, target: value }
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
                      `检查通过：${plan.imageCount} 张，可上传并提交嵌字`}
                  </p>
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
        {!!session && (
          <p className="account-notice">
            “检查提交条件”只检查匹配、权限与当前状态，不创建版本或提交。
            图片、页序或作品状态变化后需重新检查；最终确认处理通过检查的作品，失败项保留供单独重试。
          </p>
        )}
        {!!session && (
          <div className="workspace-dialog-actions">
            <Button
              variant="secondary"
              disabled={action.busy || !groups.length}
              onClick={() => void previewPlans()}
            >
              检查提交条件
            </Button>
            <Button
              loading={action.busy}
              disabled={
                !plans.some(
                  (plan) =>
                    plan.previewId && !plan.error && plan.status !== "uploaded",
                )
              }
              onClick={() =>
                void confirm(
                  plans.filter(
                    (plan) =>
                      plan.previewId &&
                      !plan.error &&
                      plan.status !== "uploaded",
                  ),
                )
              }
            >
              确认上传并提交嵌字
            </Button>
          </div>
        )}
        {groups.some(([target]) => !target) && (
          <p className="account-notice">
            未指定目标的图片会保留为待处理，不影响其他合法项目。
          </p>
        )}
      </dialog>
      {preview && session && (
        <UploadLightbox
          sessionId={session.id}
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
