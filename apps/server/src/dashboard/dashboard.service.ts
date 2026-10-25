import { Inject, Injectable } from "@nestjs/common";
import { permissionsFor } from "../common/access.js";
import { businessEventScope } from "../audit/business-audit.scope.js";
import { PrismaService } from "../database/prisma.service.js";
import { ReviewStatus, WorkflowStatus } from "../generated/prisma/client.js";
import type { DashboardSummaryDto } from "./dashboard.dto.js";

@Injectable()
export class DashboardService {
  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}

  async summary(actorId: string): Promise<DashboardSummaryDto> {
    const user = await this.db.user.findUniqueOrThrow({
      where: { id: actorId },
      select: { roles: { select: { role: true } } },
    });
    const roles = user.roles.map(({ role }) => role);
    const [
      workflowGroups,
      myWorkflowGroups,
      reviewGroups,
      participating,
      activity,
    ] = await Promise.all([
      this.db.work.groupBy({
        by: ["workflowStatus"],
        _count: { _all: true },
      }),
      this.db.work.groupBy({
        by: ["workflowStatus"],
        where: { stageParticipants: { some: { userId: actorId } } },
        _count: { _all: true },
      }),
      this.db.work.groupBy({ by: ["reviewStatus"], _count: { _all: true } }),
      this.db.workStageParticipant.findMany({
        where: { userId: actorId },
        distinct: ["workId"],
        select: { workId: true },
      }),
      this.db.workEvent.findMany({
        where: businessEventScope(actorId, roles),
        include: {
          work: { select: { title: true, workNumber: true } },
          actor: { select: { displayName: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 10,
      }),
    ]);
    const permissions = permissionsFor(roles, false);
    const pendingCandidates = permissions.includes("candidates:read")
      ? await this.db.candidatePost.count({ where: { status: "pending" } })
      : null;
    const workflowMap = new Map(
      workflowGroups.map((item) => [item.workflowStatus, item._count._all]),
    );
    const reviewMap = new Map(
      reviewGroups.map((item) => [item.reviewStatus, item._count._all]),
    );
    const myWorkflowMap = new Map(
      myWorkflowGroups.map((item) => [item.workflowStatus, item._count._all]),
    );
    return {
      totalWorks: workflowGroups.reduce(
        (total, item) => total + item._count._all,
        0,
      ),
      workflowCounts: Object.values(WorkflowStatus).map((status) => ({
        status,
        count: workflowMap.get(status) ?? 0,
      })),
      myWorkflowCounts: Object.values(WorkflowStatus).map((status) => ({
        status,
        count: myWorkflowMap.get(status) ?? 0,
      })),
      reviewCounts: Object.values(ReviewStatus).map((status) => ({
        status,
        count: reviewMap.get(status) ?? 0,
      })),
      pendingCandidates,
      myParticipatingWorks: participating.length,
      recentActivity: activity.map((event) => ({
        id: event.id,
        workId: event.workId,
        workTitle: event.work.title ?? `#${event.work.workNumber} · 待定标题`,
        action: event.action,
        actorName: event.actor?.displayName ?? null,
        createdAt: event.createdAt.toISOString(),
      })),
    };
  }
}
