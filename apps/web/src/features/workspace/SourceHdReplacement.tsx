import { FilePickerButton } from "../../components/ImagePicker";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, SelectControl } from "../../components/ui";
import { collaborationRequest } from "./collaboration-request";
import { refreshTypesetWork } from "./typeset-batch-api";
import "./typeset-collaboration.css";

export function SourceHdReplacement({
  workId,
  images,
  revision,
  onChanged,
}: {
  workId: string;
  images: { id: string; orderIndex: number }[];
  revision: number;
  onChanged?: () => void | Promise<void>;
}) {
  const firstImageId = images[0]?.id ?? "";
  const [imageId, setImageId] = useState(firstImageId);
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [baseline, setBaseline] = useState(revision);
  useEffect(() => {
    if (!file) {
      setUrl("");
      return;
    }
    const value = URL.createObjectURL(file);
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [file]);
  useEffect(() => {
    setFile(null);
    setConfirmed(false);
    setImageId(firstImageId);
  }, [workId, firstImageId]);
  const source = useQuery({
    queryKey: ["source-hd-old", workId, imageId, revision],
    queryFn: () =>
      collaborationRequest<{ url: string }>(
        `/api/works/${workId}/images/${imageId}/url`,
      ),
    enabled: !!file && !!imageId,
  });
  const apply = async () => {
    if (!file || !confirmed) return;
    setBusy(true);
    setMessage("");
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("expectedRevision", String(baseline));
      form.set("idempotencyKey", crypto.randomUUID());
      form.set("sameContentConfirmed", "true");
      await collaborationRequest(
        `/api/works/${workId}/images/${imageId}/hd-replacement`,
        { method: "POST", body: form },
      );
      setFile(null);
      setConfirmed(false);
      await refreshTypesetWork(workId);
      await onChanged?.();
      setMessage("原图已替换，材料更新已记录");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "替换失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="source-hd-replacement" aria-label="原图高清替换">
      <div className="typeset-collaboration-actions">
        <strong>原图高清替换</strong>
        <SelectControl
          aria-label="替换原稿页"
          value={imageId}
          disabled={busy}
          onValueChange={(value) => {
            setImageId(value);
            setFile(null);
            setConfirmed(false);
          }}
        >
          {images.map((image) => (
            <option key={image.id} value={image.id}>
              第 {image.orderIndex + 1} 页
            </option>
          ))}
        </SelectControl>
        <FilePickerButton
          label="选择高清原图"
          inputLabel="选择高清原图"
          accept="image/png,image/jpeg,image/webp"
          disabled={busy}
          onFiles={([next]) => {
            setFile(next);
            setConfirmed(false);
            setBaseline(revision);
          }}
        />
        {file && (
          <span className="workspace-selected-filename">{file.name}</span>
        )}
      </div>
      {file && (
        <>
          <div className="source-hd-preview">
            <div>
              {source.data && <img src={source.data.url} alt="当前原图" />}
              <span>当前原图</span>
            </div>
            <div>
              <img src={url} alt="待替换高清原图" />
              <span>待替换原图</span>
            </div>
          </div>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            已核对内容与构图一致，没有裁切、文字或顺序变化
          </label>
          <div className="typeset-collaboration-actions">
            <Button
              disabled={
                !confirmed || busy || source.isPending || source.isError
              }
              onClick={apply}
            >
              确认替换此页原图
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setFile(null)}
            >
              取消
            </Button>
          </div>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
