import { useOutletContext } from "react-router";
import type { CurrentUser } from "@comiku/api-client";
export function useAccount() {
  return useOutletContext<CurrentUser>();
}
