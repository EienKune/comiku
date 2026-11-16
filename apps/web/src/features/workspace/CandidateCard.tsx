import { useRef, type ReactNode } from "react";
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
  editingDisabled = false,
  imageSelection,
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
  editingDisabled?: boolean;
  imageSelection?: {
    selectedCount: number;
    totalCount: number;
    orderChanged: boolean;
  };
  onToggle: () => void;
  onRetryAnalysis: () => void;
  onToggleOrdering: () => void;
  children?: ReactNode;
}) {
  const category = candidate.classificationTags?.[0];
  const checkbox = useRef<HTMLInputElement>(null);
  const selectable = canManage && candidate.status !== "imported";
  const editable = canManage && candidate.status === "pending";
  const imageSummary =
    imageSelection &&
    (imageSelection.selectedCount !== imageSelection.totalCount
      ? `入库图片：${imageSelection.selectedCount} / ${imageSelection.totalCount} 张`
      : imageSelection.orderChanged
        ? "入库顺序已调整"
        : null);
  return (
    <Surface
      as="article"
      className={`workspace-media-card candidate-card${selected ? " is-selected" : ""}`}
    >
      <CandidateMediaPreview candidate={candidate} />
      <div
        className={`workspace-card-body candidate-card-body${selectable && !selectionDisabled ? " candidate-card-body--selectable" : ""}`}
        onClick={(event) => {
          if (
            !selectable ||
            selectionDisabled ||
            event.defaultPrevented ||
            event.button !== 0
          )
            return;
          const target = event.target;
          if (
            !(target instanceof Element) ||
            !event.currentTarget.contains(target) ||
            target.closest(
              'button,a,input,label,select,textarea,[role="button"],[role="link"],[contenteditable],[data-card-action]',
            )
          )
            return;
          if (window.getSelection()?.toString().trim()) return;
          onToggle();
          checkbox.current?.focus({ preventScroll: true });
        }}
      >
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
                    disabled={editingDisabled}
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
        <div className="candidate-card-image-summary">
          {editable && imageSummary && (
            <button
              type="button"
              disabled={editingDisabled}
              onClick={onToggleOrdering}
            >
              {imageSummary}
            </button>
          )}
        </div>
        <footer className="candidate-card-footer">
          <span className="candidate-card-selection">
            {canManage && candidate.status !== "imported" && (
              <label className="account-checkbox">
                <input
                  ref={checkbox}
                  type="checkbox"
                  aria-label={`选择 ${candidate.authorName} 的帖子`}
                  checked={selected}
                  disabled={selectionDisabled}
                  onChange={onToggle}
                />
              </label>
            )}
          </span>
          <span className="candidate-card-order">
            {editable && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={editingDisabled}
                title="整理图片"
                leadingIcon={<Images size={15} />}
                onClick={onToggleOrdering}
              >
                <span className="candidate-card-order-label">整理图片</span>
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
