import type { components } from "@comiku/api-client";

export type TranslationImage =
  components["schemas"]["TranslationImageDraftDto"];
export type TranslationEntry = components["schemas"]["TranslationEntryDto"];

export interface EditableTranslationEntry extends TranslationEntry {
  localOnly?: boolean;
  idempotencyKey?: string;
}

export interface EditableTranslationImage extends Omit<
  TranslationImage,
  "entries"
> {
  entries: EditableTranslationEntry[];
}

export interface TranslationDraftRecord {
  version: 1;
  key: string;
  userId: string;
  workId: string;
  updatedAt: number;
  expiresAt: number;
  editorEpoch?: number;
  latestVersionId?: string | null;
  images: EditableTranslationImage[];
  /** Missing on legacy snapshots, whose edited entries cannot be inferred safely. */
  dirtyEntryIds?: string[];
}

export interface TranslationDraftHead {
  editorEpoch: number;
  latestVersionId: string | null;
}

const databaseName = "comiku-editor";
const storeName = "translation-drafts";
const databaseVersion = 1;
const pendingDraftWrites = new Map<string, Promise<unknown>>();
export const localDraftRetentionMs = 7 * 24 * 60 * 60 * 1000;

export function translationDraftKey(userId: string, workId: string) {
  return `${userId}:${workId}`;
}

export function createTranslationDraft(
  userId: string,
  workId: string,
  images: EditableTranslationImage[],
  head: TranslationDraftHead = { editorEpoch: 0, latestVersionId: null },
  now = Date.now(),
  dirtyEntryIds?: Iterable<string>,
): TranslationDraftRecord {
  return {
    version: 1,
    key: translationDraftKey(userId, workId),
    userId,
    workId,
    updatedAt: now,
    expiresAt: now + localDraftRetentionMs,
    editorEpoch: head.editorEpoch,
    latestVersionId: head.latestVersionId,
    images,
    ...(dirtyEntryIds === undefined
      ? {}
      : {
          dirtyEntryIds: [
            ...new Set([
              ...dirtyEntryIds,
              ...images.flatMap((image) =>
                image.entries
                  .filter((entry) => entry.localOnly)
                  .map((entry) => entry.id),
              ),
            ]),
          ],
        }),
  };
}

export function isTranslationDraftExpired(
  draft: TranslationDraftRecord,
  now = Date.now(),
) {
  return draft.expiresAt <= now;
}

function openDraftDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error("当前浏览器不支持本地草稿存储"));
      return;
    }
    const request = globalThis.indexedDB.open(databaseName, databaseVersion);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) {
        request.result.createObjectStore(storeName, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function runStoreRequest<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
) {
  const database = await openDraftDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const request = operation(transaction.objectStore(storeName));
      let result: T;
      request.onsuccess = () => {
        result = request.result;
      };
      transaction.oncomplete = () => resolve(result);
      request.onerror = () => reject(request.error);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

export async function loadTranslationDraft(userId: string, workId: string) {
  await pendingDraftWrites
    .get(translationDraftKey(userId, workId))
    ?.catch(() => undefined);
  await cleanupExpiredTranslationDrafts();
  const key = translationDraftKey(userId, workId);
  const draft = await runStoreRequest<TranslationDraftRecord | undefined>(
    "readonly",
    (store) => store.get(key),
  );
  if (!draft) return null;
  if (draft.version !== 1 || isTranslationDraftExpired(draft)) {
    await deleteTranslationDraft(userId, workId);
    return null;
  }
  return draft;
}

export async function cleanupExpiredTranslationDrafts(now = Date.now()) {
  const database = await openDraftDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      const request = transaction.objectStore(storeName).openCursor();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const draft = cursor.value as TranslationDraftRecord;
        if (draft.version !== 1 || isTranslationDraftExpired(draft, now)) {
          cursor.delete();
        }
        cursor.continue();
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

function enqueueDraftWrite<T>(key: string, operation: () => Promise<T>) {
  const previous = pendingDraftWrites.get(key) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(operation);
  pendingDraftWrites.set(key, pending);
  const clear = () => {
    if (pendingDraftWrites.get(key) === pending) pendingDraftWrites.delete(key);
  };
  void pending.then(clear, clear);
  return pending;
}

export async function saveTranslationDraft(draft: TranslationDraftRecord) {
  await enqueueDraftWrite(draft.key, () =>
    runStoreRequest<IDBValidKey>("readwrite", (store) => store.put(draft)),
  );
}

export async function deleteTranslationDraft(userId: string, workId: string) {
  const key = translationDraftKey(userId, workId);
  await enqueueDraftWrite(key, () =>
    runStoreRequest<undefined>("readwrite", (store) => store.delete(key)),
  );
}

function sameEntryContent(
  left: EditableTranslationEntry,
  right: TranslationEntry,
) {
  return (
    left.markerX === right.markerX &&
    left.markerY === right.markerY &&
    left.markerPositionType === right.markerPositionType &&
    left.translatedText === right.translatedText &&
    left.note === right.note
  );
}

export function reconcileTranslationDraft(
  serverImages: TranslationImage[],
  draft: TranslationDraftRecord,
  serverHead: TranslationDraftHead = {
    editorEpoch: 0,
    latestVersionId: null,
  },
) {
  const base = {
    images: serverImages as EditableTranslationImage[],
    dirtyEntryIds: new Set<string>(),
    conflictedEntryIds: new Set<string>(),
    legacy: draft.dirtyEntryIds === undefined,
  };
  const draftEditorEpoch = draft.editorEpoch ?? 0;
  const draftVersionId = draft.latestVersionId ?? null;
  if (
    draftEditorEpoch !== serverHead.editorEpoch ||
    draftVersionId !== serverHead.latestVersionId
  ) {
    return {
      compatible: false as const,
      conflict: "epoch" as const,
      ...base,
    };
  }
  const result = reapplyDraftContent(
    serverImages,
    draft.images,
    draft.dirtyEntryIds,
  );
  if (result.legacy || result.conflictedEntryIds.size) {
    return {
      compatible: false as const,
      conflict: "content" as const,
      ...result,
    };
  }
  return { compatible: true as const, conflict: null, ...result };
}

export function reapplyDraftContent(
  serverImages: TranslationImage[],
  draftImages: EditableTranslationImage[],
  trackedEntryIds?: Iterable<string>,
) {
  const dirtyEntryIds = new Set<string>();
  const conflictedEntryIds = new Set<string>();
  if (trackedEntryIds === undefined) {
    return {
      images: serverImages as EditableTranslationImage[],
      dirtyEntryIds,
      conflictedEntryIds,
      legacy: true,
    };
  }
  const tracked = new Set(trackedEntryIds);
  for (const image of draftImages) {
    for (const entry of image.entries) {
      if (entry.localOnly) tracked.add(entry.id);
    }
  }
  const unresolved = new Set(tracked);
  const images: EditableTranslationImage[] = serverImages.map((serverImage) => {
    const localImage = draftImages.find((image) => image.id === serverImage.id);
    if (!localImage) return serverImage;
    const entries: EditableTranslationEntry[] = serverImage.entries.map(
      (serverEntry) => {
        const localEntry = localImage.entries.find(
          (entry) => entry.id === serverEntry.id && tracked.has(entry.id),
        );
        if (!localEntry) return serverEntry;
        unresolved.delete(localEntry.id);
        if (localEntry.workImageId !== serverImage.id || localEntry.localOnly) {
          conflictedEntryIds.add(localEntry.id);
          return serverEntry;
        }
        if (sameEntryContent(localEntry, serverEntry)) return serverEntry;
        if (serverEntry.revision !== localEntry.revision) {
          conflictedEntryIds.add(localEntry.id);
          return serverEntry;
        }
        dirtyEntryIds.add(serverEntry.id);
        return {
          ...serverEntry,
          markerX: localEntry.markerX,
          markerY: localEntry.markerY,
          markerPositionType: localEntry.markerPositionType,
          translatedText: localEntry.translatedText,
          note: localEntry.note,
        };
      },
    );
    for (const localEntry of localImage.entries) {
      if (!localEntry.localOnly || !unresolved.has(localEntry.id)) continue;
      unresolved.delete(localEntry.id);
      if (
        localEntry.workImageId !== serverImage.id ||
        !localEntry.idempotencyKey ||
        serverImages.some((image) =>
          image.entries.some((entry) => entry.id === localEntry.id),
        )
      ) {
        conflictedEntryIds.add(localEntry.id);
        continue;
      }
      entries.push({ ...localEntry, orderIndex: entries.length });
      dirtyEntryIds.add(localEntry.id);
    }
    return { ...serverImage, entries };
  });
  for (const entryId of unresolved) conflictedEntryIds.add(entryId);
  return { images, dirtyEntryIds, conflictedEntryIds, legacy: false };
}
