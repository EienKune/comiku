import { BadRequestException } from "@nestjs/common";
import { Prisma, type FileObject } from "../generated/prisma/client.js";
import {
  defaultLabelPlusHeader,
  encodeLabelPlus,
} from "../labelplus/labelplus-codec.js";
import {
  targetImageFileName,
  typesetTranslationFileName,
} from "../typesetting/handoff-package.js";
import { archiveBounds, archiveHash } from "./archive-common.js";
import { archiveEntryPath } from "./archive-format.js";
import type { ArchiveExportScopeDto } from "./archive-exports.dto.js";

export interface CapturedArchiveEntry {
  kind: "raw" | "rendered" | "text" | "manifest";
  path: string;
  fileObjectId: string | null;
  sourceKey: string | null;
  workImageId: string | null;
  contentText: string | null;
  size: bigint;
  checksum: string;
}
export interface CapturedArchiveWork {
  workId: string;
  workNumber: number;
  workRevision: number;
  editorEpoch: number;
  workflowStatus: string;
  reviewStatus: string;
  textSource: string;
  translationVersionId: string | null;
  typesetVersionId: string | null;
  facts: Prisma.InputJsonValue;
  issues: string[];
  entries: CapturedArchiveEntry[];
  missingRendered: boolean;
  failedText: boolean;
}
export interface ArchiveTextEvidence {
  workId: string;
  typesetHandoffStartedAt: Date | null;
  requiredHandoffVersionId: string | null;
  currentTypesetVersion: {
    workId: string;
    deletedAt: Date | null;
    reviewedTranslationVersionId: string | null;
    sourceTranslationVersionId: string | null;
  } | null;
  handoff: {
    proofreadVersionId?: unknown;
    fileId?: unknown;
    editorEpoch?: unknown;
  } | null;
}
export function archiveTextCandidates(work: ArchiveTextEvidence) {
  const pointers: { id: string; source: string }[] = [];
  const adopted = work.currentTypesetVersion;
  if (adopted && adopted.workId === work.workId && !adopted.deletedAt) {
    if (adopted.reviewedTranslationVersionId)
      pointers.push({
        id: adopted.reviewedTranslationVersionId,
        source: "rendered_reviewed",
      });
    if (adopted.sourceTranslationVersionId)
      pointers.push({
        id: adopted.sourceTranslationVersionId,
        source: "rendered_source",
      });
  }
  if (work.typesetHandoffStartedAt) {
    if (work.requiredHandoffVersionId)
      pointers.push({
        id: work.requiredHandoffVersionId,
        source: "required_handoff",
      });
    if (typeof work.handoff?.proofreadVersionId === "string")
      pointers.push({
        id: work.handoff.proofreadVersionId,
        source: "delivered_handoff",
      });
  }
  return pointers;
}
interface TextEntry {
  workImageId: string;
  orderIndex: number;
  markerX: unknown;
  markerY: unknown;
  markerPositionType: string;
  translatedText: string;
}
// The same Unicode whitespace set used by String.trim(), without retrieving a
// potentially unbounded body merely to decide whether a TXT should exist.
const nonWhitespace =
  "[^\\u0009-\\u000d \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]".replace(
    /\\u([a-f0-9]{4})/gi,
    (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)),
  );
export function encodeArchiveText(
  workNumber: number,
  images: { id: string; originalFileObject: { contentType: string } }[],
  entries: TextEntry[],
) {
  if (!entries.some((entry) => entry.translatedText.trim().length)) return null;
  const imageIds = new Set(images.map((image) => image.id));
  if (entries.some((entry) => !imageIds.has(entry.workImageId)))
    throw new Error("text_image_mismatch");
  return Buffer.from(
    encodeLabelPlus({
      formatVersion: "1,0",
      headerLines: [...defaultLabelPlusHeader],
      images: images.map((image, index) => ({
        fileName: targetImageFileName(
          workNumber,
          index,
          image.originalFileObject.contentType,
        ),
        markers: entries
          .filter((e) => e.workImageId === image.id)
          .sort((a, b) => a.orderIndex - b.orderIndex)
          .map((e) => ({
            x: Number(e.markerX),
            y: Number(e.markerY),
            positionType: e.markerPositionType === "inside" ? 1 : 2,
            translation: e.translatedText,
          })),
      })),
    }),
  );
}

