import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { permissionsFor } from "../common/access.js";
import { PrismaService } from "../database/prisma.service.js";
import { Prisma } from "../generated/prisma/client.js";
import type {
  ContributionAchievementDto,
  ContributionCountsDto,
  ContributionDetailsDto,
  ContributionDetailsQueryDto,
  ContributionQueryDto,
  ContributionSummaryDto,
} from "./contributions.dto.js";

/** Local month boundaries are explicit UTC instants, independent of the host timezone. */
export function shanghaiMonth(now: Date) {
  const local = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const year = local.getUTCFullYear(),
    month = local.getUTCMonth();
  return {
    month: `${year}-${String(month + 1).padStart(2, "0")}`,
    start: new Date(Date.UTC(year, month, 1, -8)),
    end: new Date(Date.UTC(year, month + 1, 1, -8)),
  };
}

export function contributionAchievements(
  counts: ContributionCountsDto,
  collaborative: boolean,
): ContributionAchievementDto[] {
  const result: ContributionAchievementDto[] = [];
  const add = (
    id: string,
    name: string,
    condition: string,
    progress: number,
    target: number,
  ) =>
    result.push({
      id,
      name,
      condition,
      progress,
      target,
      achieved: progress >= target,
    });
  add(
    "first",
    "首次交付",
    "完成任意一项制作职责",
    counts.translate + counts.proofread + counts.typeset > 0 ? 1 : 0,
    1,
  );
  for (const [stage, label] of [
    ["translate", "翻译"],
    ["proofread", "校对"],
    ["typeset", "嵌字"],
  ] as const)
    for (const target of [1, 10, 30])
      add(
        `${stage}-${target}`,
        `${label} ${target} 部`,
        `累计有效${label}交付 ${target} 部`,
        counts[stage],
        target,
      );
  add(
    "versatile",
    "多面手",
    "至少两种制作职责各完成一次",
    [counts.translate, counts.proofread, counts.typeset].filter(
      (count) => count > 0,
    ).length,
    2,
  );
  add(
    "collaboration",
    "协作完成",
    "与另一位正式记名者完成同一作品、同一阶段的同一次交付",
    collaborative ? 1 : 0,
    1,
  );
  return result;
}

/** submitted_at is the workflow's current formal credit: cancellation clears it,
 * and uncredited submit actors keep it null. Events/pages are immutable audit,
 * not additional deliveries. Historic credits survive leaving and archiving. */
function contributionCte(userId: string | null) {
  const owner = userId
    ? Prisma.sql`AND p.user_id = ${userId}::uuid`
    : Prisma.empty;
  return Prisma.sql`WITH completed AS (
    SELECT DISTINCT ON (p.user_id, p.work_id, p.stage)
      p.user_id, p.work_id, p.stage, p.submitted_at AS completed_at
    FROM work_stage_participants p
    WHERE p.submitted_at IS NOT NULL AND p.stage IN ('translate', 'proofread', 'typeset') ${owner}
    ORDER BY p.user_id, p.work_id, p.stage, p.submitted_at DESC, p.id DESC
  ), collaborative_rounds AS (
    SELECT p.work_id, p.stage, p.submitted_at
    FROM work_stage_participants p
    JOIN (SELECT DISTINCT work_id, stage, completed_at FROM completed) c
      ON c.work_id = p.work_id AND c.stage = p.stage AND c.completed_at = p.submitted_at
    GROUP BY p.work_id, p.stage, p.submitted_at HAVING COUNT(DISTINCT p.user_id) >= 2
  ), current_tasks AS (
    SELECT p.user_id, p.work_id, p.stage, MIN(p.joined_at) AS joined_at
    FROM work_stage_participants p
    WHERE p.submitted_at IS NULL AND p.left_at IS NULL AND p.stage IN ('translate', 'proofread', 'typeset') ${owner}
    GROUP BY p.user_id, p.work_id, p.stage
  ), publications AS (
    SELECT work_id, MIN(published_at) AS published_at FROM publish_records GROUP BY work_id
  )`;
}

