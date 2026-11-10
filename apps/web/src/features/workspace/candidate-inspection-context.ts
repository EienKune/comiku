import { createContext, useCallback, useContext, useEffect } from "react";
export type Inspection = { id: string; close: () => void };
export const InspectionContext = createContext<{
  claim: (next: Inspection) => void;
  release: (id: string) => void;
} | null>(null);

export function useCandidateInspection(id: string, close: () => void) {
  const coordinator = useContext(InspectionContext);
  useEffect(() => () => coordinator?.release(id), [coordinator, id]);
  return useCallback(
    () => coordinator?.claim({ id, close }),
    [coordinator, id, close],
  );
}
