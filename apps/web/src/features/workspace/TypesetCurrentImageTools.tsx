import { TypesetComparePane, TypesetZoom } from "./TypesetCompareControls";
import { workImageKey } from "./use-work-image-url";
import { FilePickerButton } from "../../components/ImagePicker";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, SelectControl } from "../../components/ui";
import { collaborationRequest } from "./collaboration-request";
import { refreshTypesetWork } from "./typeset-batch-api";
import { useConfirmation } from "../../components/use-confirmation";
import { uploadTypesetFiles } from "./typeset-upload-transfer";

/** A stable output-entry ID is required: output position never implies source identity. */
export function TypesetCurrentImageTools({
  workId,
  versionId,
  imageId,
  workImageId,
  images,
  revision,
  canReplace,
  onChanged,
}: {
  workId: string;
  versionId: string;
  imageId: string;
  workImageId: string | null;
  images: { id: string; orderIndex: number }[];
  revision: number;
  canReplace: boolean;
  onChanged?: () => void | Promise<void>;
}) {
  const [sourceId, setSourceId] = useState(workImageId ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [zoom, setZoom] = useState(1);
  const [side, setSide] = useState("output");
  const [supplementFile, setSupplementFile] = useState<File | null>(null);
  const [supplementPosition, setSupplementPosition] = useState("end");
  const [supplementPreview, setSupplementPreview] = useState("");
  const addKey = useRef(crypto.randomUUID());
  const removeKey = useRef(crypto.randomUUID());
  const uploads = useRef(new Map<File, string>());
  const replaceKey = useRef(crypto.randomUUID());
  const verified = async (selected: File) => {
    const session = await uploadTypesetFiles([selected], {
      requireComplete: true,
      sessionId: uploads.current.get(selected),
      onSession: (session) => {
        uploads.current.set(selected, session.id);
      },
    });
    const image = session.files.flatMap((file) => file.images)[0];
    if (!image) throw new Error("图片校验结果不完整，请重试");
    return { sessionId: session.id, uploadImageId: image.id };
  };
  const confirmation = useConfirmation([
    workId,
    versionId,
    imageId,
    revision,
    canReplace,
  ]);
  useEffect(() => {
    if (!supplementFile) {
      setSupplementPreview("");
      return;
    }
    const url = URL.createObjectURL(supplementFile);
    setSupplementPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [supplementFile]);
  const versions = useQuery({
    queryKey: ["single-supplement-identity", workId, versionId, revision],
    queryFn: () =>
      collaborationRequest<{
        items: {
          id: string;
          images: { id: string; supplementId: string | null }[];
        }[];
      }>(`/api/works/${workId}/typeset/versions`),
    enabled: canReplace,
  });
  const currentImage = versions.data?.items
    .find((v) => v.id === versionId)
    ?.images.find((i) => i.id === imageId);
  useEffect(() => {
    setSourceId(workImageId ?? "");
    setFile(null);
    setMessage("");
    setSupplementFile(null);
    addKey.current = crypto.randomUUID();
    removeKey.current = crypto.randomUUID();
  }, [imageId, workImageId]);
  const original = useQuery({
    queryKey: [...workImageKey(workId, sourceId), "typeset-compare"],
    queryFn: () =>
      collaborationRequest<{ url: string }>(
        `/api/works/${workId}/images/${sourceId}/url`,
      ),
    enabled: !!sourceId,
  });
  const output = useQuery({
    queryKey: ["typeset-single-output", workId, versionId, imageId],
    queryFn: () =>
      collaborationRequest<{ url: string }>(
        `/api/works/${workId}/typeset/versions/${versionId}/images/${imageId}/url`,
      ),
  });
  const replace = async () => {
    if (!file) return;
    setBusy(true);
    setMessage("");
    try {
      const staged = await verified(file);
      await collaborationRequest(
        `/api/works/${workId}/typeset/versions/${versionId}/images/${imageId}/replace/from-session`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...staged,
            expectedRevision: revision,
            idempotencyKey: replaceKey.current,
          }),
        },
      );
      setFile(null);
      await refreshTypesetWork(workId);
      await onChanged?.();
      setMessage("成图已更新，请重新查看或下载");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "替换失败");
    } finally {
      setBusy(false);
    }
  };
  const changeSupplement = async (remove: boolean) => {
    if (
      remove &&
      !(await confirmation.confirm({
        title: "删除当前补充图？",
        description:
          "将生成完整新版本，原稿成图与其他图片保持原顺序，历史版本保留。",
        confirmLabel: "删除补充图",
        danger: true,
      }))
    )
      return;
    if (!remove && !supplementFile) return;
    setBusy(true);
    setMessage("");
    try {
      const base = `/api/works/${workId}/typeset/versions/${versionId}/supplements`;
      if (remove)
        await collaborationRequest(`${base}/${imageId}/delete`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedRevision: revision,
            idempotencyKey: removeKey.current,
          }),
        });
      else {
        const staged = await verified(supplementFile!);
        await collaborationRequest(`${base}/from-session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...staged,
            position: supplementPosition,
            expectedRevision: revision,
            idempotencyKey: addKey.current,
          }),
        });
      }
      setSupplementFile(null);
      await refreshTypesetWork(workId);
      await onChanged?.();
      setMessage("成图已更新，请重新查看或下载");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "修订失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="typeset-compare" aria-label="单人成图对比与修订">
      <div className="typeset-collaboration-actions">
        <label>
          对比原图
          <SelectControl value={sourceId} onValueChange={setSourceId}>
            <option value="">只看成图</option>
            {images.map((i) => (
              <option key={i.id} value={i.id}>
                第 {i.orderIndex + 1} 页
              </option>
            ))}
          </SelectControl>
        </label>
        <TypesetZoom label="成图对比缩放" value={zoom} onChange={setZoom} />
        <SelectControl
          className="typeset-compare-side"
          aria-label="窄屏查看"
          value={side}
          onValueChange={setSide}
        >
          <option value="output">成图</option>
          <option value="source">原图</option>
        </SelectControl>
        {canReplace && (
          <>
            <FilePickerButton
              label="选择替换图片"
              inputLabel="选择当前成图替换文件"
              accept="image/png,image/jpeg,image/webp"
              disabled={busy}
              onFiles={([next]) => {
                setFile(next);
                replaceKey.current = crypto.randomUUID();
              }}
            />
            {file && (
              <span className="workspace-selected-filename">{file.name}</span>
            )}
            <Button disabled={!file || busy} onClick={replace}>
              确认替换当前图
            </Button>
          </>
        )}
      </div>
      {canReplace && (
        <div className="typeset-collaboration-actions">
          <FilePickerButton
            label="选择补充成品图"
            inputLabel="新增单人补充成品图"
            accept="image/png,image/jpeg,image/webp"
            disabled={busy}
            onFiles={([next]) => {
              setSupplementFile(next);
              addKey.current = crypto.randomUUID();
            }}
          />
          {supplementFile && (
            <span className="workspace-selected-filename">
              {supplementFile.name}
            </span>
          )}
          <SelectControl
            aria-label="单人补充图位置"
            value={supplementPosition}
            onValueChange={(value) => {
              setSupplementPosition(value);
              addKey.current = crypto.randomUUID();
            }}
          >
            <option value="end">放在末尾</option>
            <option value="start">放在开头</option>
          </SelectControl>
          {supplementPreview && (
            <img
              src={supplementPreview}
              alt="待新增补充图预览"
              style={{ maxWidth: 160, maxHeight: 160, objectFit: "contain" }}
            />
          )}
          <Button
            disabled={busy || !supplementFile}
            onClick={() => changeSupplement(false)}
          >
            确认新增补充图
          </Button>
          {currentImage?.supplementId && (
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => changeSupplement(true)}
            >
              删除当前补充图
            </Button>
          )}
        </div>
      )}
      <div
        className={`typeset-compare-images typeset-side-${side}`}
        style={{ "--typeset-zoom": zoom } as React.CSSProperties}
      >
        {original.data && (
          <TypesetComparePane side="source">
            <img src={original.data.url} alt="对比原图" />
          </TypesetComparePane>
        )}
        <TypesetComparePane side="output">
          {output.data && <img src={output.data.url} alt="当前成图" />}
        </TypesetComparePane>
      </div>
      {message && <p role="status">{message}</p>}
      {confirmation.dialog}
    </div>
  );
}
