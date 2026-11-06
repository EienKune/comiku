import type { ReactNode } from "react";
import type { components } from "@comiku/api-client";
import { ExternalLink, Images, RotateCcw } from "lucide-react";
import { Badge, Button, Surface } from "../../components/ui";
import { CandidateClassificationScores } from "./CandidateClassificationScores";
import { CandidateMediaPreview } from "./CandidateMediaPreview";
import { CandidateTags } from "./CandidateTags";
import "./candidate-card.css";

type Candidate = components["schemas"]["CandidateDto"];

export function CandidateCard({
  candidate,
  statusLabel,
  author,
  description,
  canManage,
  selected,
  selectionDisabled,
  onToggle,
  onRetryAnalysis,
  onToggleOrdering,
  children,
}: {
  candidate: Candidate;
  statusLabel: string;
  author: ReactNode;
  description: ReactNode;
  canManage: boolean;
  selected: boolean;
  selectionDisabled: boolean;
  onToggle: () => void;
  onRetryAnalysis: () => void;
  onToggleOrdering: () => void;
  children?: ReactNode;
}) {
  const category = candidate.classificationTags?.[0];
  return (
    <Surface as="article" className="workspace-media-card candidate-card">
      <CandidateMediaPreview candidate={candidate} />
      <div className="workspace-card-body candidate-card-body">
        <div className="candidate-card-header">
          {author}
          <Badge
            className="candidate-card-status"
            tone={
              candidate.status === "pending"
                ? "warning"
                : candidate.status === "imported"
                  ? "success"
                  : "neutral"
            }
          >
            {statusLabel}
          </Badge>
        </div>
        {description}
        <div className="candidate-card-evidence">
          <CandidateTags
            hashtags={candidate.hashtags}
            matches={candidate.tagRuleMatches ?? []}
            model={
              <>
                {category && (
                  <CandidateClassificationScores
                    candidateId={candidate.id}
                    category={category}
                  />
                )}
                {candidate.canRetryAnalysis && canManage && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="candidate-retry-chip"
                    leadingIcon={<RotateCcw size={13} />}
                    title="重新提交失败图片的识别；已成功的结果会保留"
                    onClick={onRetryAnalysis}
                  >
                    重试识别
                  </Button>
                )}
              </>
            }
          />
          {candidate.triageReasons?.includes("rule_conflict") && (
            <p className="candidate-conflict">优先与降级线索冲突</p>
          )}
        </div>
        {children}
        <footer className="candidate-card-footer">
          <span className="candidate-card-selection">
            {canManage && candidate.status !== "imported" && (
              <label className="account-checkbox">
                <input
                  type="checkbox"
                  checked={selected}
                  disabled={selectionDisabled}
                  onChange={onToggle}
                />
                选择
              </label>
            )}
          </span>
          <span className="candidate-card-order">
            {candidate.status === "pending" &&
              candidate.media.length > 1 &&
              canManage && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label="图片顺序"
                  title="图片顺序"
                  leadingIcon={<Images size={15} />}
                  onClick={onToggleOrdering}
                >
                  <span className="candidate-card-order-label">图片顺序</span>
                </Button>
              )}
          </span>
          <span className="candidate-card-origin">
            {candidate.externalPostUrl && (
              <a
                href={candidate.externalPostUrl}
                target="_blank"
                rel="noreferrer"
              >
                原帖 <ExternalLink size={14} />
              </a>
            )}
          </span>
        </footer>
      </div>
    </Surface>
  );
}
