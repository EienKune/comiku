import type { components, paths } from "@comiku/api-client";
import { client, unwrap } from "../account/api";
export type SeriesSummary = components["schemas"]["WorkSeriesSummaryDto"];
export type SeriesEntry = components["schemas"]["WorkSeriesEntryDto"];
export type SeriesDetail = components["schemas"]["WorkSeriesDetailDto"];
export type SeriesContext = components["schemas"]["WorkSeriesContextDto"];
type ImportIntent = components["schemas"]["WorkSeriesImportIntentDto"];
export type SeriesImportIntent =
  | (Required<Pick<ImportIntent, "seriesId" | "expectedRevision">> &
      Pick<ImportIntent, "label">)
  | (Required<Pick<ImportIntent, "createTitle" | "requestId">> &
      Pick<ImportIntent, "label">);
export const seriesApi = {
  list: async (
    query: paths["/api/work-series"]["get"]["parameters"]["query"],
    signal?: AbortSignal,
  ) =>
    unwrap(await client.GET("/api/work-series", { params: { query }, signal })),
  detail: async (
    id: string,
    query: paths["/api/work-series/{id}"]["get"]["parameters"]["query"],
    signal?: AbortSignal,
  ) =>
    unwrap(
      await client.GET("/api/work-series/{id}", {
        params: { path: { id }, query },
        signal,
      }),
    ),
  context: async (workId: string, signal?: AbortSignal) =>
    unwrap(
      await client.GET("/api/work-series/work/{workId}/context", {
        params: { path: { workId } },
        signal,
      }),
    ),
  create: async (body: components["schemas"]["CreateWorkSeriesDto"]) =>
    unwrap(await client.POST("/api/work-series", { body })),
  update: async (
    id: string,
    body: components["schemas"]["UpdateWorkSeriesDto"],
  ) =>
    unwrap(
      await client.PATCH("/api/work-series/{id}", {
        params: { path: { id } },
        body,
      }),
    ),
  add: async (
    id: string,
    body: components["schemas"]["AddWorkSeriesEntriesDto"],
  ) =>
    unwrap(
      await client.POST("/api/work-series/{id}/entries", {
        params: { path: { id } },
        body,
      }),
    ),
  updateEntry: async (
    id: string,
    entryId: string,
    body: components["schemas"]["UpdateWorkSeriesEntryDto"],
  ) =>
    unwrap(
      await client.PATCH("/api/work-series/{id}/entries/{entryId}", {
        params: { path: { id, entryId } },
        body,
      }),
    ),
  remove: async (
    id: string,
    entryId: string,
    body: components["schemas"]["WorkSeriesRevisionDto"],
  ) =>
    unwrap(
      await client.POST("/api/work-series/{id}/entries/{entryId}/remove", {
        params: { path: { id, entryId } },
        body,
      }),
    ),
};
