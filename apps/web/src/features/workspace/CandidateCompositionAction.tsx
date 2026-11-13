import { useId } from "react";
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
  const id = useId();
  return (
    <span
      className="candidate-composition-disabled-action"
      tabIndex={reason ? 0 : undefined}
      aria-describedby={reason ? id : undefined}
    >
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={Boolean(reason)}
        onClick={onClick}
      >
        {label}
      </Button>
      {reason && (
        <span id={id} role="tooltip">
          {reason}
        </span>
      )}
    </span>
  );
}
