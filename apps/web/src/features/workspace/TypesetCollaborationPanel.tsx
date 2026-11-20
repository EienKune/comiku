import { FilePickerButton } from "../../components/ImagePicker";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, SelectControl } from "../../components/ui";
import { collaborationRequest } from "./collaboration-request";
import { refreshTypesetWork } from "./typeset-batch-api";
import "./typeset-collaboration.css";

type Draft = {
  id: string;
  workImageId: string | null;
  participantId: string;
  position: string;
  sourceName: string;
  revision: number;
  submittedRevision: number | null;
};
type State = {
  revision: number;
  editorEpoch: number;
  workflowStatus: string;
  handoffReady: boolean;
  pages: {
    id: string;
    orderIndex: number;
    assignment: { participantId: string | null } | null;
  }[];
  participants: { id: string; userId: string; user: { displayName: string } }[];
  drafts: Draft[];
};
type Preview = {
  idempotencyKey?: string;
  sessionId: string;
  expectedRevision: number;
  images: {
    id: string;
    sourceName: string;
    suggestedWorkImageId: string | null;
  }[];
};
type Mapping = {
  imageId: string;
  workImageId?: string;
  draftId?: string;
  position: "page" | "start" | "end";
  ignored?: boolean;
};

function Image({
  path,
  alt,
  revision,
}: {
  path: string;
  alt: string;
  revision?: number;
}) {
  const query = useQuery({
    queryKey: ["typeset-collaboration-image", path, revision],
    queryFn: () => collaborationRequest<{ url: string }>(path),
    staleTime: 120000,
  });
  return query.data ? (
    <img src={query.data.url} alt={alt} loading="lazy" />
  ) : (
    <span>{query.isError ? "图片加载失败" : "加载图片…"}</span>
  );
}

