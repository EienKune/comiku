import { useState } from "react";
import type { components } from "@comiku/api-client";
import { workPageAssignments, pageNumbers } from "./page-workflow";

type Work = components["schemas"]["WorkDetailDto"];
export type RetainedPages = { translate: Set<string>; typeset: Set<string> };
export function CollaborationModePreview({
  work,
  retained,
}: {
  work: Work;
  retained: RetainedPages;
}) {
  const [, rerender] = useState(0);
  return (
    <div>
      {(["translate", "typeset"] as const).map((stage) => {
        const person = work.participants.find(
          (row) => row.stage === stage && !row.leftAt,
        );
        if (!person)
          return (
            <p key={stage}>
              {stage === "translate" ? "翻译" : "嵌字"}：尚未认领
            </p>
          );
        const owned = workPageAssignments(work)
          .filter(
            (page) => page.stage === stage && page.participantId === person.id,
          )
          .map((page) => page.workImageId);
        const frozen =
          stage === "translate" &&
          !["pending_translate", "translating"].includes(work.workflowStatus);
        const cleared = owned.filter((id) => !retained[stage].has(id));
        return (
          <fieldset key={stage}>
            <legend>
              {person.displayName} · {stage === "translate" ? "翻译" : "嵌字"}
              保留页
            </legend>
            <div className="workspace-page-assignment__pages">
              {work.images.map(
                (image, index) =>
                  owned.includes(image.id) && (
                    <label key={image.id}>
                      <input
                        type="checkbox"
                        checked={retained[stage].has(image.id)}
                        disabled={frozen}
                        onChange={(event) => {
                          if (event.target.checked)
                            retained[stage].add(image.id);
                          else retained[stage].delete(image.id);
                          rerender((value) => value + 1);
                        }}
                      />
                      {index + 1}
                    </label>
                  ),
              )}
            </div>
            {frozen ? (
              <p>已交接的翻译分工保持不变。</p>
            ) : (
              <p>
                {cleared.length
                  ? `将清空第 ${pageNumbers(work, cleared)} 页当前稿件并释放认领。`
                  : "当前负责页全部保留。"}
              </p>
            )}
          </fieldset>
        );
      })}
      <p>校对成员继续保留，全篇协作。</p>
    </div>
  );
}
