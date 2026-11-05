import { createHash } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import type { AuthorQueryDto } from "./authors.dto.js";

export type AuthorPosition = { id: string; name: string; rank: number };
const cursorError = () =>
  new BadRequestException("作者分页游标无效或筛选已改变，请刷新列表");
const like = (value: string) => value.replace(/[\\%_]/g, "\\$&");

export function authorCursor(scope: string, position: AuthorPosition) {
  return Buffer.from(JSON.stringify({ v: 1, scope, ...position })).toString(
    "base64url",
  );
}

/** SQL owns filtering/ranking/pagination. Node receives only limit + 1 positions. */
export function authorQuery(query: AuthorQueryDto) {
  const limit = query.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new BadRequestException("作者每页数量须为 1 至 100");
  const search = (query.search ?? "")
    .trim()
    .replace(/^@/, "")
    .trim()
    .toLowerCase();
  const platform = query.platform?.toLowerCase() || null;
  const tag = query.tag?.normalize("NFKC").trim().toLowerCase() || null;
  const authorization = query.authorizationStatus ?? null;
  const scope = createHash("sha256")
    .update(JSON.stringify([search, platform, tag, authorization]))
    .digest("hex");
  let cursor: AuthorPosition | undefined;
  if (query.cursor !== undefined) {
    try {
      if (!/^[A-Za-z0-9_-]{1,1000}$/.test(query.cursor)) throw cursorError();
      const json = Buffer.from(query.cursor, "base64url").toString("utf8");
      if (Buffer.from(json).toString("base64url") !== query.cursor)
        throw cursorError();
      const value: unknown = JSON.parse(json);
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw cursorError();
      const item = value as Record<string, unknown>;
      if (
        item.v !== 1 ||
        item.scope !== scope ||
        typeof item.id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          item.id,
        ) ||
        typeof item.name !== "string" ||
        !item.name.length ||
        [...item.name].length > 100 ||
        item.name.includes("\0") ||
        Buffer.from(item.name).toString("utf8") !== item.name ||
        !Number.isInteger(item.rank) ||
        Number(item.rank) < 0 ||
        Number(item.rank) > 3 ||
        (!search && item.rank !== 3)
      )
        throw cursorError();
      cursor = { id: item.id, name: item.name, rank: Number(item.rank) };
    } catch {
      throw cursorError();
    }
  }
  const account = Prisma.sql`e.author_id = a.id AND e.deleted_at IS NULL`;
  const handleMatch = (pattern: string) =>
    Prisma.sql`EXISTS (SELECT 1 FROM author_external_accounts e WHERE ${account} AND e.platform = 'x' AND lower(e.handle) LIKE ${pattern} ESCAPE chr(92))`;
  const contains = `%${like(search)}%`;
  const where = Prisma.sql`a.deleted_at IS NULL
    ${authorization ? Prisma.sql`AND a.authorization_status = ${authorization}::"AuthorizationStatus"` : Prisma.empty}
    ${platform ? Prisma.sql`AND EXISTS (SELECT 1 FROM author_external_accounts e WHERE ${account} AND e.platform = ${platform})` : Prisma.empty}
    ${tag ? Prisma.sql`AND EXISTS (SELECT 1 FROM author_tags at JOIN tags t ON t.id = at.tag_id WHERE at.author_id = a.id AND t.normalized_name = ${tag})` : Prisma.empty}
    ${search ? Prisma.sql`AND (lower(a.display_name) LIKE ${contains} ESCAPE chr(92) OR EXISTS (SELECT 1 FROM author_external_accounts e WHERE ${account} AND (lower(e.handle) LIKE ${contains} ESCAPE chr(92) OR (e.platform = 'pixiv' AND e.external_user_id LIKE ${contains} ESCAPE chr(92)))))` : Prisma.empty}`;
  const rank = search
    ? Prisma.sql`CASE WHEN ${handleMatch(like(search))} THEN 0 WHEN ${handleMatch(`${like(search)}%`)} THEN 1 WHEN ${handleMatch(contains)} THEN 2 ELSE 3 END`
    : Prisma.sql`3`;
  const page = Prisma.sql`WITH filtered AS (SELECT a.id, a.display_name AS name, ${rank} AS rank FROM authors a WHERE ${where})
    SELECT id, name, rank FROM filtered
    ${cursor ? Prisma.sql`WHERE (rank, name COLLATE "C", id) > (${cursor.rank}::int, ${cursor.name} COLLATE "C", ${cursor.id}::uuid)` : Prisma.empty}
    ORDER BY rank, name COLLATE "C", id LIMIT ${limit + 1}`;
  const count = Prisma.sql`SELECT count(*)::int AS total FROM authors a WHERE ${where}`;
  return { scope, limit, page, count };
}
