import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../database/prisma.service.js";
import {
  escapeLike,
  normalizeReferenceQuery,
  normalizeSearchKey,
} from "./normalization.js";
import type {
  ReferenceDictionaryEntryDto,
  ReferenceDictionaryPageDto,
} from "./reference-dictionary.dto.js";

type SearchRow = Omit<ReferenceDictionaryEntryDto, "source"> & {
  sourceKey: string;
  sourceName: string;
  sourceVersion: string;
  sourceUrl: string | null;
  attribution: string | null;
  license: string | null;
};

export function referenceSearchQuery(q: string, offset: number): Prisma.Sql {
  const normalized = normalizeSearchKey(q);
  const originalPattern = `%${escapeLike(q)}%`;
  const normalizedPattern = `%${escapeLike(normalized)}%`;
  return Prisma.sql`
    SELECT e.id, e.original, e.explanation_zh AS "explanationZh", e.explanation_ja AS "explanationJa",
      e.translation_zh AS "translationZh", e.notes, e.source_ref AS "sourceRef",
      s.key AS "sourceKey", s.name AS "sourceName", s.version AS "sourceVersion", s.source_url AS "sourceUrl", s.attribution, s.license
    FROM onomatopoeia_entries e JOIN onomatopoeia_sources s ON s.id = e.source_id
    WHERE e.original LIKE ${originalPattern} ESCAPE '\\' OR e.search_key LIKE ${normalizedPattern} ESCAPE '\\'
      OR e.explanation_zh LIKE ${originalPattern} ESCAPE '\\' OR e.explanation_ja LIKE ${originalPattern} ESCAPE '\\'
      OR e.translation_zh LIKE ${originalPattern} ESCAPE '\\' OR e.notes LIKE ${originalPattern} ESCAPE '\\'
    ORDER BY CASE WHEN e.original = ${q} THEN 0 WHEN e.search_key = ${normalized} THEN 1 ELSE 2 END,
      CASE WHEN e.explanation_zh IS NOT NULL OR e.translation_zh IS NOT NULL THEN 0 ELSE 1 END,
      e.original COLLATE "C", s.key COLLATE "C", e.source_ref COLLATE "C", e.id
    LIMIT ${21} OFFSET ${offset}`;
}

@Injectable()
export class ReferenceDictionaryService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}
  async search(
    qInput: unknown,
    offsetInput: unknown,
  ): Promise<ReferenceDictionaryPageDto> {
    const { q, offset } = normalizeReferenceQuery(qInput, offsetInput);
    if (!q || !normalizeSearchKey(q)) return { entries: [], nextOffset: null };
    const rows = await this.prisma.$queryRaw<SearchRow[]>(
      referenceSearchQuery(q, offset),
    );
    return {
      entries: rows
        .slice(0, 20)
        .map(
          ({
            sourceKey,
            sourceName,
            sourceVersion,
            sourceUrl,
            attribution,
            license,
            ...entry
          }) => ({
            ...entry,
            source: {
              key: sourceKey,
              name: sourceName,
              version: sourceVersion,
              sourceUrl,
              attribution,
              license,
            },
          }),
        ),
      nextOffset: rows.length > 20 && offset + 20 <= 10000 ? offset + 20 : null,
    };
  }
}
