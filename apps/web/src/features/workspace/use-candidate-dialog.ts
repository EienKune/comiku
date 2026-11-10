import { useEffect, useRef } from "react";

export function useCandidateDialog() {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement,
      dialog = ref.current;
    dialog?.showModal();
    dialog
      ?.querySelector<HTMLElement>("button:not(:disabled),input:not(:disabled)")
      ?.focus();
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  return ref;
}
