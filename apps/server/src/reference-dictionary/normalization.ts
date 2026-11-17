import { BadRequestException } from "@nestjs/common";
import { hasInvalidTextCharacters } from "./text-validation.js";

export function normalizeSearchKey(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/[\u30a1-\u30f6]/g, (kana) =>
      String.fromCharCode(kana.charCodeAt(0) - 0x60),
    );
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function normalizeReferenceQuery(
  q: unknown,
  offset: unknown,
): { q: string; offset: number } {
  if (q === undefined) q = "";
  if (
    typeof q !== "string" ||
    Array.from(q).length > 80 ||
    hasInvalidTextCharacters(q.trim())
  )
    throw new BadRequestException("词典查询需为最多80个字符的文本");
  if (offset === undefined) offset = "0";
  if (
    (typeof offset !== "string" && typeof offset !== "number") ||
    !/^\d+$/.test(String(offset)) ||
    !Number.isSafeInteger(Number(offset)) ||
    Number(offset) > 10000
  )
    throw new BadRequestException("词典分页位置无效");
  return { q: q.trim(), offset: Number(offset) };
}
