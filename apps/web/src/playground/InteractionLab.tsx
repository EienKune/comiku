import { useId, useState } from "react";
import {
  ArrowUpRight,
  Check,
  Heart,
  MousePointer2,
  Sparkles,
} from "lucide-react";
import { Badge, Button, Surface, TextField } from "../components/ui";

export function InteractionLab() {
  const [fieldState, setFieldState] = useState<"normal" | "error" | "disabled">(
    "normal",
  );
  const [selected, setSelected] = useState(false);
  const [clicked, setClicked] = useState(false);
  const noteId = useId();
  return (
    <div className="interaction-grid">
      <Surface className="interaction-panel">
        <span className="interaction-number">01 / HOVER & PRESS</span>
        <h3>轻轻浮起，稳稳落下。</h3>
        <p>
          浅边线与柔和阴影承托按钮，悬停轻抬，按下落回。用 Tab
          也能看见清楚的外轮廓。
        </p>
        <div className="interaction-stage">
          <Button
            size="lg"
            leadingIcon={clicked ? <Check size={18} /> : <Sparkles size={18} />}
            onClick={() => setClicked(!clicked)}
          >
            {clicked ? "再试一次" : "试试这个按钮"}
          </Button>
        </div>
        <span className="interaction-result" role="status">
          {clicked
            ? "已触发演示反馈，没有提交业务数据。"
            : "悬停提亮 · 按下收拢 · 松开恢复"}
        </span>
      </Surface>
      <Surface className="interaction-panel">
        <span className="interaction-number">02 / FOCUS</span>
        <h3>把焦点，交给圆角。</h3>
        <p>点击输入或用 Tab 聚焦。外侧光环保持轮廓完整，错误时沿用红色提醒。</p>
        <div className="segmented" role="group" aria-label="输入状态预览">
          {(
            [
              ["normal", "默认"],
              ["error", "错误"],
              ["disabled", "禁用"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={fieldState === value}
              className={fieldState === value ? "is-active" : ""}
              onClick={() => setFieldState(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <TextField
          label="交接标题"
          placeholder="例如：放学后的秘密计划"
          disabled={fieldState === "disabled"}
          error={
            fieldState === "error"
              ? "示例错误：请检查标题后再试一次。"
              : undefined
          }
          hint="仅用于体验焦点样式，不会保存。"
        />
        <div className="ui-field">
          <label className="ui-field__label" htmlFor={noteId}>
            交接备注
          </label>
          <span className="ui-field__control">
            <textarea
              id={noteId}
              placeholder="多行输入也使用相同的圆角外环。"
            />
          </span>
        </div>
      </Surface>
      <Surface className="interaction-panel">
        <span className="interaction-number">03 / INTERACTIVE SURFACE</span>
        <h3>有回应，也有分寸。</h3>
        <p>可点击的卡片会抬升，静态说明面板保持安静。选中状态不依赖 hover。</p>
        <button
          type="button"
          className={`interaction-card ${selected ? "is-selected" : ""}`}
          aria-pressed={selected}
          onClick={() => setSelected(!selected)}
        >
          <span className="interaction-card__art" aria-hidden="true">
            <Heart />
            <span>co + miku</span>
            <Sparkles />
          </span>
          <span className="interaction-card__body">
            <Badge tone={selected ? "brand" : "neutral"}>
              {selected ? "已选中" : "点击选择"}
            </Badge>
            <strong>一起，让创作继续。</strong>
            <span>
              Comiku · 交互样例 <ArrowUpRight size={18} />
            </span>
          </span>
        </button>
        <span className="interaction-result">
          <MousePointer2 size={14} /> 触摸可直接选择，无需悬停。
        </span>
      </Surface>
    </div>
  );
}
