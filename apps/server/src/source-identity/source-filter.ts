import { BadRequestException } from "@nestjs/common";
import { Transform } from "class-transformer";
import { IsBoolean, IsIn, IsOptional, IsUUID } from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { Prisma } from "../generated/prisma/client.js";

export const sourcePlatforms = ["x", "pixiv", "manual"] as const;
export class SourceFilterQueryDto {
  @ApiPropertyOptional({ enum: sourcePlatforms })
  @IsOptional()
  @IsIn(sourcePlatforms)
  sourcePlatform?: (typeof sourcePlatforms)[number];

  @ApiPropertyOptional({ type: String, format: "uuid" })
  @IsOptional()
  @IsUUID()
  sourceAccountId?: string;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === "true" ? true : value === "false" ? false : value,
  )
  @IsBoolean()
  sourceUnbound?: boolean;
}

/** Omit every default: adding source filters must not change legacy cursor/session hashes. */
export function normalizeSourceFilter(input: SourceFilterQueryDto) {
  const { sourcePlatform, sourceAccountId, sourceUnbound } = input;
  if (
    (sourcePlatform !== undefined &&
      !sourcePlatforms.includes(sourcePlatform)) ||
    (sourceAccountId !== undefined &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        sourceAccountId,
      )) ||
    (sourceUnbound !== undefined && typeof sourceUnbound !== "boolean")
  )
    throw new BadRequestException("来源筛选无效");
  if (sourceAccountId && (sourcePlatform || sourceUnbound === true))
    throw new BadRequestException("具体账号不能与平台或未绑定筛选组合");
  if (sourcePlatform === "manual" && sourceUnbound === true)
    throw new BadRequestException("手动来源不能筛选未绑定账号");
  return {
    ...(sourcePlatform ? { sourcePlatform } : {}),
    ...(sourceAccountId
      ? { sourceAccountId: sourceAccountId.toLowerCase() }
      : {}),
    ...(sourceUnbound === true ? { sourceUnbound: true as const } : {}),
  };
}
export type SourceFilter = ReturnType<typeof normalizeSourceFilter>;

/** Account scope can stand alone; when an author is supplied its ownership is mandatory.
 * Deleted accounts deliberately remain queryable as historical source identities. */
export async function assertSourceFilterAccount(
  db: Pick<Prisma.TransactionClient, "authorExternalAccount">,
  filter: SourceFilter,
  authorId?: string | null,
) {
  if (!filter.sourceAccountId) return;
  const account = await db.authorExternalAccount.findUnique({
    where: { id: filter.sourceAccountId },
    select: { authorId: true },
  });
  if (!account || (authorId && account.authorId !== authorId.toLowerCase()))
    throw new BadRequestException("来源账号不属于所选作者或不存在");
}

/** One candidate row owns the whole conjunction, including Work's relation EXISTS. */
export function sourceCandidateWhere(
  filter: SourceFilter,
): Prisma.CandidatePostWhereInput {
  return {
    ...(filter.sourcePlatform ? { platform: filter.sourcePlatform } : {}),
    ...(filter.sourceAccountId
      ? { authorExternalAccountId: filter.sourceAccountId }
      : {}),
    ...(filter.sourceUnbound
      ? { authorExternalAccountId: null, NOT: { platform: "manual" } }
      : {}),
  };
}

/** The c alias is owned by candidate-query; user values stay parameterized. */
export function sourceCandidateSql(filter: SourceFilter) {
  return [
    ...(filter.sourcePlatform
      ? [Prisma.sql`c.platform = ${filter.sourcePlatform}`]
      : []),
    ...(filter.sourceAccountId
      ? [
          Prisma.sql`c.author_external_account_id = ${filter.sourceAccountId}::uuid`,
        ]
      : []),
    ...(filter.sourceUnbound
      ? [
          Prisma.sql`c.author_external_account_id IS NULL AND c.platform <> 'manual'`,
        ]
      : []),
  ];
}
