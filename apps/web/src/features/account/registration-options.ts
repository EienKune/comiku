import { useQuery } from "@tanstack/react-query";
import { client, unwrap } from "./api";

export const registrationOptionsKey = ["registration-options"];
export function useRegistrationOptions(enabled = true) {
  return useQuery({
    queryKey: registrationOptionsKey,
    queryFn: async ({ signal }) =>
      unwrap(await client.GET("/api/auth/registration", { signal })),
    enabled,
    staleTime: 0,
  });
}
