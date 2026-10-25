import { useLayoutEffect, useState, type CSSProperties } from "react";
import { Palette, RotateCcw } from "lucide-react";
import {
  Badge,
  Button,
  SelectField,
  Surface,
  TextField,
} from "../components/ui";
import {
  brandReadability,
  defaultTheme,
  isHexColor,
  readTheme,
  themePresets,
  themeStorageKey,
  type ThemePreference,
  type ThemeStyle,
} from "../styles/theme";
import "./theme-preview.css";

export function ThemePreview() {
  const [theme, setTheme] = useState<ThemePreference>(() => {
    try {
      return readTheme(localStorage.getItem(themeStorageKey));
    } catch {
      return { ...defaultTheme };
    }
  });
  const [draft, setDraft] = useState(theme.brand);
  const contrast = brandReadability(theme.brand);
  function choose(next: ThemePreference) {
    setTheme({ brand: next.brand, style: next.style });
    setDraft(next.brand);
  }
  useLayoutEffect(() => {
    const root = document.documentElement;
    const values = {
      "--color-brand": theme.brand,
      "--color-on-brand": contrast.normal.color,
      "--color-on-brand-hover": contrast.hover.color,
    };
    const previous = Object.keys(values).map((key) => [
      key,
      root.style.getPropertyValue(key),
      root.style.getPropertyPriority(key),
    ]);
    const previousStyle = root.getAttribute("data-theme-style");
    Object.entries(values).forEach(([key, value]) =>
      root.style.setProperty(key, value),
    );
    root.dataset.themeStyle = theme.style;
    try {
      localStorage.setItem(themeStorageKey, JSON.stringify(theme));
    } catch {
      /* Preview remains usable when storage is blocked. */
    }
    return () => {
      previous.forEach(([key, value, priority]) =>
        value
          ? root.style.setProperty(key, value, priority)
          : root.style.removeProperty(key),
      );
      if (previousStyle === null) root.removeAttribute("data-theme-style");
      else root.setAttribute("data-theme-style", previousStyle);
    };
  }, [theme, contrast.normal.color, contrast.hover.color]);

  return (
    <Surface className="theme-preview" id="theme">
      <div className="theme-preview__heading">
        <div>
          <Palette size={20} />
          <h2>换个颜色，看看。</h2>
        </div>
        <Button
          size="sm"
          variant="ghost"
          leadingIcon={<RotateCcw size={14} />}
          onClick={() => choose({ ...defaultTheme })}
        >
          恢复默认
        </Button>
      </div>
      <p>同一套组件，六种表情。切换后往下浏览，或在“交互手感”里试试。</p>
      <div className="theme-presets" role="group" aria-label="主题预设">
        {themePresets.map((preset) => (
          <button
            key={preset.name}
            type="button"
            aria-pressed={
              theme.brand.toLowerCase() === preset.brand &&
              theme.style === preset.style
            }
            onClick={() => choose(preset)}
          >
            <span aria-hidden="true" style={{ background: preset.brand }} />
            <strong>{preset.name}</strong>
            <code>{preset.brand.toUpperCase()}</code>
          </button>
        ))}
      </div>
      <div className="theme-custom">
        <label className="theme-picker">
          品牌色
          <input
            type="color"
            aria-label="选择品牌颜色"
            value={theme.brand}
            onChange={(event) =>
              choose({ ...theme, brand: event.target.value })
            }
          />
        </label>
        <TextField
          label="自定义色值"
          value={draft}
          maxLength={7}
          spellCheck={false}
          error={!isHexColor(draft) ? "请输入 # 加六位十六进制色值" : undefined}
          onChange={(event) => {
            const value = event.target.value;
            setDraft(value);
            if (isHexColor(value))
              setTheme({ ...theme, brand: value.toLowerCase() });
          }}
        />
        <SelectField
          label="界面风格"
          value={theme.style}
          onValueChange={(value) =>
            choose({ ...theme, style: value as ThemeStyle })
          }
        >
          <option value="soft">柔彩 · 圆润与轻回弹</option>
          <option value="minimal">极简 · 克制与清晰边界</option>
        </SelectField>
      </div>
      <div className="theme-scale" aria-label="品牌派生色阶">
        {[50, 100, 200, 400, 500, 600, 700].map((step) => (
          <div key={step}>
            <span
              style={
                { background: `var(--color-brand-${step})` } as CSSProperties
              }
            />
            <code>{step}</code>
          </div>
        ))}
      </div>
      <div className="theme-contrast" role="status">
        按钮文字对比度：默认{" "}
        <strong>{contrast.normal.contrast.toFixed(2)}:1</strong> · 悬停{" "}
        <strong>{contrast.hover.contrast.toFixed(2)}:1</strong>
        （各自自动选择黑/白字，目标 ≥ 4.5:1）
      </div>
      <div className="theme-semantic">
        <span>状态色保持独立</span>
        <Badge tone="translation" dot>
          翻译
        </Badge>
        <Badge tone="success" dot>
          成功
        </Badge>
        <Badge tone="info" dot>
          信息
        </Badge>
        <Badge tone="warning" dot>
          警告
        </Badge>
        <Badge tone="danger" dot>
          错误
        </Badge>
        <Badge tone="violet" dot>
          嵌字
        </Badge>
      </div>
      <small>
        仅在此 Playground 预览，选择保存在本机。黑白风格保留状态色和作品原色。
      </small>
    </Surface>
  );
}
