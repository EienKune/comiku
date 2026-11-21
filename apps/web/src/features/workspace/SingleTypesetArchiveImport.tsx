import { FilePickerButton } from "../../components/ImagePicker";
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, SelectControl } from "../../components/ui";
import { collaborationRequest } from "./collaboration-request";
import { useTypesetDetailUpload } from "./use-typeset-detail-upload";
import { refreshTypesetWork } from "./typeset-batch-api";
type Item = {
  id: string;
  sourceName: string;
  suggestedWorkImageId: string | null;
  localUrl?: string;
};
type Preview = {
  sessionId: string;
  expectedRevision: number;
  images: Item[];
  key: string;
};
function StagedImage({ sessionId, item }: { sessionId: string; item: Item }) {
  const query = useQuery({
    queryKey: ["single-typeset-import-image", sessionId, item.id],
    enabled: !item.localUrl,
    queryFn: () =>
      collaborationRequest<{ url: string }>(
        `/api/typeset/upload-sessions/${sessionId}/images/${item.id}/url?variant=thumbnail`,
      ),
  });
  return item.localUrl ? (
    <img src={item.localUrl} alt={item.sourceName} />
  ) : query.data ? (
    <img src={query.data.url} alt={item.sourceName} />
  ) : (
    <span>加载预览…</span>
  );
}
export function SingleTypesetArchiveImport({
  workId,
  revision,
  images,
  onChanged,
}: {
  workId: string;
  revision: number;
  images: { id: string; orderIndex: number }[];
  onChanged?: () => void | Promise<void>;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [sources, setSources] = useState<Record<string, string>>({});
  const [rebind, setRebind] = useState(false);
  const saveKeys = useRef(new Map<string, string>());
  const [mutationBusy, setBusy] = useState(false);
  const upload = useTypesetDetailUpload(workId, revision);
  const busy = mutationBusy || upload.busy;
  const [message, setMessage] = useState("");
  const [mutationError, setMutationError] = useState("");
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setMessage("");
    setMutationError("");
    try {
      await operation();
    } catch (e) {
      setMutationError(e instanceof Error ? e.message : "导入失败");
    } finally {
      setBusy(false);
    }
  };
  const choose = (file: File | undefined) => {
    if (!file || busy) return;
    setPreview(null);
    setSources({});
    setRebind(false);
    upload.choose([file], (result) => {
      setMessage("");
      setPreview({ ...result, key: crypto.randomUUID() });
      setSources({});
    });
  };
  const save = () =>
    run(async () => {
      if (!preview) return;
      const staged = await upload.prepare(
        preview.images.map((image) => image.id),
        { rebind },
      );
      setRebind(false);
      const mappings = preview.images.map((i) => ({
        imageId: staged.imageIds[i.id],
        workImageId: sources[i.id] || null,
        position: sources[i.id] ? "page" : "free",
      }));
      const signature = JSON.stringify({
        sessionId: staged.sessionId,
        revision: staged.expectedRevision,
        mappings,
      });
      const key = saveKeys.current.get(signature) ?? crypto.randomUUID();
      saveKeys.current.set(signature, key);
      await collaborationRequest(
        `/api/works/${workId}/typeset/collaboration/apply`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId: staged.sessionId,
            expectedRevision: staged.expectedRevision,
            idempotencyKey: key,
            mappings,
          }),
        },
      );
      setPreview(null);
      upload.reset();
      await refreshTypesetWork(workId);
      await onChanged?.();
      setMessage("单人成图版本已保存，请确认整份完整后提交嵌字");
    });
  const move = (index: number, delta: number) =>
    setPreview((current) => {
      if (
        !current ||
        index + delta < 0 ||
        index + delta >= current.images.length
      )
        return current;
      const rows = [...current.images];
      [rows[index], rows[index + delta]] = [rows[index + delta]!, rows[index]!];
      return { ...current, images: rows };
    });
  return (
    <div className="typeset-collaboration">
      <div className="typeset-collaboration-actions">
        <FilePickerButton
          label="导入单作品 ZIP"
          inputLabel="导入单作品成图 ZIP"
          accept=".zip"
          disabled={busy}
          onFiles={([file]) => void choose(file)}
        />
      </div>
      {(upload.progress || upload.error || mutationError || message) && (
        <div className="typeset-collaboration-feedback" aria-live="polite">
          {upload.progress && <p role="status">{upload.progress}</p>}
          {(upload.error || mutationError) && (
            <p role="alert" className="account-error">
              {upload.error || mutationError}
            </p>
          )}
          {message && <p role="status">{message}</p>}
        </div>
      )}
      {preview && (
        <>
          <div className="typeset-collaboration-grid">
            {preview.images.map((item, index) => (
              <article key={item.id}>
                <StagedImage sessionId={preview.sessionId} item={item} />
                <span>
                  {index + 1} · {item.sourceName}
                </span>
                <SelectControl
                  disabled={busy}
                  aria-label={`${item.sourceName} 原图关联`}
                  value={sources[item.id] ?? ""}
                  onValueChange={(value) =>
                    setSources((current) => ({ ...current, [item.id]: value }))
                  }
                >
                  <option value="">不关联原图</option>
                  {images.map((p) => (
                    <option key={p.id} value={p.id}>
                      原稿第 {p.orderIndex + 1} 页
                    </option>
                  ))}
                </SelectControl>
                <div className="typeset-collaboration-actions">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={index === 0 || busy}
                    onClick={() => move(index, -1)}
                  >
                    前移
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={index === preview.images.length - 1 || busy}
                    onClick={() => move(index, 1)}
                  >
                    后移
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      setPreview((p) =>
                        p
                          ? {
                              ...p,
                              images: p.images.filter((i) => i.id !== item.id),
                            }
                          : null,
                      )
                    }
                  >
                    移除
                  </Button>
                </div>
              </article>
            ))}
          </div>
          <div className="typeset-collaboration-actions">
            <Button disabled={busy || !preview.images.length} onClick={save}>
              保存整份成图版本
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await refreshTypesetWork(workId);
                  await onChanged?.();
                  setRebind(true);
                  setMessage("状态已刷新，请重新核对现有文件后保存");
                })
              }
            >
              刷新状态并重新确认
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setPreview(null);
                upload.reset();
              }}
            >
              取消导入
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
