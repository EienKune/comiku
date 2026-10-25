import {
  LanguageCapability,
  Role,
  SourceLanguage,
  WorkStage,
  WorkflowStatus,
} from "../generated/prisma/client.js";
import { permissionsFor, type Permission } from "../common/access.js";

export interface StageTransition {
  pending: WorkflowStatus;
  active: WorkflowStatus;
  next: WorkflowStatus;
  permission: Permission;
}

export const coordinatedWorkStages = [
  WorkStage.translate,
  WorkStage.proofread,
  WorkStage.typeset,
] as const;

export function isCoordinatedWorkStage(
  stage: WorkStage,
): stage is (typeof coordinatedWorkStages)[number] {
  return coordinatedWorkStages.includes(
    stage as (typeof coordinatedWorkStages)[number],
  );
}

export const stageTransitions: Record<WorkStage, StageTransition> = {
  translate: {
    pending: WorkflowStatus.pending_translate,
    active: WorkflowStatus.translating,
    next: WorkflowStatus.pending_proofread,
    permission: "works:translate",
  },
  proofread: {
    pending: WorkflowStatus.pending_proofread,
    active: WorkflowStatus.proofreading,
    next: WorkflowStatus.pending_typeset,
    permission: "works:proofread",
  },
  typeset: {
    pending: WorkflowStatus.pending_typeset,
    active: WorkflowStatus.typesetting,
    next: WorkflowStatus.pending_publish,
    permission: "works:typeset",
  },
  publish: {
    pending: WorkflowStatus.pending_publish,
    active: WorkflowStatus.pending_publish,
    next: WorkflowStatus.published,
    permission: "works:publish",
  },
};

export function canSubmitWorkStage(stage: WorkStage, status: WorkflowStatus) {
  const transition = stageTransitions[stage];
  return (
    status === transition.active ||
    (stage === WorkStage.proofread && status === transition.pending)
  );
}

export function canWorkStage(roles: Role[], stage: WorkStage): boolean {
  return permissionsFor(roles, false).includes(
    stageTransitions[stage].permission,
  );
}

export function canUserWorkStage(
  roles: Role[],
  languageCapabilities: LanguageCapability[],
  stage: WorkStage,
  sourceLanguage: SourceLanguage,
): boolean {
  // Management access never substitutes for a coordinated work role.
  const workRoles = isCoordinatedWorkStage(stage)
    ? roles.filter((role) => role !== Role.admin)
    : roles;
  const roleSet = new Set(workRoles);
  const baseRole =
    stage === WorkStage.translate
      ? sourceLanguage === SourceLanguage.en
        ? roleSet.has(Role.translator) || roleSet.has(Role.typesetter)
        : roleSet.has(Role.translator)
      : stage === WorkStage.proofread
        ? roleSet.has(Role.proofreader)
        : canWorkStage(workRoles, stage);
  if (!baseRole) return false;
  if (stage !== WorkStage.translate && stage !== WorkStage.proofread)
    return true;
  if (sourceLanguage === SourceLanguage.en) return true;
  return languageCapabilities.includes(sourceLanguage as LanguageCapability);
}

export function claimableWorkStatuses(stage: WorkStage): WorkflowStatus[] {
  if (!isCoordinatedWorkStage(stage)) return [];
  return coordinatedWorkStages
    .slice(0, coordinatedWorkStages.indexOf(stage) + 1)
    .flatMap((candidate) => [
      stageTransitions[candidate].pending,
      stageTransitions[candidate].active,
    ]);
}
