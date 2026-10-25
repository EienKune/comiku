import { useState } from "react";
import { ImageLightbox } from "../components/ImageLightbox";
import { Button } from "../components/ui";

export function ImageLightboxDemo() {
  const [index, setIndex] = useState<number | null>(null);
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
      {index !== null && (
        <ImageLightbox
          src="/samples/demo-work.png"
          alt={`大图交互示例 ${index + 1}`}
          index={index}
          count={2}
          onClose={() => setIndex(null)}
          onPrevious={index > 0 ? () => setIndex(index - 1) : undefined}
          onNext={index < 1 ? () => setIndex(index + 1) : undefined}
        />
      )}
    </div>
  );
}