@Injectable()
export class ContributionsService {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}

  private async authorize(actorId: string, query: ContributionQueryDto) {
    const actor = await this.db.user.findUnique({
      where: { id: actorId },
      select: { isActive: true, mustChangePassword: true, roles: true },
    });
    if (!actor?.isActive || actor.mustChangePassword)
      throw new ForbiddenException("当前账号不能查看贡献统计");
    const permissions = permissionsFor(
      actor.roles.map(({ role }) => role),
      false,
    );
    if (!permissions.includes("works:read"))
      throw new ForbiddenException("当前账号没有作品访问权限");
    if (query.scope === "team" && query.userId)
      throw new BadRequestException("全组统计不能同时指定成员");
    if (
      (query.scope === "team" || (query.userId && query.userId !== actorId)) &&
      !permissions.includes("accounts:manage")
    )
      throw new ForbiddenException("全组及其他成员统计仅向管理员开放");
    const userId = query.scope === "team" ? null : (query.userId ?? actorId);
    if (
      userId &&
      userId !== actorId &&
      !(await this.db.user.findUnique({
        where: { id: userId },
        select: { id: true },
      }))
    )
      throw new NotFoundException("成员不存在");
    return userId;
  }

  async summary(
    actorId: string,
    query: ContributionQueryDto,
    now = new Date(),
  ): Promise<ContributionSummaryDto> {
    const userId = await this.authorize(actorId, query);
    const month = shanghaiMonth(now);
    const period =
      query.period === "all"
        ? Prisma.sql`TRUE`
        : Prisma.sql`c.completed_at >= ${month.start} AND c.completed_at < ${month.end}`;
    const publicationPeriod =
      query.period === "all"
        ? Prisma.sql`TRUE`
        : Prisma.sql`p.published_at >= ${month.start} AND p.published_at < ${month.end}`;
    type Counts = ContributionCountsDto & {
      lifetimeTranslate: number;
      lifetimeProofread: number;
      lifetimeTypeset: number;
      collaborative: boolean;
    };
    const [counts] = await this.db.$queryRaw<
      Counts[]
    >(Prisma.sql`${contributionCte(userId)}
      SELECT COUNT(*) FILTER (WHERE c.stage = 'translate' AND ${period})::int AS translate,
        COUNT(*) FILTER (WHERE c.stage = 'proofread' AND ${period})::int AS proofread,
        COUNT(*) FILTER (WHERE c.stage = 'typeset' AND ${period})::int AS typeset,
        COUNT(DISTINCT c.work_id) FILTER (WHERE ${period})::int AS works,
        (SELECT COUNT(DISTINCT c.work_id)::int FROM completed c JOIN publications p ON p.work_id = c.work_id WHERE ${publicationPeriod}) AS published,
        (SELECT COUNT(*)::int FROM current_tasks) AS tasks,
        COUNT(*) FILTER (WHERE c.stage = 'translate')::int AS "lifetimeTranslate",
        COUNT(*) FILTER (WHERE c.stage = 'proofread')::int AS "lifetimeProofread",
        COUNT(*) FILTER (WHERE c.stage = 'typeset')::int AS "lifetimeTypeset",
        ${userId ? Prisma.sql`EXISTS (SELECT 1 FROM collaborative_rounds)` : Prisma.sql`FALSE`} AS collaborative FROM completed c`);
    const {
      lifetimeTranslate,
      lifetimeProofread,
      lifetimeTypeset,
      collaborative,
      ...selected
    } = counts;
    return {
      period: query.period,
      scope: query.scope,
      userId,
      month: month.month,
      timezone: "Asia/Shanghai",
      counts: selected,
      achievements: userId
        ? contributionAchievements(
            {
              ...selected,
              translate: lifetimeTranslate,
              proofread: lifetimeProofread,
              typeset: lifetimeTypeset,
            },
            collaborative,
          )
        : [],
    };
  }

  async details(
    actorId: string,
    query: ContributionDetailsQueryDto,
    now = new Date(),
  ): Promise<ContributionDetailsDto> {
    const userId = await this.authorize(actorId, query);
    const month = shanghaiMonth(now);
    const tasks = query.metric === "tasks";
    const grouped = query.metric === "works" || query.metric === "published";
    const period =
      tasks || query.period === "all"
        ? Prisma.sql`TRUE`
        : query.metric === "published"
          ? Prisma.sql`p.published_at >= ${month.start} AND p.published_at < ${month.end}`
          : Prisma.sql`c.completed_at >= ${month.start} AND c.completed_at < ${month.end}`;
    const metric =
      grouped || tasks
        ? Prisma.empty
        : Prisma.sql`AND c.stage = ${query.metric}::"WorkStage"`;
    const [result] = await this.db.$queryRaw<
      { total: number; items: ContributionDetailsDto["items"] }[]
    >(Prisma.sql`${contributionCte(userId)}, selected AS (
      SELECT ${grouped ? Prisma.sql`c.work_id::text` : Prisma.sql`c.user_id::text || ':' || c.work_id::text || ':' || c.stage::text`} AS id,
        c.work_id, ${grouped ? Prisma.sql`NULL::uuid` : Prisma.sql`c.user_id`} AS user_id,
        ${grouped ? Prisma.sql`NULL::"WorkStage"` : Prisma.sql`c.stage`} AS stage,
        MAX(${tasks ? Prisma.sql`c.joined_at` : query.metric === "published" ? Prisma.sql`p.published_at` : Prisma.sql`c.completed_at`}) AS sort_at
      FROM ${tasks ? Prisma.sql`current_tasks` : Prisma.sql`completed`} c
      ${query.metric === "published" ? Prisma.sql`JOIN publications p ON p.work_id = c.work_id` : Prisma.empty}
      WHERE ${period} ${metric}
      GROUP BY c.work_id ${grouped ? Prisma.empty : Prisma.sql`, c.user_id, c.stage`}
    ), page AS (
      SELECT * FROM selected ORDER BY sort_at DESC, id DESC LIMIT ${query.limit} OFFSET ${query.offset}
    ), page_credits AS (
      SELECT page.id, jsonb_agg(jsonb_build_object('userId', c.user_id, 'displayName', u.display_name,
        'stage', c.stage, 'completedAt', ${tasks ? Prisma.sql`NULL` : Prisma.sql`c.completed_at`}) ORDER BY c.stage, c.user_id) AS credits
      FROM page JOIN ${tasks ? Prisma.sql`current_tasks` : Prisma.sql`completed`} c
        ON c.work_id = page.work_id ${grouped ? Prisma.empty : Prisma.sql`AND c.user_id = page.user_id AND c.stage = page.stage`}
      JOIN users u ON u.id = c.user_id
      ${query.metric === "works" ? Prisma.sql`WHERE ${period}` : Prisma.empty}
      GROUP BY page.id
    ) SELECT (SELECT COUNT(*)::int FROM selected) AS total,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', page.id, 'workId', w.id, 'workNumber', w.work_number, 'title', w.title,
        'workflowStatus', w.workflow_status, 'publishedAt', p.published_at,
        'contributions', page_credits.credits
        ) ORDER BY page.sort_at DESC, page.id DESC)
        FROM page JOIN works w ON w.id = page.work_id JOIN page_credits ON page_credits.id = page.id
        LEFT JOIN publications p ON p.work_id = w.id), '[]'::jsonb) AS items`);
    return { ...result, offset: query.offset, limit: query.limit };
  }
}
