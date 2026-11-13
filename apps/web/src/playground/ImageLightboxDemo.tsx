import { useEffect, useRef, useState } from "react";
import { ImageLightbox } from "../components/ImageLightbox";
import { Button } from "../components/ui";

export function ImageLightboxDemo() {
  const [index, setIndex] = useState<number | null>(null);
  const [editor, setEditor] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (editor) element?.showModal();
    return () => element?.close();
  }, [editor]);
  const closeEditor = () => {
    setIndex(null);
    setEditor(false);
  };
  return (
    <div>
      <h3>图片预览与缩放</h3>
      <p>
        Alt＋滚轮围绕鼠标缩放，拖拽图片移动；点击周围空白或按 Esc 关闭。
        触摸未放大时滑动翻页，放大后平移。两页共用演示图，翻页复位。
      </p>
      <Button variant="secondary" onClick={() => setIndex(0)}>
        打开大图预览示例
      </Button>
      <Button variant="secondary" onClick={() => setEditor(true)}>
        弹窗内大图示例
      </Button>
      {editor && (
        <dialog
          ref={dialog}
          className="candidate-discard-dialog"
          aria-label="图片整理示例"
          onCancel={(event) => {
            event.preventDefault();
            closeEditor();
          }}
        >
          <h3>图片整理示例</h3>
          <p>预览关闭后继续编辑；Tab 留在当前弹层，Esc 逐层关闭。</p>
          <footer>
            <Button variant="secondary" onClick={closeEditor}>
              关闭示例
            </Button>
            <Button onClick={() => setIndex(0)}>预览原图</Button>
          </footer>
        </dialog>
      )}
      {index !== null && (
        <ImageLightbox
          src="/samples/demo-work.png"
          alt={`大图交互示例 ${index + 1}`}
          index={index}
          count={2}
          footer={<span>示例作品 · 第 {index + 1} 页</span>}
          portalContainer={editor ? dialog.current : undefined}
          onClose={() => setIndex(null)}
          onPrevious={index > 0 ? () => setIndex(index - 1) : undefined}
          onNext={index < 1 ? () => setIndex(index + 1) : undefined}
        />
      )}
    </div>
  );
}
