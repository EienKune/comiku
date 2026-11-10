import { useContext, useRef, useState, type ReactNode } from "react";

import {
  InspectionContext,
  type Inspection,
} from "./candidate-inspection-context";

/** An ancestor page can share this scope; standalone tag blocks remain isolated. */
export function CandidateInspectionScope({
  children,
}: {
  children: ReactNode;
}) {
  const inherited = useContext(InspectionContext);
  const current = useRef<Inspection | null>(null);
  const [coordinator] = useState(() => ({
    claim(next: Inspection) {
      if (current.current?.id !== next.id) current.current?.close();
      current.current = next;
    },
    release(id: string) {
      if (current.current?.id === id) current.current = null;
    },
  }));
  return (
    <InspectionContext value={inherited ?? coordinator}>
      {children}
    </InspectionContext>
  );
}
