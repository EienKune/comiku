import { fireEvent } from "@testing-library/react";

/** jsdom has no native text transaction. Browser tests cover real undo/redo. */
export function installNativeTextEditMock() {
  const previous = Object.getOwnPropertyDescriptor(document, "execCommand");
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: (command: string, _showUI: boolean, replacement: string) => {
      const node = document.activeElement;
      if (command !== "insertText" || !(node instanceof HTMLTextAreaElement))
        return false;
      const { value, selectionStart, selectionEnd } = node;
      const caret = selectionStart + replacement.length;
      fireEvent.input(node, {
        target: {
          value:
            value.slice(0, selectionStart) +
            replacement +
            value.slice(selectionEnd),
          selectionStart: caret,
          selectionEnd: caret,
        },
      });
      return true;
    },
  });
  return () => {
    if (previous) Object.defineProperty(document, "execCommand", previous);
    else Reflect.deleteProperty(document, "execCommand");
  };
}
