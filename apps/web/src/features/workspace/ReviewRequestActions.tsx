import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { Button } from "../../components/ui";
import { client, queryClient, unwrap } from "../account/api";
import { refreshReviewViews } from "./review-cache";

export function ReviewRequestActions({
  reviewId,
  workId,
  showLink = true,
  disabled = false,
  onUpdated,
}: {
  reviewId: string;
  workId: string;
  showLink?: boolean;
  disabled?: boolean;
  onUpdated?: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["review", reviewId],
    queryFn: async () =>
      unwrap(
        await client.GET("/api/reviews/{id}", {
          params: { path: { id: reviewId } },
        }),
      ),
    staleTime: 0,
    refetchOnMount: "always",
  });

  async function withdraw() {
    const review = query.data;
    if (!review?.canWithdraw || busy || disabled) return;
    if (!window.confirm("撤销本人的审核请求并恢复原制作进度，确认吗？")) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const updated = await unwrap(
        await client.POST("/api/reviews/{id}/withdraw", {
          params: { path: { id: reviewId } },
          body: {
            expectedRevision: review.workRevision,
            expectedEditorEpoch: review.editorEpoch,
            idempotencyKey: crypto.randomUUID(),
          },
        }),
      );
      queryClient.setQueryData(["review", reviewId], updated);
      await refreshReviewViews(workId);
      await onUpdated?.();
      setSuccess("审核请求已撤销，已恢复原制作进度");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "撤销失败，请重试");
      await refreshReviewViews(workId).catch(() => undefined);
      await onUpdated?.().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="workspace-inline-actions">
        {showLink && (
          <Link className="account-link" to={`/reviews/${reviewId}`}>
            查看内容审核
          </Link>
        )}
        {query.data?.canWithdraw && (
          <Button
            size="sm"
            variant="secondary"
            loading={busy}
            disabled={disabled}
            onClick={() => void withdraw()}
          >
            撤销审核请求
          </Button>
        )}
      </div>
      {(error || query.error) && (
        <p className="account-error" role="alert">
          {error || query.error?.message}
        </p>
      )}
      {success && (
        <p className="account-success" role="status">
          {success}
        </p>
      )}
    </div>
  );
}
