import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ConfirmationDialog, type Confirmation } from "./ConfirmationDialog";

const sameScope = (left: readonly unknown[], right: readonly unknown[]) =>
  left.length === right.length &&
  left.every((value, index) => Object.is(value, right[index]));

/** Scope pins the resource, permissions, revision and local draft being approved. */
export function useConfirmation(scope: readonly unknown[]) {
  const mounted = useRef(true);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const pending = useRef<{
    scope: readonly unknown[];
    resolve: (approved: boolean) => void;
  } | null>(null);
  const [options, setOptions] = useState<Confirmation | null>(null);
  const settle = useCallback((approved: boolean) => {
    const request = pending.current;
    if (!request) return;
    pending.current = null;
    setOptions(null);
    request.resolve(approved && sameScope(request.scope, currentScope.current));
  }, []);
  useLayoutEffect(() => {
    if (pending.current && !sameScope(pending.current.scope, scope))
      settle(false);
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const request = pending.current;
      pending.current = null;
      request?.resolve(false);
    };
  }, []);
  const confirm = useCallback((next: Confirmation): Promise<boolean> => {
    if (!mounted.current || pending.current) return Promise.resolve(false);
    return new Promise((resolve) => {
      pending.current = { scope: [...currentScope.current], resolve };
      setOptions(next);
    });
  }, []);
  return {
    confirm,
    dialog: options ? (
      <ConfirmationDialog options={options} onClose={settle} />
    ) : null,
  };
}
