import { RotateCcw } from "lucide-react";
import { Button } from "../../components/ui";
import { CandidateImportThumbnail } from "./CandidateImportMedia";
import { ImageOrderList } from "./ImageOrderList";
import type { ImageDrag } from "./use-image-drag";

export function CandidateAdoptionOrder({
  candidateId,
  sourceIds,
  ids,
  onChange,
  onPreview,
  drag,
  disabled = false,
}: {
  candidateId: string;
  sourceIds: readonly string[];
  ids: readonly string[];
  onChange: (ids: string[]) => void;
  onPreview: (id: string) => void;
  drag: ImageDrag;
  disabled?: boolean;
}) {
  return (
    <aside className="candidate-adoption-order" data-image-drag-group="adopted">
      <div className="candidate-image-heading">
        <h3>入库顺序</h3>
        <span>{ids.length} 张</span>
      </div>
      <p className="candidate-image-hint">拖动排序 · 点击图片预览</p>
      <ImageOrderList
        groupId="adopted"
        ids={ids}
        caption={(id) => `原图 ${sourceIds.indexOf(id) + 1}`}
        renderThumbnail={(id) => (
          <CandidateImportThumbnail candidateId={candidateId} mediaId={id} />
        )}
        onPreview={onPreview}
        previewLabel={(id, index) =>
          `预览入库第 ${index + 1} 页，原图 ${sourceIds.indexOf(id) + 1}`
        }
        onChange={onChange}
        onRemove={(id) => onChange(ids.filter((media) => media !== id))}
        drag={drag}
        disabled={disabled}
        label="入库图片页序"
      />
      {!ids.length && (
        <p className="candidate-image-warning">至少选入一张图片</p>
      )}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        leadingIcon={<RotateCcw size={14} />}
        disabled={disabled || !!drag.id || ids.length < 2}
        onClick={() => onChange(sourceIds.filter((id) => ids.includes(id)))}
      >
        恢复原帖顺序
      </Button>
    </aside>
  );
}
