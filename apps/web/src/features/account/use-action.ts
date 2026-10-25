import { useCallback, useRef, useState } from "react";
export function useAction() {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const run = useCallback(async (action: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : "请求失败，请稍后重试");
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);
  return { busy, error, success, setSuccess, run };
}
