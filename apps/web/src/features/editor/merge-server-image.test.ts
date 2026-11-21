import { expect, test } from "vitest";
import { mergeServerImage } from "./merge-server-image";
import type {
  EditableTranslationEntry,
  EditableTranslationImage,
} from "./draft-storage";
const entry = {
  id: "dirty",
  workImageId: "page",
  orderIndex: 0,
  revision: 2,
  translatedText: "本地未保存稿",
  updatedById: "original",
} as EditableTranslationEntry;
const image = (entries: EditableTranslationEntry[]) =>
  ({ id: "page", translationRevision: 1, entries }) as EditableTranslationImage;

test("a structural receipt updates order but keeps the dirty entry's original revision and metadata", () => {
  const remote = {
    ...entry,
    orderIndex: 1,
    revision: 3,
    translatedText: "同事云端稿",
    updatedById: "colleague",
  };
  const result = mergeServerImage(
    image([remote]),
    image([entry]),
    new Set([entry.id]),
  );
  expect(result.image.entries[0]).toEqual({ ...entry, orderIndex: 1 });
  expect([...result.conflictedEntryIds]).toEqual([entry.id]);
});
test("a remotely deleted dirty entry survives in the copyable conflict snapshot", () => {
  const result = mergeServerImage(
    image([]),
    image([entry]),
    new Set([entry.id]),
  );
  expect(result.image.entries).toEqual([entry]);
  expect([...result.conflictedEntryIds]).toEqual([entry.id]);
});
test("an in-flight local creation absent from another receipt is retained without becoming a deletion conflict", () => {
  const local = {
    ...entry,
    id: "local:pending",
    localOnly: true,
    idempotencyKey: "request",
  };
  const result = mergeServerImage(
    image([]),
    image([local]),
    new Set([local.id]),
  );
  expect(result.image.entries).toEqual([local]);
  expect(result.conflictedEntryIds.size).toBe(0);
});
test("only the acknowledged local creation is removed when its confirmed server entry arrives", () => {
  const acknowledged = { ...entry, id: "local:created", localOnly: true };
  const inFlight = { ...entry, id: "local:next", localOnly: true };
  const confirmed = { ...entry, id: "confirmed" };
  const result = mergeServerImage(
    image([confirmed]),
    image([acknowledged, inFlight]),
    new Set([acknowledged.id, inFlight.id]),
    acknowledged.id,
  );
  expect(result.image.entries.map(({ id }) => id)).toEqual([
    "confirmed",
    "local:next",
  ]);
  expect(result.image.entries[1].revision).toBe(inFlight.revision);
  expect(result.conflictedEntryIds.size).toBe(0);
});
