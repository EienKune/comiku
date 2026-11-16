import { useRef, useState } from "react";
import { Button } from "../components/ui";
import { ImageOrderList } from "../features/workspace/ImageOrderList";
import { useImageDrag } from "../features/workspace/use-image-drag";
import { useCandidateDialog } from "../features/workspace/use-candidate-dialog";
import {
  imageDragSnapshot,
  moveImage,
  type ImageDragGroup,
} from "../features/workspace/image-drag-model";
import "./image-ordering-demo.css";

const sourceIds = ["sample-one", "sample-two", "sample-three"];
const caption = (id: string) => `原图 ${sourceIds.indexOf(id) + 1}`;

export function ImageOrderingDemo() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <h3>图片分配与页序</h3>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        打开图片拖拽示例
      </Button>
      {open && <OrderingDialog onClose={() => setOpen(false)} />}
    </div>
  );
}

function OrderingDialog({ onClose }: { onClose: () => void }) {
  const dialog = useCandidateDialog();
  const scroll = useRef<HTMLDivElement | null>(null);
  const [groups, setGroups] = useState<readonly ImageDragGroup[]>([
    { id: "first", mediaIds: [...sourceIds] },
    { id: "second", mediaIds: [] },
  ]);
  const [message, setMessage] = useState("");
  const snapshot = imageDragSnapshot(groups, sourceIds);
  const { drag, feedback } = useImageDrag({
    groups,
    validIds: sourceIds,
    snapshot,
    rootRef: dialog,
    scrollRef: scroll,
    caption,
    onDrop: (id, groupId, slot, expected) =>
      setGroups((current) =>
        moveImage(current, id, groupId, slot, expected, sourceIds),
      ),
  });
  return (
    <dialog
      ref={dialog}
      className="image-ordering-demo"
      aria-label="图片拖拽示例"
      onCancel={(event) => {
        event.preventDefault();
        if (drag.id) drag.cancel();
        else onClose();
      }}
    >
      <header>
        <h3>图片拖拽示例</h3>
        <Button
          variant="ghost"
          size="sm"
          disabled={!!drag.id}
          onClick={onClose}
        >
          关闭
        </Button>
      </header>
      <div ref={scroll} className="image-ordering-demo__scroll">
        <div className="image-ordering-demo__sources" aria-label="原图">
          {sourceIds.map((id) => (
            <button
              key={id}
              type="button"
              data-image-drag-preview
              onPointerDown={(event) => drag.start(event, id)}
              onClick={() => setMessage(`已点击${caption(id)}`)}
            >
              {caption(id)}
            </button>
          ))}
        </div>
        {groups.map((group, index) => (
          <section key={group.id} data-image-drag-group={group.id}>
            <h4>作品 {index + 1}</h4>
            <ImageOrderList
              groupId={group.id}
              ids={group.mediaIds}
              caption={caption}
              drag={drag}
              renderThumbnail={(id) => (
                <span className="image-ordering-demo__thumbnail">
                  {sourceIds.indexOf(id) + 1}
                </span>
              )}
              onPreview={(id) => setMessage(`已点击${caption(id)}`)}
              onChange={(mediaIds) =>
                setGroups((current) =>
                  current.map((item) =>
                    item.id === group.id ? { ...item, mediaIds } : item,
                  ),
                )
              }
              onRemove={(id) =>
                setGroups((current) =>
                  current.map((item) => ({
                    ...item,
                    mediaIds: item.mediaIds.filter((mediaId) => mediaId !== id),
                  })),
                )
              }
            />
          </section>
        ))}
      </div>
      <p role="status">
        {message || "整卡拖动；方向键调整页序，Escape 取消。"}
      </p>
      {feedback}
    </dialog>
  );
}
