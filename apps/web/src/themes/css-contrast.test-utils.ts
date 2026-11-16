import { readFileSync } from "node:fs";
import { mountTheme, type ThemePreference } from "../styles/theme";

export function readThemeCss(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}
const tokensCss = readThemeCss("../styles/tokens.css");
const globalCss = readThemeCss("../styles/global.css");
const accountCss = readThemeCss("../features/account/account.css");
const playgroundCss = readThemeCss("../playground/playground.css");

// jsdom leaves CSS variables unresolved. Resolve them first, then apply the real
// stylesheets to a small fixture; dangerColors handles its known hover limitation.
export function mountContrastFixture(theme: ThemePreference, packCss: string) {
  const base = document.createElement("style");
  base.textContent = tokensCss;
  document.head.append(base);
  const restore = mountTheme(document.documentElement, theme);
  const root = getComputedStyle(document.documentElement);
  function resolve(value: string): string {
    const start = value.indexOf("var(");
    if (start < 0) return value;
    let end = start + 4;
    let depth = 1;
    while (depth && end < value.length) {
      if (value[end] === "(") depth++;
      if (value[end] === ")") depth--;
      end++;
    }
    const [key, ...fallback] = value.slice(start + 4, end - 1).split(",");
    const replacement =
      root.getPropertyValue(key.trim()).trim() || fallback.join(",").trim();
    return resolve(
      value.slice(0, start) + resolve(replacement) + value.slice(end),
    );
  }
  const styles = document.createElement("style");
  // A test attribute makes hover deterministic, keeping declarations intact.
  styles.textContent = resolve(
    [globalCss, accountCss, playgroundCss, packCss].join("\n"),
  ).replaceAll(":hover", "[data-hover]");
  document.head.append(styles);
  const fixture = document.createElement("div");
  fixture.innerHTML = `
    <div class="account-app"><button class="ui-button ui-button--danger">删除</button></div>
    <div class="account-dialog"><button class="ui-button ui-button--danger">删除</button></div>
    <div class="hero-card"><strong>8 个作品已完成</strong><small>今日进度</small></div>
    <div class="hero-work-card"><div class="hero-work-card__content"><strong>作品标题</strong><span>4 pages</span></div></div>
    <div class="marker-demo"><div class="marker-demo__list"><h3>译文</h3><button class="translation-row">普通译文</button></div>
      <button class="translation-marker" data-hover>1</button>
      <button class="translation-marker is-selected">2</button>
      <button class="translation-marker translation-marker--outside">3</button>
    </div>`;
  document.body.append(fixture);
  return {
    dangerColors(button: HTMLElement, hover: boolean) {
      button.removeAttribute("data-hover");
      const baseStyle = getComputedStyle(button);
      let color = baseStyle.color;
      let backgroundColor = baseStyle.backgroundColor;
      if (hover) {
        button.setAttribute("data-hover", "");
        // jsdom ignores selector specificity when a later account base rule
        // meets an earlier, more specific hover rule. Apply the real matching
        // hover declarations after that base; pack hover rules come last.
        for (const rule of Array.from(styles.sheet!.cssRules)) {
          if (
            !(rule instanceof CSSStyleRule) ||
            !rule.selectorText.includes(".ui-button--danger") ||
            !rule.selectorText.includes("[data-hover]") ||
            !button.matches(rule.selectorText)
          )
            continue;
          color = rule.style.color || color;
          backgroundColor =
            rule.style.backgroundColor ||
            rule.style.background ||
            backgroundColor;
        }
      }
      return { color, backgroundColor };
    },
    element(selector: string) {
      const element = fixture.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing contrast fixture: ${selector}`);
      return element;
    },
    dispose() {
      fixture.remove();
      styles.remove();
      restore();
      base.remove();
    },
  };
}

export function cssContrast(
  foreground: string,
  background: string,
  behind = "rgb(0, 0, 0)",
) {
  const rgb = (value: string) => {
    if (/^#[\da-f]{6}$/i.test(value))
      return [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
    const channels = value.match(/[\d.]+/g)?.map(Number);
    if (!channels || channels.length < 3)
      throw new Error(`Unresolved CSS color: ${value}`);
    return channels;
  };
  const bg = rgb(background);
  const alpha = bg[3] ?? 1;
  const underneath = rgb(behind);
  const composite = bg
    .slice(0, 3)
    .map((channel, i) => channel * alpha + underneath[i] * (1 - alpha));
  const luminance = (channels: number[]) => {
    const values = channels
      .slice(0, 3)
      .map((channel) => channel / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
  };
  const [lo, hi] = [luminance(rgb(foreground)), luminance(composite)].sort(
    (a, b) => a - b,
  );
  return (hi + 0.05) / (lo + 0.05);
}