export function TypesetCollaborationPanel({
  workId,
  actorId,
  workRevision,
  onChanged,
}: {
  workId: string;
  actorId: string;
  workRevision: number;
  onChanged?: () => void | Promise<void>;
}) {
  const base = `/api/works/${workId}/typeset/collaboration`;
  const query = useQuery({
    queryKey: ["typeset-collaboration", workId, workRevision],
    queryFn: () => collaborationRequest<State>(base),
  });
  const keys = useRef(new Map<string, string>());
  const mutationKey = (operation: string, revision: number) => {
    const scope = `${workId}:${revision}:${operation}`;
    const previous = keys.current.get(scope);
    if (previous) return previous;
    const key = crypto.randomUUID();
    keys.current.set(scope, key);
    return key;
  };
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [view, setView] = useState<string | null>(null);
  const [comparePage, setComparePage] = useState("");
  const [zoom, setZoom] = useState(1);
  const [mobileSide, setMobileSide] = useState("output");
  useEffect(() => {
    setPreview(null);
    setMappings([]);
    setView(null);
  }, [workId]);
  const state = query.data;
  if (!state)
    return (
      <p role="status">
        {query.isError ? "成图协作加载失败" : "加载成图协作…"}
      </p>
    );
  const participant = state.participants.find((p) => p.userId === actorId);
  const mine = state.pages.filter(
    (p) => p.assignment?.participantId === participant?.id && participant,
  );
  const ownDrafts = state.drafts.filter(
    (d) => d.participantId === participant?.id,
  );
  const missing = mine.filter(
    (p) => !state.drafts.some((d) => d.workImageId === p.id),
  );
  const editable =
    !!participant &&
    mine.length > 0 &&
    ["typesetting", "pending_publish"].includes(state.workflowStatus);
  const pending = state.workflowStatus === "pending_publish";
  const activeDraft = state.drafts.find((d) => d.id === view);
  const selectedPage = state.pages.find((p) => p.id === comparePage);
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setMessage("");
    try {
      await operation();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };
  const changed = async () => {
    await query.refetch();
    await refreshTypesetWork(workId);
    await onChanged?.();
  };
  const json = (data: object) => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
  const submit = (cancel: boolean) =>
    run(async () => {
      await collaborationRequest(
        `/api/works/${workId}/stages/${cancel ? "submission/cancel" : "submit"}`,
        json({
          stage: "typeset",
          expectedRevision: state.revision,
          expectedEditorEpoch: state.editorEpoch,
          idempotencyKey: mutationKey(
            cancel ? "cancel" : "submit",
            state.revision,
          ),
        }),
      );
      await changed();
    });
  const loadPreview = (files: File[], replace?: Draft) =>
    run(async () => {
      if (!files?.length) return;
      const form = new FormData();
      form.set("expectedRevision", String(state.revision));
      form.set("idempotencyKey", crypto.randomUUID());
      for (const file of files) form.append("files", file);
      const result = await collaborationRequest<Preview>(`${base}/preview`, {
        method: "POST",
        body: form,
      });
      setPreview({ ...result, idempotencyKey: crypto.randomUUID() });
      setMappings(
        result.images.map((image) => {
          const page = state.pages.find(
            (p) => p.id === image.suggestedWorkImageId,
          );
          return {
            imageId: image.id,
            position: replace
              ? (replace.position as Mapping["position"])
              : "page",
            workImageId:
              replace?.workImageId ?? image.suggestedWorkImageId ?? undefined,
            draftId: replace?.id,
            ignored:
              !replace &&
              !!page &&
              page.assignment?.participantId !== participant?.id,
          };
        }),
      );
    });
  const save = () =>
    run(async () => {
      if (!preview) return;
      const valid = mappings
        .filter((m) => !m.ignored)
        .map(({ imageId, workImageId, draftId, position }) => ({
          imageId,
          workImageId,
          draftId,
          position,
        }));
      if (
        !valid.length ||
        valid.some((m) => m.position === "page" && !m.workImageId)
      )
        throw new Error("请明确映射本人原稿页，或选择补充图首尾位置");
      await collaborationRequest(
        `${base}/apply`,
        json({
          sessionId: preview.sessionId,
          expectedRevision: preview.expectedRevision,
          idempotencyKey: preview.idempotencyKey,
          mappings: valid,
        }),
      );
      setPreview(null);
      await changed();
      setMessage(pending ? "成图已更新，请重新查看或下载" : "成图草稿已保存");
    });
  return (
    <section className="typeset-collaboration" aria-label="成图协作">
      <div className="typeset-collaboration-actions">
        <strong>当前成图</strong>
        <span>
          本人缺页：
          {missing.length
            ? missing.map((p) => p.orderIndex + 1).join("、")
            : "无"}
        </span>
      </div>
      {!state.handoffReady && editable && (
        <p>请先领取当前完整嵌字材料，再保存成图。</p>
      )}
      <div className="typeset-collaboration-grid">
        {state.pages.map((page) => {
          const draft = state.drafts.find((d) => d.workImageId === page.id);
          const owner = state.participants.find(
            (p) => p.id === page.assignment?.participantId,
          );
          return (
            <article key={page.id}>
              {draft ? (
                <button
                  aria-label={`第 ${page.orderIndex + 1} 页成图`}
                  className="typeset-collaboration-thumb"
                  onClick={() => {
                    setView(draft.id);
                    setComparePage(page.id);
                    setZoom(1);
                  }}
                >
                  <Image
                    revision={draft.revision}
                    path={`${base}/drafts/${draft.id}/url?variant=thumbnail`}
                    alt={`第 ${page.orderIndex + 1} 页成图`}
                  />
                </button>
              ) : (
                <div className="typeset-collaboration-empty">
                  第 {page.orderIndex + 1} 页
                </div>
              )}
              <span>
                第 {page.orderIndex + 1} 页 ·{" "}
                {owner?.user.displayName ?? "未分配"}
              </span>
              <span>
                {draft
                  ? draft.submittedRevision === draft.revision
                    ? "已提交"
                    : "已上传"
                  : "缺图"}
              </span>
            </article>
          );
        })}
        {state.drafts
          .filter((d) => !d.workImageId)
          .map((d) => (
            <article key={d.id}>
              <button
                aria-label={d.sourceName}
                className="typeset-collaboration-thumb"
                onClick={() => {
                  setView(d.id);
                  setComparePage("");
                  setZoom(1);
                }}
              >
                <Image
                  revision={d.revision}
                  path={`${base}/drafts/${d.id}/url?variant=thumbnail`}
                  alt={d.sourceName}
                />
              </button>
              <span>
                {d.position === "start" ? "开头" : "末尾"}补充图 ·{" "}
                {
                  state.participants.find((p) => p.id === d.participantId)?.user
                    .displayName
                }
              </span>
              <span>
                {d.submittedRevision === d.revision ? "已提交" : "已上传"}
              </span>
              {editable && d.participantId === participant?.id && (
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await collaborationRequest(
                        `${base}/drafts/${d.id}/delete`,
                        json({
                          expectedRevision: state.revision,
                          idempotencyKey: mutationKey(
                            `delete:${d.id}`,
                            state.revision,
                          ),
                        }),
                      );
                      await changed();
                    })
                  }
                >
                  删除补充图
                </Button>
              )}
            </article>
          ))}
      </div>
      {editable && (
        <div className="typeset-collaboration-actions">
          <FilePickerButton
            label="选择成图或 ZIP"
            inputLabel="上传成图或 ZIP"
            multiple
            accept="image/png,image/jpeg,image/webp,.zip"
            disabled={busy || !state.handoffReady}
            onFiles={(files) => void loadPreview(files)}
          />
          <Button
            disabled={
              busy || !!preview || !!missing.length || !ownDrafts.length
            }
            onClick={() => submit(false)}
          >
            提交本人全部成图
          </Button>
          {ownDrafts.some((d) => d.submittedRevision === d.revision) && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => submit(true)}
            >
              取消本人提交
            </Button>
          )}
        </div>
      )}
      {preview && (
        <div aria-label="成图映射预览">
          <h3>确认保存映射</h3>
          <div className="typeset-collaboration-grid">
            {preview.images.map((image, index) => {
              const mapping = mappings[index]!;
              return (
                <article key={image.id}>
                  <Image
                    path={`/api/typeset/upload-sessions/${preview.sessionId}/images/${image.id}/url?variant=thumbnail`}
                    alt={image.sourceName}
                  />
                  <span>{image.sourceName}</span>
                  <SelectControl
                    aria-label={`${image.sourceName} 对应页`}
                    value={
                      mapping.ignored
                        ? "ignore"
                        : mapping.position === "page"
                          ? (mapping.workImageId ?? "")
                          : mapping.position
                    }
                    onValueChange={(value) => {
                      setMappings((rows) =>
                        rows.map((m, i) =>
                          i !== index
                            ? m
                            : {
                                imageId: m.imageId,
                                draftId: m.draftId,
                                position:
                                  value === "start" || value === "end"
                                    ? value
                                    : "page",
                                workImageId: [
                                  "start",
                                  "end",
                                  "ignore",
                                ].includes(value)
                                  ? undefined
                                  : value,
                                ignored: value === "ignore",
                              },
                        ),
                      );
                    }}
                  >
                    <option value="">请选择本人原稿页</option>
                    <option value="ignore">忽略（他人页或本次不保存）</option>
                    {mine.map((p) => (
                      <option key={p.id} value={p.id}>
                        第 {p.orderIndex + 1} 页
                        {state.drafts.some((d) => d.workImageId === p.id)
                          ? "（替换）"
                          : "（新增）"}
                      </option>
                    ))}
                    <option value="start">新增补充图 · 开头</option>
                    <option value="end">新增补充图 · 末尾</option>
                  </SelectControl>
                  {mapping.ignored && <span>该文件将被忽略，不覆盖他人页</span>}
                </article>
              );
            })}
          </div>
          <div className="typeset-collaboration-actions">
            <Button disabled={busy} onClick={save}>
              {pending ? "确认完整修订" : "保存本批草稿"}
            </Button>
            <Button variant="secondary" onClick={() => setPreview(null)}>
              取消导入
            </Button>
          </div>
        </div>
      )}
      {view && activeDraft && (
        <div
          className="typeset-compare"
          role="region"
          aria-label="原图成图对比"
        >
          <div className="typeset-collaboration-actions">
            <Button variant="secondary" onClick={() => setView(null)}>
              关闭对比
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                const i = state.drafts.findIndex((d) => d.id === view);
                const d =
                  state.drafts[
                    (i - 1 + state.drafts.length) % state.drafts.length
                  ]!;
                setView(d.id);
                setComparePage(d.workImageId ?? "");
              }}
            >
              上一张
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                const i = state.drafts.findIndex((d) => d.id === view);
                const d = state.drafts[(i + 1) % state.drafts.length]!;
                setView(d.id);
                setComparePage(d.workImageId ?? "");
              }}
            >
              下一张
            </Button>
            <label>
              缩放
              <input
                aria-label="对比缩放"
                type="range"
                min="0.5"
                max="3"
                step="0.25"
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
              />
            </label>
            <label>
              对比原图
              <SelectControl value={comparePage} onValueChange={setComparePage}>
                <option value="">只看成图</option>
                {state.pages.map((p) => (
                  <option key={p.id} value={p.id}>
                    第 {p.orderIndex + 1} 页
                  </option>
                ))}
              </SelectControl>
            </label>
            <SelectControl
              className="typeset-compare-side"
              aria-label="窄屏查看"
              value={mobileSide}
              onValueChange={setMobileSide}
            >
              <option value="output">成图</option>
              <option value="source">原图</option>
            </SelectControl>
            {editable &&
              activeDraft.participantId === participant?.id &&
              (pending ||
                activeDraft.submittedRevision !== activeDraft.revision) && (
                <FilePickerButton
                  label="替换当前图"
                  inputLabel="替换当前成图"
                  accept="image/png,image/jpeg,image/webp"
                  disabled={busy}
                  onFiles={(files) => void loadPreview(files, activeDraft)}
                />
              )}
            {editable &&
              activeDraft.participantId === participant?.id &&
              !pending &&
              activeDraft.submittedRevision === activeDraft.revision && (
                <span>先取消本人提交，再替换此图</span>
              )}
          </div>
          <div
            className={`typeset-compare-images typeset-side-${mobileSide}`}
            style={{ "--typeset-zoom": zoom } as React.CSSProperties}
          >
            {selectedPage && (
              <div className="typeset-compare-source">
                <Image
                  path={`/api/works/${workId}/images/${selectedPage.id}/url`}
                  alt={`第 ${selectedPage.orderIndex + 1} 页原图`}
                />
              </div>
            )}
            <div className="typeset-compare-output">
              <Image
                revision={activeDraft.revision}
                path={`${base}/drafts/${activeDraft.id}/url`}
                alt={activeDraft.sourceName}
              />
            </div>
          </div>
        </div>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
