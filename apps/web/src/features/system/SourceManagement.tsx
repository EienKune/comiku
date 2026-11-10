import { SourceConnections } from "./SourceConnections";
import { SourceFetchHistory } from "./SourceFetchHistory";

export function SourceManagement({ enabled = true }: { enabled?: boolean }) {
  return (
    <div className="system-source-management">
      <SourceConnections enabled={enabled} />
      <SourceFetchHistory enabled={enabled} />
    </div>
  );
}
