import { useEffect, useId, useRef, useState } from "react";
import type { components } from "@comiku/api-client";
import { Button } from "../../components/ui";
import { client, queryClient, unwrap } from "../account/api";

type Work = components["schemas"]["WorkDetailDto"];

export function SkipProofreadingButton({
  workId,
  available,
  reason,
  disabled = false,
  onSkipped,
}: {
  workId: string;
  available: boolean;
  reason?: string | null;
  disabled?: boolean;
  onSkipped?: (work: Work) => Promise<void> | void;
}) {
  const [work, setWork] = useState<Work | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const confirmationKey = useRef("");
  const titleId = useId();
  useEffect(() => {
    if (!work) return;
    const element = dialog.current;
    element?.showModal();
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      element?.close();
      document.body.style.overflow = oldOverflow;
    };
  }, [work]);
  async function open() {
    setBusy(true);
    setError(null);
    setSuccess(false);
    try {
      const latest = await unwrap(
        await client.GET("/api/works/{id}", {
          params: { path: { id: workId } },
        }),
      );
      queryClient.setQueryData(["work", workId], latest);
      if (!latest.canSkipProofreading)
        throw new Error(
          latest.skipProofreadingUnavailableReason ?? "当前不能跳过校对",
        );
      confirmationKey.current = crypto.randomUUID();
      setWork(latest);
    } catch (error) {
      setError(error instanceof Error ? error.message : "读取作品失败");
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!work || busy) return;
    setBusy(true);
    setError(null);
    const claims = work.participants.filter(
      (person) =>
        person.stage === "proofread" && !person.leftAt && !person.submittedAt,
    );
    try {
      const latest = await unwrap(
        await client.POST("/api/works/{id}/stages/proofread/skip", {
          params: { path: { id: workId } },
          body: {
            expectedRevision: work.revision,
            expectedEditorEpoch: work.editorEpoch,
            idempotencyKey: confirmationKey.current,
            confirmCancelClaims: claims.length > 0,
            proofreadParticipantIds: claims.map(({ id }) => id),
          },
        }),
      );
      queryClient.setQueryData(["work", workId], latest);
      await Promise.all(
        [
          "works",
          "dashboard",
          "dashboard-works",
          "publishing",
          "typeset-versions",
          "translation-editor",
        ].map((key) =>
          queryClient.invalidateQueries({
            queryKey: key === "translation-editor" ? [key, workId] : [key],
          }),
        ),
      );
      await onSkipped?.(latest);
      setWork(null);
      setSuccess(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : "跳过校对失败");
      // Keep the reviewed claim set. A changed server state requires reopening.
      await queryClient.invalidateQueries({ queryKey: ["work", workId] });
      await queryClient.invalidateQueries({
        queryKey: ["translation-editor", workId],
      });
    } finally {
      setBusy(false);
    }
  }
  const claims =
    work?.participants.filter(
      (person) =>
        person.stage === "proofread" && !person.leftAt && !person.submittedAt,
    ) ?? [];
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        disabled={disabled || !available}
        loading={busy}
        title={!available ? (reason ?? undefined) : undefined}
        onClick={() => void open()}
      >
        跳过校对
      </Button>
      {!work && error && (
        <p className="account-error" role="alert">
          {error}
        </p>
      )}
      {!work && success && (
        <p className="account-success" role="status">
          已跳过校对，作品进入待嵌字
        </p>
      )}
      {work && (
        <dialog
          ref={dialog}
          className="account-dialog"
          aria-labelledby={titleId}
          onCancel={(event) => {
            if (busy) event.preventDefault();
            else setWork(null);
          }}
        >
          <div className="account-dialog-heading">
            <h2 id={titleId}>跳过校对</h2>
          </div>
          <p>
            作品将进入待嵌字，不记录校对署名。嵌字首次下载交接包前仍可取消翻译提交；下载后上游内容冻结。
          </p>
          {claims.length > 0 && (
            <p>
              以下成员已认领校对，确认跳过会取消这些认领并清理其本作品的校对临时署名：
              {claims.map(({ displayName }) => displayName).join("、")}。
            </p>
          )}
          {error && (
            <p className="account-error" role="alert">
              {error}
            </p>
          )}
          <div className="workspace-actions">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setWork(null)}
            >
              保留校对流程
            </Button>
            <Button loading={busy} onClick={() => void confirm()}>
              {claims.length ? "取消认领并跳过校对" : "确认跳过校对"}
            </Button>
          </div>
        </dialog>
      )}
    </>
  );
}
