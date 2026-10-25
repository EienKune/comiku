import { Prisma, Role } from "../generated/prisma/client.js";

export function hasGlobalBusinessAudit(roles: Role[]) {
  return roles.includes(Role.admin) || roles.includes(Role.reviewer);
}

export function businessEventScope(
  actorId: string,
  roles: Role[],
): Prisma.WorkEventWhereInput {
  if (hasGlobalBusinessAudit(roles)) return {};
  return {
    OR: [
      { actorId },
      { work: { importedById: actorId } },
      { work: { stageParticipants: { some: { userId: actorId } } } },
    ],
  };
}
