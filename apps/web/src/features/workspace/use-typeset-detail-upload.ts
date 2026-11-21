import { useEffect, useRef, useState } from "react";
import { collaborationRequest } from "./collaboration-request";
import { uploadTypesetFiles } from "./typeset-upload-transfer";

export type TypesetDetailPreview = {
  sessionId: string;
  expectedRevision: number;
  images: {
    id: string;
    sourceName: string;
    suggestedWorkImageId: string | null;
  }[];
};
export function useTypesetDetailUpload(
  workId: string,
  revision: number,
  actorId = "",
) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [retryable, setRetryable] = useState(false);
  const running = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const attempt = useRef<{
    files: File[];
    revision: number;
    sessionId?: string;
    receive: (preview: TypesetDetailPreview) => void;
  } | null>(null);
  useEffect(() => {
    controller.current?.abort();
    attempt.current = null;
    running.current = false;
    setBusy(false);
    setProgress("");
    setError("");
    setRetryable(false);
    return () => {
      controller.current?.abort();
    };
  }, [workId, actorId, revision]);
  async function execute() {
    const pending = attempt.current;
    if (!pending || running.current) return;
    running.current = true;
    const active = new AbortController();
    controller.current = active;
    setBusy(true);
    setProgress("");
    setError("");
    setRetryable(false);
    try {
      const session = await uploadTypesetFiles(pending.files, {
        requireComplete: true,
        signal: active.signal,
        sessionId: pending.sessionId,
        onSession: (session) => {
          pending.sessionId = session.id;
        },
        onProgress: setProgress,
      });
      active.signal.throwIfAborted();
      setProgress("正在关联当前作品与原稿页…");
      const preview = await collaborationRequest<TypesetDetailPreview>(
        `/api/works/${workId}/typeset/collaboration/preview-session`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: active.signal,
          body: JSON.stringify({
            sessionId: session.id,
            expectedRevision: pending.revision,
            idempotencyKey: crypto.randomUUID(),
          }),
        },
      );
      active.signal.throwIfAborted();
      pending.receive(preview);
      setProgress("预览已就绪，请核对对应页后保存");
    } catch (error) {
      if (!active.signal.aborted) {
        setProgress("");
        setError(error instanceof Error ? error.message : "上传失败，请重试");
        setRetryable(true);
      }
    } finally {
      if (controller.current === active && !active.signal.aborted) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  return {
    busy,
    progress,
    error,
    retryable,
    choose: (
      files: File[],
      receive: (preview: TypesetDetailPreview) => void,
    ) => {
      if (!files.length || running.current) return;
      attempt.current = { files, receive, revision };
      void execute();
    },
    retry: () => {
      void execute();
    },
    reset: () => {
      attempt.current = null;
      setError("");
      setProgress("");
      setRetryable(false);
    },
  };
}
