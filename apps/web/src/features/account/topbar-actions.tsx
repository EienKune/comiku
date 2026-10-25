import {
  createContext,
  useContext,
  useEffect,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

export interface TopbarActionRegistration {
  content: ReactNode;
  collapsedLabel?: string;
}

export const TopbarActionsContext = createContext<
  Dispatch<SetStateAction<TopbarActionRegistration | null>> | undefined
>(undefined);

export function useTopbarActions(
  registration: TopbarActionRegistration | null,
) {
  const setRegistration = useContext(TopbarActionsContext);
  useEffect(() => {
    if (!setRegistration) return;
    setRegistration(registration);
    return () => setRegistration(null);
  }, [registration, setRegistration]);
}
