import { Button } from "../../components/ui";

export type WorkPerspective = "work" | "read" | "series";

const perspectives: { value: WorkPerspective; label: string }[] = [
  { value: "work", label: "工作视图" },
  { value: "read", label: "查看视图" },
  { value: "series", label: "系列视图" },
];

export function WorkViewNavigation({
  active,
  onChange,
}: {
  active: WorkPerspective;
  onChange: (next: WorkPerspective) => void;
}) {
  return (
    <div className="workspace-view-toggle" role="group" aria-label="作品视角">
      {perspectives.map(({ value, label }) => (
        <Button
          key={value}
          type="button"
          size="sm"
          variant={active === value ? "primary" : "secondary"}
          aria-pressed={active === value}
          onClick={() => {
            if (value !== active) onChange(value);
          }}
        >
          {label}
        </Button>
      ))}
    </div>
  );
}
