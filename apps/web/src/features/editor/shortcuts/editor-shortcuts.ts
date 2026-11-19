export const shortcutActions = [
  { id: "pan", label: "移动画布", defaultKey: "1" },
  { id: "add-inside", label: "添加框内", defaultKey: "2" },
  { id: "add-outside", label: "添加框外", defaultKey: "3" },
  { id: "move", label: "移动标记", defaultKey: "4" },
  { id: "previous-marker", label: "上一个标记", defaultKey: "ArrowUp" },
  { id: "next-marker", label: "下一个标记", defaultKey: "ArrowDown" },
  { id: "previous-page", label: "上一页", defaultKey: "ArrowLeft" },
  { id: "next-page", label: "下一页", defaultKey: "ArrowRight" },
] as const;

export type ShortcutAction = (typeof shortcutActions)[number]["id"];
export type EditorShortcuts = Record<ShortcutAction, string>;
export const defaultEditorShortcuts = Object.fromEntries(
  shortcutActions.map(({ id, defaultKey }) => [id, defaultKey]),
) as EditorShortcuts;

const navigationKeys = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);
const labels: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  PageUp: "PgUp",
  PageDown: "PgDn",
};
const reservedMessage =
  "请使用字母、数字或导航键；Shift 仅可搭配导航键。Ctrl、Alt、Meta 及浏览器、文本编辑按键已保留。";

export function shortcutLabel(shortcut: string) {
  return shortcut
    .split("+")
    .map(
      (part) => labels[part] ?? (part.length === 1 ? part.toUpperCase() : part),
    )
    .join(" + ");
}

export function shortcutAria(shortcut: string) {
  return shortcut
    .split("+")
    .map((part) => (part.length === 1 ? part.toUpperCase() : part))
    .join("+");
}

export function isAllowedShortcut(shortcut: string) {
  if (typeof shortcut !== "string") return false;
  if (/^[a-z0-9]$/.test(shortcut) || navigationKeys.has(shortcut)) return true;
  return shortcut.startsWith("Shift+") && navigationKeys.has(shortcut.slice(6));
}

type ShortcutKeyEvent = Pick<
  KeyboardEvent,
  | "key"
  | "ctrlKey"
  | "altKey"
  | "metaKey"
  | "shiftKey"
  | "isComposing"
  | "keyCode"
>;

export function captureShortcut(
  event: ShortcutKeyEvent,
): { shortcut: string } | { error: string } | null {
  if (
    event.isComposing ||
    event.keyCode === 229 ||
    [
      "Shift",
      "Control",
      "Alt",
      "Meta",
      "Dead",
      "Process",
      "Unidentified",
    ].includes(event.key)
  )
    return null;
  if (event.ctrlKey || event.altKey || event.metaKey)
    return { error: reservedMessage };
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const shortcut = `${event.shiftKey ? "Shift+" : ""}${key}`;
  return isAllowedShortcut(shortcut)
    ? { shortcut }
    : { error: reservedMessage };
}

export function validateEditorShortcuts(
  bindings: EditorShortcuts,
): string | null {
  const seen = new Map<string, string>();
  for (const { id, label } of shortcutActions) {
    const shortcut = bindings[id];
    if (!isAllowedShortcut(shortcut)) return `${label}：${reservedMessage}`;
    const previous = seen.get(shortcut);
    if (previous)
      return `${label}与${previous}使用了相同的快捷键 ${shortcutLabel(shortcut)}。`;
    seen.set(shortcut, label);
  }
  return null;
}

export function editorShortcutStorageKey(accountId: string) {
  return `comiku:editor-shortcuts:v1:${accountId}`;
}

export function readEditorShortcuts(accountId: string): {
  bindings: EditorShortcuts;
  notice: string | null;
} {
  try {
    const raw = localStorage.getItem(editorShortcutStorageKey(accountId));
    if (!raw) return { bindings: { ...defaultEditorShortcuts }, notice: null };
    const saved = JSON.parse(raw) as { version?: unknown; bindings?: unknown };
    if (
      saved.version !== 1 ||
      !saved.bindings ||
      typeof saved.bindings !== "object"
    )
      throw new Error("Invalid shortcuts");
    const bindings = Object.fromEntries(
      shortcutActions.map(({ id }) => [
        id,
        (saved.bindings as Record<string, unknown>)[id],
      ]),
    ) as EditorShortcuts;
    if (validateEditorShortcuts(bindings)) throw new Error("Invalid shortcuts");
    return { bindings, notice: null };
  } catch {
    return {
      bindings: { ...defaultEditorShortcuts },
      notice: "无法读取浏览器中的快捷键设置，已使用默认设置。",
    };
  }
}

export function writeEditorShortcuts(
  accountId: string,
  bindings: EditorShortcuts,
): string | null {
  try {
    localStorage.setItem(
      editorShortcutStorageKey(accountId),
      JSON.stringify({ version: 1, bindings }),
    );
    return null;
  } catch {
    return "浏览器无法保存快捷键；本次页面内仍然生效，刷新后可能恢复默认设置。";
  }
}

// Navigation never takes arrow keys from a native control or an ARIA widget.
export function isShortcutControl(target: Element) {
  return Boolean(
    target.closest(
      'input, textarea, select, a, button:not(.translation-marker), summary, audio, video, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="spinbutton"], [role="slider"], [role="listbox"], [role="menu"], [role="tablist"], [role="tree"], [role="grid"]',
    ),
  );
}
