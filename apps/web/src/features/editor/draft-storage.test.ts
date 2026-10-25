import { describe, expect, test } from "vitest";
import type { TranslationImage } from "./draft-storage";
import {
  createTranslationDraft,
  isTranslationDraftExpired,
  localDraftRetentionMs,
  reapplyDraftContent,
  reconcileTranslationDraft,
  translationDraftKey,
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
    const draft = createTranslationDraft("user-1", "work-1", [localImage]);
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

  test("explicit reapply keeps the new server revision and reapplies content", () => {
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
    const result = reapplyDraftContent([changedServer], [localImage]);
    expect(result.images[0].entries[0].revision).toBe(4);
    expect(result.images[0].entries[0].translatedText).toBe("我的本地内容");
    expect(result.dirtyEntryIds).toEqual(new Set(["entry-1"]));
  });
});
