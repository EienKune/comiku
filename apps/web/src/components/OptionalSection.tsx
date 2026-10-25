import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export function OptionalSection({
  label,
  hasContent = false,
  defaultOpen = false,
  children,
}: {
  label: string;
  hasContent?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      className="ui-optional-section"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <ChevronDown size={14} aria-hidden="true" />
        <span>{label}</span>
        {hasContent && <small>已填写</small>}
      </summary>
      <div className="ui-optional-section__content">{children}</div>
    </details>
  );
}