export interface ArchiveWorkCursor {
  createdAt: Date;
  id: string;
}
/** A tuple is an index range, including when thousands of imports share a millisecond. */
export function archiveWorkPageQuery(
  scope: ArchiveExportScopeDto,
  month: number,
  cursor?: ArchiveWorkCursor,
) {
  const bounds = archiveBounds(scope.year, month);
  return Prisma.sql`SELECT id,created_at AS "createdAt" FROM works
    WHERE created_at >= ${bounds.gte} AND created_at < ${bounds.lt}
      ${cursor ? Prisma.sql`AND (created_at,id) > (${cursor.createdAt}::timestamptz,${cursor.id}::uuid)` : Prisma.empty}
      ${!scope.includeArchived ? Prisma.sql`AND workflow_status <> 'archived'` : Prisma.empty}
      ${!scope.includeDiscarded ? Prisma.sql`AND discarded_review_case_id IS NULL` : Prisma.empty}
    ORDER BY created_at ASC,id ASC LIMIT 20`;
}

/** One repeatable-read month transaction; content is materialized at most twenty works at a time. */
export async function visitArchiveMonth(
  tx: Prisma.TransactionClient,
  scope: ArchiveExportScopeDto,
  month: number,
  visitor: (work: CapturedArchiveWork) => Promise<void>,
) {
  let cursor: ArchiveWorkCursor | undefined;
  let workCount = 0;
  for (;;) {
    const keys = await tx.$queryRaw<ArchiveWorkCursor[]>(
      archiveWorkPageQuery(scope, month, cursor),
    );
    if (!keys.length) return;
    const headers = await tx.work.findMany({
      where: { id: { in: keys.map((key) => key.id) } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 20,
      select: {
        id: true,
        createdAt: true,
        _count: { select: { images: true } },
        currentTypesetVersion: {
          select: { _count: { select: { images: true } } },
        },
      },
    });
    if (!headers.length) return;
    const selected: string[] = [];
    let metadataEntries = 0;
    for (const header of headers) {
      const rawCount = header._count.images;
      const renderedCount = header.currentTypesetVersion?._count.images ?? 0;
      if (rawCount > 20_000 || renderedCount > 20_000)
        throw new BadRequestException("单作品图片数量超过归档捕获预算");
      if (
        metadataEntries + rawCount + renderedCount > 40_000 &&
        selected.length
      )
        break;
      metadataEntries += rawCount + renderedCount;
      selected.push(header.id);
    }
    const works = await tx.work.findMany({
      where: { id: { in: selected } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 20,
      include: {
        author: { select: { displayName: true } },
        images: {
          orderBy: { orderIndex: "asc" },
          include: { originalFileObject: true },
        },
        currentTypesetVersion: {
          include: {
            images: {
              orderBy: { orderIndex: "asc" },
              include: { fileObject: true },
            },
          },
        },
      },
    });
    if (!works.length) return;
    workCount += works.length;
    if (workCount > 10_000)
      throw new BadRequestException("单月作品数量超过归档捕获预算");
    const ids = Prisma.join(works.map((w) => Prisma.sql`${w.id}::uuid`));
    const handoffs = await tx.$queryRaw<
      { work_id: string; detail: Prisma.JsonValue }[]
    >(Prisma.sql`
      SELECT w.id AS work_id, e.detail FROM works w JOIN LATERAL (
        SELECT detail FROM work_events WHERE work_id=w.id AND action='typeset_handoff_started'
          AND detail->>'operation'='typeset-handoff-start'
          AND jsonb_typeof(detail->'editorEpoch')='number'
          AND (detail->>'editorEpoch')::numeric=w.editor_epoch
          ORDER BY created_at DESC, id DESC LIMIT 1
      ) e ON true WHERE w.id IN (${ids}) AND w.typeset_handoff_started_at IS NOT NULL`);
    const handoffMap = new Map(
      handoffs.map((h) => [
        h.work_id,
        h.detail && typeof h.detail === "object" && !Array.isArray(h.detail)
          ? h.detail
          : null,
      ]),
    );
    const candidates = new Map(
      works.map((w) => [
        w.id,
        archiveTextCandidates({
          ...w,
          workId: w.id,
          handoff: handoffMap.get(w.id) ?? null,
        }),
      ]),
    );
    // Older download receipts may bind the delivered package rather than an
    // explicit proofread pointer. Only the current epoch's event qualifies it.
    const deliveredPackageIds = [...handoffMap.values()].flatMap((h) =>
      typeof h?.fileId === "string" &&
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(h.fileId)
        ? [h.fileId]
        : [],
    );
    const deliveredPackages = deliveredPackageIds.length
      ? await tx.typesetHandoffPackage.findMany({
          where: { id: { in: deliveredPackageIds } },
          select: { id: true, workId: true, translationVersionId: true },
        })
      : [];
    for (const work of works) {
      const h = handoffMap.get(work.id);
      const pkg = deliveredPackages.find(
        (p) => p.id === h?.fileId && p.workId === work.id,
      );
      if (work.typesetHandoffStartedAt && pkg?.translationVersionId)
        candidates
          .get(work.id)!
          .push({ id: pkg.translationVersionId, source: "delivered_package" });
    }
    const versionIds = [
      ...new Set([...candidates.values()].flat().map((c) => c.id)),
    ].filter((id) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id));
    const versions = versionIds.length
      ? await tx.translationVersion.findMany({
          where: { id: { in: versionIds } },
          select: { id: true, workId: true, versionNumber: true, kind: true },
        })
      : [];
    for (const work of works) {
      const issues: string[] = [];
      const entries: CapturedArchiveEntry[] = [];
      const adopted =
        work.currentTypesetVersion &&
        work.currentTypesetVersion.workId === work.id &&
        !work.currentTypesetVersion.deletedAt
          ? work.currentTypesetVersion
          : null;
      const choices = candidates.get(work.id)!;
      const choice = choices.find((c) =>
        versions.some((v) => v.id === c.id && v.workId === work.id),
      );
      if (choices.length && choice?.id !== choices[0].id)
        issues.push("text_binding_invalid");
      if (work.currentTypesetVersion && !adopted)
        issues.push("rendered_binding_invalid");
      const missingRendered =
        scope.content !== "raw" && (!adopted || !adopted.images.length);
      if (missingRendered) issues.push("missing_rendered");
      const addFile = (
        file: FileObject,
        kind: "raw" | "rendered",
        index: number,
        workImageId: string | null,
      ) => {
        entries.push({
          kind,
          path: archiveEntryPath(
            scope.year,
            month,
            work.workNumber,
            kind,
            targetImageFileName(
              work.workNumber,
              index,
              file.contentType,
              kind === "rendered",
            ),
          ),
          fileObjectId: file.id,
          sourceKey: file.objectKey,
          workImageId,
          contentText: null,
          size: file.size,
          checksum: file.checksum,
        });
      };
      if (scope.content !== "rendered")
        work.images.forEach((image, index) =>
          addFile(image.originalFileObject, "raw", index, image.id),
        );
      if (scope.content !== "raw" && adopted)
        adopted.images.forEach((image, index) =>
          addFile(image.fileObject, "rendered", index, image.workImageId),
        );
      let textSource = choice?.source ?? "current_saved";
      let failedText = false;
      if (scope.content !== "rendered") {
        // Aggregate before fetching text, including UTF-8 octets: a malformed or
        // huge source must become a visible TXT failure without loading its body.
        const aggregate = choice
          ? await tx.$queryRaw<
              {
                count: bigint;
                bytes: bigint;
                longest: number;
                nonempty: boolean;
              }[]
            >`SELECT count(*) AS count, COALESCE(sum(octet_length(translated_text)),0)::bigint AS bytes, COALESCE(max(length(translated_text)),0)::int AS longest, COALESCE(bool_or(translated_text ~ ${nonWhitespace}),false) AS nonempty FROM translation_version_entries WHERE version_id=${choice.id}::uuid`
          : await tx.$queryRaw<
              {
                count: bigint;
                bytes: bigint;
                longest: number;
                nonempty: boolean;
              }[]
            >`SELECT count(*) AS count, COALESCE(sum(octet_length(e.translated_text)),0)::bigint AS bytes, COALESCE(max(length(e.translated_text)),0)::int AS longest, COALESCE(bool_or(e.translated_text ~ ${nonWhitespace}),false) AS nonempty FROM translation_entries e JOIN work_images i ON i.id=e.work_image_id WHERE i.work_id=${work.id}::uuid`;
        const stats = aggregate[0];
        if (stats?.nonempty) {
          if (!choice)
            issues.push(
              work.typesetHandoffStartedAt || adopted
                ? "text_binding_unverified"
                : "text_draft",
            );
          try {
            if (
              stats.count > 20_000n ||
              stats.bytes > 2n * 1024n * 1024n ||
              stats.longest > 100_000 ||
              work.images.length > 2_000
            )
              throw new Error("text_budget");
            const textEntries = choice
              ? await tx.translationVersionEntry.findMany({
                  where: { versionId: choice.id },
                  select: {
                    workImageId: true,
                    orderIndex: true,
                    markerX: true,
                    markerY: true,
                    markerPositionType: true,
                    translatedText: true,
                  },
                })
              : await tx.translationEntry.findMany({
                  where: { workImage: { workId: work.id } },
                  select: {
                    workImageId: true,
                    orderIndex: true,
                    markerX: true,
                    markerY: true,
                    markerPositionType: true,
                    translatedText: true,
                  },
                });
            const encoded = encodeArchiveText(
              work.workNumber,
              work.images,
              textEntries,
            );
            if (encoded)
              entries.push({
                kind: "text",
                path: archiveEntryPath(
                  scope.year,
                  month,
                  work.workNumber,
                  "raw",
                  typesetTranslationFileName(work.workNumber),
                ),
                fileObjectId: null,
                sourceKey: null,
                workImageId: null,
                contentText: encoded.toString("utf8"),
                size: BigInt(encoded.length),
                checksum: archiveHash(encoded),
              });
          } catch {
            issues.push("text_encoding_failed");
            failedText = true;
          }
        } else textSource += "_empty";
      }
      const facts = {
        title: work.title,
        author: work.author.displayName,
        createdAt: work.createdAt.toISOString(),
        discarded: work.discardedReviewCaseId !== null,
        capturedImageIds: work.images.map((i) => i.id),
        translationVersionNumber:
          versions.find((v) => v.id === choice?.id)?.versionNumber ?? null,
      };
      const manifest = JSON.stringify(
        {
          formatVersion: 1,
          workId: work.id,
          workNumber: work.workNumber,
          year: scope.year,
          month,
          ...facts,
          workRevision: work.revision,
          editorEpoch: work.editorEpoch,
          workflowStatus: work.workflowStatus,
          reviewStatus: work.reviewStatus,
          textSource,
          translationVersionId: choice?.id ?? null,
          typesetVersionId: adopted?.id ?? null,
          issues: [...new Set(issues)],
          files: entries.map((e) => ({
            path: e.path,
            kind: e.kind,
            workImageId: e.workImageId,
            size: String(e.size),
            sha256: e.checksum,
          })),
        },
        null,
        2,
      );
      entries.sort(
        (a, b) => Number(b.kind === "text") - Number(a.kind === "text"),
      );
      entries.unshift({
        kind: "manifest",
        path: archiveEntryPath(
          scope.year,
          month,
          work.workNumber,
          "manifest",
          "作品清单.json",
        ),
        fileObjectId: null,
        sourceKey: null,
        workImageId: null,
        contentText: manifest,
        size: BigInt(Buffer.byteLength(manifest)),
        checksum: archiveHash(manifest),
      });
      await visitor({
        workId: work.id,
        workNumber: work.workNumber,
        workRevision: work.revision,
        editorEpoch: work.editorEpoch,
        workflowStatus: work.workflowStatus,
        reviewStatus: work.reviewStatus,
        textSource,
        translationVersionId: choice?.id ?? null,
        typesetVersionId: adopted?.id ?? null,
        facts,
        issues: [...new Set(issues)],
        entries,
        missingRendered,
        failedText,
      });
    }
    cursor = { id: works.at(-1)!.id, createdAt: works.at(-1)!.createdAt };
  }
}
