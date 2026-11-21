import { useEffect, useRef, useState } from "react";
import { collaborationRequest } from "./collaboration-request";
import { uploadTypesetFiles } from "./typeset-upload-transfer";
import {
  prepareLocalTypesetImages,
  releaseLocalTypesetImages,
  type LocalTypesetImage,
} from "./typeset-local-files";

export type TypesetDetailPreview = {
  sessionId: string;
  expectedRevision: number;
  images: {
    id: string;
    sourceName: string;
    suggestedWorkImageId: string | null;
    pageNumber?: number | null;
    localUrl?: string;
  }[];
};
type BoundTypesetPreview = TypesetDetailPreview & {
  imageIds: Record<string, string>;
};
export function useTypesetDetailUpload(
  workId: string,
  revision: number,
  actorId = "",
) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const local = useRef<LocalTypesetImage[]>([]);
  const transfer = useRef<{
    ids: string[];
    files: File[];
    sessionId?: string;
    bound?: BoundTypesetPreview;
  } | null>(null);
  useEffect(() => {
    controller.current?.abort();
    releaseLocalTypesetImages(local.current);
    local.current = [];
    transfer.current = null;
    setBusy(false);
    setProgress("");
    setError("");
    return () => {
      controller.current?.abort();
      releaseLocalTypesetImages(local.current);
      local.current = [];
    };
  }, [workId, actorId]);
  return {
    busy,
    progress,
    error,
    choose: (
      files: File[],
      receive: (preview: TypesetDetailPreview) => void,
    ) => {
      if (!files.length || busy) return;
      controller.current?.abort();
      const active = new AbortController();
      controller.current = active;
      setBusy(true);
      setError("");
      void prepareLocalTypesetImages(files, {
        signal: active.signal,
        onProgress: setProgress,
      })
        .then((images) => {
          if (active.signal.aborted) {
            releaseLocalTypesetImages(images);
            return;
          }
          releaseLocalTypesetImages(local.current);
          local.current = images;
          transfer.current = null;
          receive({
            sessionId: "",
            expectedRevision: revision,
            images: images.map((image) => ({
              id: image.id,
              sourceName: image.sourceName,
              suggestedWorkImageId: null,
              pageNumber: image.pageNumber,
              localUrl: image.localUrl,
            })),
          });
          setProgress("本地预览已就绪，请选择本次保存的图片与对应页");
        })
        .catch((caught: unknown) => {
          if (!active.signal.aborted) {
            setProgress("");
            setError(
              caught instanceof Error ? caught.message : "本地文件读取失败",
            );
          }
        })
        .finally(() => {
          if (!active.signal.aborted) setBusy(false);
        });
    },
    prepare: async (ids: string[], options: { rebind?: boolean } = {}) => {
      if (!ids.length) throw new Error("请选择本次保存的成图");
      const images = ids.map((id) =>
        local.current.find((image) => image.id === id),
      );
      if (images.some((image) => !image))
        throw new Error("本地文件已失效，请重新选择");
      const previous = transfer.current;
      if (
        !previous ||
        previous.ids.slice().sort().join() !== ids.slice().sort().join()
      )
        transfer.current = { ids, files: images.map((image) => image!.file) };
      const pending = transfer.current!;
      // An apply response may be lost after adoption. Retain the original bound
      // revision so its exact idempotent apply can replay without binding again.
      if (options.rebind) pending.bound = undefined;
      else if (pending.bound) return pending.bound;
      const active = new AbortController();
      controller.current = active;
      setBusy(true);
      setError("");
      try {
        const session = await uploadTypesetFiles(pending.files, {
          requireComplete: true,
          signal: active.signal,
          sessionId: pending.sessionId,
          onProgress: setProgress,
          onSession: (session) => {
            pending.sessionId = session.id;
          },
        });
        active.signal.throwIfAborted();
        const preview = await collaborationRequest<TypesetDetailPreview>(
          `/api/works/${workId}/typeset/collaboration/preview-session`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal: active.signal,
            body: JSON.stringify({
              sessionId: session.id,
              expectedRevision: revision,
              idempotencyKey: crypto.randomUUID(),
              ...(options.rebind ? { rebind: true } : {}),
            }),
          },
        );
        const remote = session.files.flatMap((file) => file.images);
        if (remote.length !== ids.length)
          throw new Error("文件校验结果不完整，请重试保存");
        pending.bound = {
          ...preview,
          imageIds: Object.fromEntries(
            pending.ids.map((id, index) => [id, remote[index].id]),
          ),
        };
        return pending.bound;
      } finally {
        if (!active.signal.aborted) {
          setBusy(false);
          setProgress("");
        }
      }
    },
    reset: () => {
      releaseLocalTypesetImages(local.current);
      local.current = [];
      transfer.current = null;
      setError("");
      setProgress("");
    },
  };
}
