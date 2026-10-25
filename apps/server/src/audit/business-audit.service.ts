import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../database/prisma.service.js";
import type {
  BusinessAuditPageDto,
  BusinessAuditQueryDto,
} from "./business-audit.dto.js";
import {
  businessEventScope,
  hasGlobalBusinessAudit,
} from "./business-audit.scope.js";

@Injectable()
export class BusinessAuditService {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}

  async list(
    actorId: string,
    query: BusinessAuditQueryDto,
  ): Promise<BusinessAuditPageDto> {
    const user = await this.db.user.findUniqueOrThrow({
      where: { id: actorId },
      select: { roles: { select: { role: true } } },
    });
    const roles = user.roles.map(({ role }) => role);
    const filters: Prisma.WorkEventWhereInput[] = [
      businessEventScope(actorId, roles),
    ];
    if (query.action) filters.push({ action: query.action });
    if (query.days) {
      filters.push({
        createdAt: {
          gte: new Date(Date.now() - query.days * 24 * 60 * 60 * 1000),
        },
      });
    }
    if (query.search) {
      filters.push({
        OR: [
          {
            work: {
              title: { contains: query.search, mode: "insensitive" },
            },
          },
          {
            work: {
              author: {
                displayName: { contains: query.search, mode: "insensitive" },
              },
            },
          },
          {
            actor: {
              displayName: { contains: query.search, mode: "insensitive" },
            },
          },
        ],
      });
    }
    const where: Prisma.WorkEventWhereInput = { AND: filters };
    const [total, events] = await Promise.all([
      this.db.workEvent.count({ where }),
      this.db.workEvent.findMany({
        where,
        include: {
          actor: { select: { displayName: true } },
          work: {
            select: {
              title: true,
              workNumber: true,
              author: { select: { displayName: true } },
            },
          },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      }),
    ]);
    const hasMore = events.length > query.limit;
    const items = hasMore ? events.slice(0, query.limit) : events;
    return {
      scope: hasGlobalBusinessAudit(roles) ? "global" : "related",
      total,
      nextCursor: hasMore ? items.at(-1)!.id : null,
      items: items.map((event) => ({
        id: event.id,
        workId: event.workId,
        workTitle: event.work.title ?? `#${event.work.workNumber} · 待定标题`,
        authorName: event.work.author.displayName,
        action: event.action,
        actorId: event.actorId,
        actorName: event.actor?.displayName ?? null,
        fromWorkflowStatus: event.fromWorkflowStatus,
        toWorkflowStatus: event.toWorkflowStatus,
        fromReviewStatus: event.fromReviewStatus,
        toReviewStatus: event.toReviewStatus,
        detail:
          event.detail &&
          typeof event.detail === "object" &&
          !Array.isArray(event.detail)
            ? (event.detail as object)
            : {},
        createdAt: event.createdAt.toISOString(),
      })),
    };
  }
}
