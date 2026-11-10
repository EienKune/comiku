import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { NotFoundException } from "@nestjs/common";
import { WorksService } from "../src/works/works.service.js";

function fixture(unknownLegacyPage = false) {
  const media = ["media-a", "media-b", "media-c"].map((id, orderIndex) => ({
    id,
    orderIndex,
    width: 100,
    height: 200,
    mediaType: "photo",
    fileObject: {
      lifecycleStatus: orderIndex === 2 ? "pending_deletion" : "active",
      deletedAt: null,
      objectKey: "must-not-leak",
    },
  }));
  const source = {
    id: "candidate",
    platform: "synthetic",
    externalPostId: "post",
    externalPostUrl: "https://example.test/post",
    text: "later source description",
    rawJson: { private: "must-not-leak" },
    media,
  };
  const db = {
    work: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === "work"
          ? {
              sourceText: "imported description",
              sourceCandidatePost: source,
              images: [
                {
                  id: "page-one",
                  orderIndex: 0,
                  sourceCandidateMediaId: "media-b",
                },
                ...(unknownLegacyPage
                  ? [
                      {
                        id: "page-unknown",
                        orderIndex: 1,
                        sourceCandidateMediaId: null,
                      },
                    ]
                  : []),
              ],
            }
          : null,
    },
    candidateMedia: {
      findFirst: async ({
        where,
      }: {
        where: { id: string; candidatePost: { work: { id: string } } };
      }) =>
        where.id === "media-a" && where.candidatePost?.work?.id === "work"
          ? { fileObjectId: "file-a" }
          : null,
    },
  };
  const files = {
    imageUrl: async (id: string, variant: string) => ({
      url: `memory:${id}/${variant}`,
      expiresInSeconds: 60,
    }),
  };
  return new WorksService(db as never, files as never, {} as never);
}

test("work source returns all source media with exact adopted page mapping and explicit availability", async () => {
  const source = await fixture().source("work");
  assert.deepEqual(source, {
    candidateId: "candidate",
    platform: "synthetic",
    externalPostId: "post",
    sourceUrl: "https://example.test/post",
    sourceText: "later source description",
    importedSourceText: "imported description",
    media: [
      {
        id: "media-a",
        orderIndex: 0,
        width: 100,
        height: 200,
        mediaType: "photo",
        adopted: false,
        workImageId: null,
        workOrderIndex: null,
        available: true,
      },
      {
        id: "media-b",
        orderIndex: 1,
        width: 100,
        height: 200,
        mediaType: "photo",
        adopted: true,
        workImageId: "page-one",
        workOrderIndex: 0,
        available: true,
      },
      {
        id: "media-c",
        orderIndex: 2,
        width: 100,
        height: 200,
        mediaType: "photo",
        adopted: false,
        workImageId: null,
        workOrderIndex: null,
        available: false,
      },
    ],
  });
});

test("legacy missing page provenance remains unknown rather than falsely unadopted", async () => {
  const source = await fixture(true).source("work");
  assert.deepEqual(
    source.media.map(({ adopted }) => adopted),
    [null, true, null],
  );
});

test("source image URL is bound to the work's source candidate including excluded media", async () => {
  const service = fixture();
  assert.deepEqual(
    await service.sourceMediaUrl("work", "media-a", "thumbnail"),
    {
      url: "memory:file-a/thumbnail",
      expiresInSeconds: 60,
    },
  );
  await assert.rejects(
    service.sourceMediaUrl("other-work", "media-a"),
    NotFoundException,
  );
  await assert.rejects(
    service.sourceMediaUrl("work", "foreign-media"),
    NotFoundException,
  );
  await assert.rejects(service.source("missing-work"), NotFoundException);
});
