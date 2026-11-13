import { MarkerTooltip } from "../../components/MarkerTooltip";
import { Button } from "../../components/ui";
import "./candidate-composition.css";

export function CandidateCompositionAction({
  reason,
  label,
  onClick,
}: {
  reason: string;
  label: string;
  onClick: () => void;
}) {
  const button = (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      disabled={Boolean(reason)}
      onClick={onClick}
    >
      {label}
    </Button>
  );
  return reason ? (
    <MarkerTooltip text={reason}>
      <span className="candidate-composition-disabled-action" tabIndex={0}>
        {button}
      </span>
    </MarkerTooltip>
  ) : (
    button
  );
}
