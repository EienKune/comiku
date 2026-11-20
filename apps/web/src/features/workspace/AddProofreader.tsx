import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { components } from "@comiku/api-client";
import { Button, SelectControl } from "../../components/ui";
import {
  authenticatedFetch,
  client,
  queryClient,
  unwrap,
} from "../account/api";
import { Feedback } from "../account/forms";
import { canHandleStage, stageClaimAccess } from "./work-views";
import { useAction } from "../account/use-action";
import { useAccount } from "../account/account-context";

type Work = components["schemas"]["WorkDetailDto"];
export function AddProofreader({
  work,
  onUpdated,
}: {
  work: Work;
  onUpdated: (work: Work) => void;
}) {
  const user = useAccount();
  const { canAddProofreader } = stageClaimAccess(user, work, "proofread");
  const canJoin =
    canAddProofreader &&
    canHandleStage(user, "proofread", work.sourceLanguage) &&
    work.participants.some(
      (person) => person.stage === "proofread" && !person.leftAt,
    ) &&
    !work.participants.some(
      (person) =>
        person.stage === "proofread" &&
        !person.leftAt &&
        person.userId === user.id,
    );
  const [open, setOpen] = useState(false);
  const [userId, setUserId] = useState("");
  const action = useAction();
  const members = useQuery({
    queryKey: ["members"],
    enabled: open && canAddProofreader,
    queryFn: async () => unwrap(await client.GET("/api/users/members")),
  });
  const eligible = members.data?.filter(
    (member) =>
      canHandleStage(member, "proofread", work.sourceLanguage) &&
      !(canJoin && member.id === user.id) &&
      !work.participants.some(
        (person) =>
          person.stage === "proofread" &&
          !person.leftAt &&
          person.userId === member.id,
      ),
  );
  async function add(targetUserId: string) {
    await action.run(async () => {
      const response = await authenticatedFetch(
        `/api/works/${work.id}/stages/proofreaders`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Comiku-Request": "1",
          },
          body: JSON.stringify({
            userId: targetUserId,
            expectedRevision: work.revision,
            idempotencyKey: crypto.randomUUID(),
          }),
        },
      );
      const data = await response.json();
      const updated = await unwrap<Work>({
        response,
        ...(response.ok ? { data } : { error: data }),
      });
      onUpdated(updated);
      queryClient.removeQueries({
        queryKey: ["translation-editor", work.id],
        exact: true,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["works"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard"] }),
        queryClient.invalidateQueries({ queryKey: ["dashboard-works"] }),
      ]);
      setUserId("");
      setOpen(false);
    });
  }
  if (!canAddProofreader) return null;
  return (
    <div className="workspace-stacked-form">
      {canJoin && (
        <Button
          size="sm"
          loading={action.busy}
          onClick={() => void add(user.id)}
        >
          加入校对
        </Button>
      )}
      <Button size="sm" variant="secondary" onClick={() => setOpen(!open)}>
        添加校对
      </Button>
      {open && (
        <>
          {members.isPending ? (
            <span role="status">正在读取成员…</span>
          ) : members.isError ? (
            <Button size="sm" onClick={() => void members.refetch()}>
              重试读取成员
            </Button>
          ) : (
            <>
              <SelectControl
                aria-label="选择校对成员"
                value={userId}
                onValueChange={setUserId}
              >
                <option value="">选择校对成员</option>
                {eligible?.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.displayName}
                  </option>
                ))}
              </SelectControl>
              <Button
                size="sm"
                disabled={!userId}
                loading={action.busy}
                onClick={() => void add(userId)}
              >
                添加
              </Button>
            </>
          )}
        </>
      )}
      <Feedback error={action.error} success={action.success} />
    </div>
  );
}
