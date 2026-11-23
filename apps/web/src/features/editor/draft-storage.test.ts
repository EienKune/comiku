import { afterEach, describe, expect, test, vi } from "vitest";
import type { TranslationImage } from "./draft-storage";
import {
  createTranslationDraft,
  isTranslationDraftExpired,
  localDraftRetentionMs,
  reapplyDraftContent,
  reconcileTranslationDraft,
  translationDraftKey,
  saveTranslationDraft,
  deleteTranslationDraft,
} from "./draft-storage";

const image: TranslationImage = {
  id: "image-1",
  orderIndex: 0,
  width: 1200,
  height: 1800,
  translationRevision: 2,
  entries: [
    {
      id: "entry-1",
      workImageId: "image-1",
      orderIndex: 0,
      markerX: 0.25,
      markerY: 0.4,
      markerPositionType: "inside",
      translatedText: "服务端译文",
      note: null,
      revision: 3,
      createdById: "user-1",
      updatedById: "user-1",
      createdAt: "2026-09-08T00:00:00.000Z",
      updatedAt: "2026-09-08T00:00:00.000Z",
    },
  ],
};

describe("translation draft policy", () => {
  afterEach(() => vi.unstubAllGlobals());
  test("keys drafts per user and work and expires them after seven days", () => {
    const draft = createTranslationDraft(
      "user-1",
      "work-1",
      [image],
      { editorEpoch: 2, latestVersionId: "version-2" },
      1000,
    );
    expect(translationDraftKey("user-1", "work-1")).toBe("user-1:work-1");
    expect(draft.expiresAt).toBe(1000 + localDraftRetentionMs);
    expect(draft.editorEpoch).toBe(2);
    expect(isTranslationDraftExpired(draft, draft.expiresAt - 1)).toBe(false);
    expect(isTranslationDraftExpired(draft, draft.expiresAt)).toBe(true);
  });

  test("never restores a draft across a submitted editor epoch", () => {
    const draft = createTranslationDraft("user-1", "work-1", [image], {
      editorEpoch: 1,
      latestVersionId: "version-1",
    });
    const result = reconcileTranslationDraft([image], draft, {
      editorEpoch: 2,
      latestVersionId: "version-2",
    });
    expect(result.compatible).toBe(false);
    expect(result.conflict).toBe("epoch");
  });

  test("restores a local edit only while its server revisions still match", () => {
    const localImage = {
      ...image,
      entries: [{ ...image.entries[0], translatedText: "本地译文" }],
    };
    const draft = createTranslationDraft(
      "user-1",
      "work-1",
      [localImage],
      undefined,
      undefined,
      ["entry-1"],
    );
    const compatible = reconcileTranslationDraft([image], draft);
    expect(compatible.compatible).toBe(true);
    expect(compatible.dirtyEntryIds).toEqual(new Set(["entry-1"]));

    const changedServer = {
      ...image,
      entries: [{ ...image.entries[0], revision: 4 }],
    };
    expect(reconcileTranslationDraft([changedServer], draft).compatible).toBe(
      false,
    );
  });

  test("never reapplies stale input over another edit to the same entry", () => {
    const changedServer = {
      ...image,
      entries: [
        { ...image.entries[0], revision: 4, translatedText: "他人更新" },
      ],
    };
    const localImage = {
      ...image,
      entries: [{ ...image.entries[0], translatedText: "我的本地内容" }],
    };
    const result = reapplyDraftContent(
      [changedServer],
      [localImage],
      ["entry-1"],
    );
    expect(result.images[0].entries[0].revision).toBe(4);
    expect(result.images[0].entries[0].translatedText).toBe("他人更新");
    expect(result.dirtyEntryIds.size).toBe(0);
    expect(result.conflictedEntryIds).toEqual(new Set(["entry-1"]));
    expect(localImage.entries[0].translatedText).toBe("我的本地内容");
  });

  test("restores only tracked edits while retaining newer unrelated entries and pages", () => {
    const otherEntry = { ...image.entries[0], id: "entry-2", orderIndex: 1 };
    const original = { ...image, entries: [...image.entries, otherEntry] };
    const localImage = {
      ...original,
      entries: [
        { ...original.entries[0], translatedText: "本地修改" },
        otherEntry,
      ],
    };
    const otherPage = { ...image, id: "image-2", entries: [] };
    const current = {
      ...original,
      translationRevision: 9,
      entries: [
        original.entries[0],
        { ...otherEntry, revision: 4, translatedText: "另一个人的修改" },
      ],
    };
    const draft = createTranslationDraft(
      "user-1",
      "work-1",
      [localImage],
      undefined,
      undefined,
      ["entry-1"],
    );
    const result = reconcileTranslationDraft([current, otherPage], draft);
    expect(result.compatible).toBe(true);
    expect(
      result.images[0].entries.map((entry) => entry.translatedText),
    ).toEqual(["本地修改", "另一个人的修改"]);
    expect(result.images[1]).toBe(otherPage);
    expect(result.dirtyEntryIds).toEqual(new Set(["entry-1"]));
  });

  test("keeps legacy snapshots read-only because their edited entries are unknown", () => {
    const localImage = {
      ...image,
      entries: [{ ...image.entries[0], translatedText: "旧草稿" }],
    };
    const draft = createTranslationDraft("user-1", "work-1", [localImage]);
    expect(reconcileTranslationDraft([image], draft)).toMatchObject({
      compatible: false,
      legacy: true,
    });
    const result = reapplyDraftContent([image], draft.images);
    expect(result.images).toEqual([image]);
    expect(result.dirtyEntryIds.size).toBe(0);
    expect(result.legacy).toBe(true);
  });

  test("tracks local-only markers independently and restores them only to their original page", () => {
    const localEntry = {
      ...image.entries[0],
      id: "local-1",
      localOnly: true,
      idempotencyKey: "request-1",
      orderIndex: 1,
    };
    const localImage = { ...image, entries: [...image.entries, localEntry] };
    const draft = createTranslationDraft(
      "user-1",
      "work-1",
      [localImage],
      undefined,
      undefined,
      [],
    );
    expect(draft.dirtyEntryIds).toEqual(["local-1"]);
    const restored = reconcileTranslationDraft([image], draft);
    expect(restored.compatible).toBe(true);
    expect(restored.images[0].entries[1]).toEqual(localEntry);
    expect(restored.dirtyEntryIds).toEqual(new Set(["local-1"]));
    const missingPage = reapplyDraftContent(
      [],
      draft.images,
      draft.dirtyEntryIds,
    );
    expect(missingPage.conflictedEntryIds).toEqual(new Set(["local-1"]));
    expect(missingPage.images).toEqual([]);
  });

  test("does not restore an entry that moved to a different page or disappeared", () => {
    const localImage = {
      ...image,
      entries: [{ ...image.entries[0], translatedText: "本地修改" }],
    };
    const movedImage = {
      ...image,
      id: "image-2",
      entries: [{ ...image.entries[0], workImageId: "image-2" }],
    };
    const result = reapplyDraftContent(
      [{ ...image, entries: [] }, movedImage],
      [localImage],
      ["entry-1"],
    );
    expect(result.dirtyEntryIds.size).toBe(0);
    expect(result.conflictedEntryIds).toEqual(new Set(["entry-1"]));
    expect(result.images[1].entries[0].translatedText).toBe("服务端译文");
  });

  test("waits for durable draft writes and keeps later saves/deletes in invocation order", async () => {
    const transactions: {
      operation?: string;
      request: { result: unknown; onsuccess?: () => void };
      oncomplete?: () => void;
      onabort?: () => void;
      error?: Error;
    }[] = [];
    vi.stubGlobal("indexedDB", {
      open() {
        const request = {
          result: {
            close() {},
            transaction() {
              const transaction = {
                request: { result: "saved-key" },
                objectStore() {
                  return {
                    put(draft: { updatedAt: number }) {
                      transaction.operation = `put:${draft.updatedAt}`;
                      return transaction.request;
                    },
                    delete() {
                      transaction.operation = "delete";
                      return transaction.request;
                    },
                  };
                },
                operation: undefined as string | undefined,
              };
              transactions.push(transaction);
              return transaction;
            },
          },
          onsuccess: undefined as (() => void) | undefined,
        };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
    });
    const first = saveTranslationDraft(
      createTranslationDraft("durable-user", "work", [], undefined, 1, []),
    );
    const later = saveTranslationDraft(
      createTranslationDraft("durable-user", "work", [], undefined, 2, []),
    );
    const deletion = deleteTranslationDraft("durable-user", "work");
    let committed = false;
    void first.then(() => {
      committed = true;
    });
    await vi.waitFor(() => expect(transactions.length).toBeGreaterThan(0));
    transactions[0].request.onsuccess?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(committed).toBe(false);
    expect(transactions.map((tx) => tx.operation)).toEqual(["put:1"]);
    transactions[0].oncomplete?.();
    await first;
    await vi.waitFor(() => expect(transactions).toHaveLength(2));
    expect(transactions[1].operation).toBe("put:2");
    transactions[1].request.onsuccess?.();
    transactions[1].oncomplete?.();
    await later;
    await vi.waitFor(() => expect(transactions).toHaveLength(3));
    expect(transactions[2].operation).toBe("delete");
    transactions[2].request.onsuccess?.();
    transactions[2].oncomplete?.();
    await deletion;
  });
});
