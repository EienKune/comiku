/** Use the browser's editing transaction so Ctrl/Cmd+Z and redo keep working. */
export function replaceTextareaRange(
  node: HTMLTextAreaElement,
  edit: {
    start: number;
    end: number;
    replacement: string;
    expectedText: string;
  },
) {
  const { start, end, replacement, expectedText } = edit;
  if (
    !node.isConnected ||
    node.disabled ||
    node.readOnly ||
    node.value !== expectedText ||
    start < 0 ||
    end < start ||
    end > expectedText.length
  )
    return false;

  node.focus({ preventScroll: true });
  node.setSelectionRange(start, end);
  if (typeof document.execCommand !== "function") return false;
  try {
    document.execCommand("insertText", false, replacement);
  } catch {
    return false;
  }
  return (
    node.value ===
    expectedText.slice(0, start) + replacement + expectedText.slice(end)
  );
}
