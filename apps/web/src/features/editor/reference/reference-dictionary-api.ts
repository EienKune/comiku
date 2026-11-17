import type { components } from "@comiku/api-client";
import { client, unwrap } from "../../account/api";

export type ReferenceDictionaryEntry =
  components["schemas"]["ReferenceDictionaryEntryDto"];
export type ReferenceDictionaryPage =
  components["schemas"]["ReferenceDictionaryPageDto"];

export async function searchReferenceDictionary(
  query: string,
  offset: number,
  signal: AbortSignal,
): Promise<ReferenceDictionaryPage> {
  return unwrap(
    await client.GET("/api/reference-dictionary", {
      params: { query: { q: query, offset } },
      signal,
    }),
  );
}
