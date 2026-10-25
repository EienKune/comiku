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
}

export interface TranslationDraftHead {
  editorEpoch: number;
  latestVersionId: string | null;
}

const databaseName = "comiku-editor";
const storeName = "translation-drafts";
const databaseVersion = 1;
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
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

export async function loadTranslationDraft(userId: string, workId: string) {
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

export async function saveTranslationDraft(draft: TranslationDraftRecord) {
  await runStoreRequest<IDBValidKey>("readwrite", (store) => store.put(draft));
}

export async function deleteTranslationDraft(userId: string, workId: string) {
  await runStoreRequest<undefined>("readwrite", (store) =>
    store.delete(translationDraftKey(userId, workId)),
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
  const dirtyEntryIds = new Set<string>();
  const draftEditorEpoch = draft.editorEpoch ?? 0;
  const draftVersionId = draft.latestVersionId ?? null;
  if (
    draftEditorEpoch !== serverHead.editorEpoch ||
    draftVersionId !== serverHead.latestVersionId
  ) {
    return {
      compatible: false as const,
      conflict: "epoch" as const,
      dirtyEntryIds,
    };
  }
  if (
    draft.images.length !== serverImages.length ||
    serverImages.some(
      (serverImage) =>
        !draft.images.some((draftImage) => draftImage.id === serverImage.id),
    )
  ) {
    return {
      compatible: false as const,
      conflict: "content" as const,
      dirtyEntryIds,
    };
  }
  for (const draftImage of draft.images) {
    const serverImage = serverImages.find(
      (image) => image.id === draftImage.id,
    );
    if (
      !serverImage ||
      serverImage.translationRevision !== draftImage.translationRevision
    ) {
      return {
        compatible: false as const,
        conflict: "content" as const,
        dirtyEntryIds,
      };
    }
    const persistedEntries = draftImage.entries.filter(
      (entry) => !entry.localOnly,
    );
    if (
      persistedEntries.length !== serverImage.entries.length ||
      serverImage.entries.some(
        (serverEntry) =>
          !persistedEntries.some((entry) => entry.id === serverEntry.id),
      )
    ) {
      return {
        compatible: false as const,
        conflict: "content" as const,
        dirtyEntryIds: new Set<string>(),
      };
    }
    for (const draftEntry of draftImage.entries) {
      if (draftEntry.localOnly) {
        dirtyEntryIds.add(draftEntry.id);
        continue;
      }
      const serverEntry = serverImage.entries.find(
        (entry) => entry.id === draftEntry.id,
      );
      if (!serverEntry || serverEntry.revision !== draftEntry.revision) {
        return {
          compatible: false as const,
          conflict: "content" as const,
          dirtyEntryIds: new Set<string>(),
        };
      }
      if (!sameEntryContent(draftEntry, serverEntry)) {
        dirtyEntryIds.add(draftEntry.id);
      }
    }
  }
  return { compatible: true as const, conflict: null, dirtyEntryIds };
}

export function reapplyDraftContent(
  serverImages: TranslationImage[],
  draftImages: EditableTranslationImage[],
) {
  const dirtyEntryIds = new Set<string>();
  const images: EditableTranslationImage[] = serverImages.map((serverImage) => {
    const localImage = draftImages.find((image) => image.id === serverImage.id);
    if (!localImage) return serverImage;
    const entries = serverImage.entries.map((serverEntry) => {
      const localEntry = localImage.entries.find(
        (entry) => entry.id === serverEntry.id && !entry.localOnly,
      );
      if (!localEntry) return serverEntry;
      if (sameEntryContent(localEntry, serverEntry)) return serverEntry;
      dirtyEntryIds.add(serverEntry.id);
      return {
        ...serverEntry,
        markerX: localEntry.markerX,
        markerY: localEntry.markerY,
        markerPositionType: localEntry.markerPositionType,
        translatedText: localEntry.translatedText,
        note: localEntry.note,
      };
    });
    return { ...serverImage, entries };
  });
  return { images, dirtyEntryIds };
}
