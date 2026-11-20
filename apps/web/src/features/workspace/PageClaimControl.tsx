import { PageWorkflowDialog } from "./PageWorkflowOverview";
import { useState, type ReactNode } from "react";
import type { components } from "@comiku/api-client";
import { Button } from "../../components/ui";
import { client, queryClient, unwrap } from "../account/api";
import { useAction } from "../account/use-action";
import { Feedback } from "../account/forms";
import { workPageAssignments } from "./page-workflow";
import { StageMemberSummary } from "./StageMemberSummary";

type Work = components["schemas"]["WorkDetailDto"];
export function PageClaimControl({
  work,
  stage,
  onUpdated,
  canClaim,
  children,
}: {
  work: Work;
  stage: "translate" | "typeset";
  onUpdated: (work: Work) => void;
  canClaim: boolean;
  children?: ReactNode;
}) {
  const action = useAction();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const assignments = workPageAssignments(work).filter(
    (page) => page.stage === stage,
  );
  const assigned = new Set(assignments.map((page) => page.workImageId));
  const submitted = new Set(
    assignments
      .filter((page) => page.submittedAt)
      .map((page) => page.workImageId),
  );
  const free = work.images.filter((image) => !assigned.has(image.id));
  const available = new Set(free.map((im) => im.id));
  const chosen = selected.filter((id) => available.has(id));
  const name = stage === "translate" ? "翻译" : "嵌字";
  function toggle(id: string) {
    setSelected((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    );
  }
  async function claim() {
    await action.run(async () => {
      if (!chosen.length) throw new Error("请至少选择一页");
      const body = {
        stage,
        imageIds: chosen,
        expectedRevision: work.revision,
        idempotencyKey: crypto.randomUUID(),
      };
      const response = await client.POST("/api/works/{id}/stages/claim", {
        params: { path: { id: work.id } },
        body,
      });
      if (response.response.status === 409) {
        await queryClient.invalidateQueries({
          queryKey: ["work", work.id],
          exact: true,
        });
      }
      const updated = await unwrap(response);
      onUpdated(updated);
      queryClient.removeQueries({
        queryKey: ["translation-editor", work.id],
        exact: true,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["works"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
      ]);
      setSelected([]);
      setOpen(false);
    });
  }
  const selectable = canClaim && free.length > 0;
  return (
    <div className="page-stage-summary">
      <div>
        <strong>
          {work.images.length > 0 && free.length === 0
            ? `已提交 ${work.images.filter((image) => submitted.has(image.id)).length} / 总 ${work.images.length} 页`
            : `剩余 ${free.length} 页未分配`}
        </strong>
        <StageMemberSummary work={work} stage={stage} />
      </div>
      <Button
        size="sm"
        variant={selectable ? "primary" : "secondary"}
        aria-label={`${name} · ${selectable ? "查看并认领" : "查看分工"}`}
        onClick={() => {
          setSelected([]);
          action.clearError();
          setOpen(true);
        }}
      >
        {selectable ? "查看并认领" : "查看分工"}
      </Button>
      {open && (
        <PageWorkflowDialog
          work={work}
          stage={stage}
          title={`${name}页分工`}
          onClose={() => setOpen(false)}
          busy={action.busy}
          selection={
            selectable ? { ids: chosen, available, toggle } : undefined
          }
          footer={
            selectable || action.error ? (
              <>
                <Feedback error={action.error} success="" />
                {selectable && (
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={action.busy}
                      onClick={() =>
                        setSelected(
                          chosen.length === free.length ? [] : [...available],
                        )
                      }
                    >
                      {chosen.length === free.length
                        ? "取消全选"
                        : "全选空闲页"}
                    </Button>
                    <Button
                      size="sm"
                      loading={action.busy}
                      disabled={!chosen.length}
                      onClick={() => void claim()}
                    >
                      认领 {chosen.length} 页
                    </Button>
                  </>
                )}
              </>
            ) : undefined
          }
        >
          {children}
        </PageWorkflowDialog>
      )}
    </div>
  );
}
