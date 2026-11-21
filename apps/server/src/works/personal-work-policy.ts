import {
  Prisma,
  ReviewStatus,
  SourceLanguage,
  WorkCollaborationMode,
  type LanguageCapability,
  type Role,
  type WorkStage,
  type WorkflowStatus,
} from "../generated/prisma/client.js";
import {
  canUserWorkStage,
  claimableWorkStatuses,
  coordinatedWorkStages,
  stageTransitions,
} from "../workflow/workflow-policy.js";

export interface WorkActor {
  id: string;
  roles: Role[];
  languageCapabilities: LanguageCapability[];
}

export function currentStageStatuses(stage: WorkStage): WorkflowStatus[] {
  return [stageTransitions[stage].pending, stageTransitions[stage].active];
}

// Both list discovery and mutations use the same role/language policy.
export function personalStageScopes(actor: WorkActor) {
  return coordinatedWorkStages.flatMap((stage) => {
    const languages = Object.values(SourceLanguage).filter((language) =>
      canUserWorkStage(
        actor.roles,
        actor.languageCapabilities,
        stage,
        language,
      ),
    );
    return languages.length
      ? [{ stage, sourceLanguage: { in: languages } }]
      : [];
  });
}

export function personalTodoWhere(actor: WorkActor): Prisma.WorkWhereInput {
  const scopes = personalStageScopes(actor);
  // Prisma can elide an empty OR when nested in another filter. Fail closed.
  if (!scopes.length) return { id: { in: [] } };
  return {
    OR: scopes.map(({ stage, sourceLanguage }) => ({
      sourceLanguage,
      workflowStatus: { in: currentStageStatuses(stage) },
      ...(stage === "proofread" ? { proofreadSkippedVersionId: null } : {}),
      stageParticipants: {
        some: { userId: actor.id, stage, leftAt: null, submittedAt: null },
      },
    })),
  };
}

/** Multi-page roles stay discoverable until all original pages have an owner. */
export function availableStageWhere(stage: WorkStage): Prisma.WorkWhereInput {
  const vacantRole = { stageParticipants: { none: { stage, leftAt: null } } };
  if (stage !== "translate" && stage !== "typeset") return vacantRole;
  return {
    OR: [
      { collaborationMode: "single", ...vacantRole },
      {
        collaborationMode: "multi",
        images: {
          some: {
            pageAssignments: { none: { stage, participantId: { not: null } } },
          },
        },
      },
    ],
  };
}

export function personalRecommendationWhere(
  actor: WorkActor,
  immediateOnly = false,
  selectedStage?: WorkStage,
): Prisma.WorkWhereInput {
  const scopes = personalStageScopes(actor).filter(
    ({ stage }) => !selectedStage || stage === selectedStage,
  );
  if (!scopes.length) return { id: { in: [] } };
  return {
    collaborationMigrationIssue: null,
    reviewStatus: ReviewStatus.normal,
    OR: scopes.map(({ stage, sourceLanguage }) => {
      const opposite: WorkStage | null =
        stage === "translate"
          ? "proofread"
          : stage === "proofread"
            ? "translate"
            : null;
      return {
        ...(stage === "proofread" ? { proofreadSkippedVersionId: null } : {}),
        sourceLanguage,
        workflowStatus: {
          in: immediateOnly
            ? currentStageStatuses(stage)
            : claimableWorkStatuses(stage),
        },
        AND: [
          availableStageWhere(stage),
          ...(opposite
            ? [
                {
                  OR: [
                    { collaborationMode: WorkCollaborationMode.multi },
                    {
                      stageParticipants: {
                        none: {
                          stage: opposite,
                          userId: actor.id,
                          leftAt: null,
                        },
                      },
                    },
                  ],
                },
              ]
            : []),
        ],
      } satisfies Prisma.WorkWhereInput;
    }),
  };
}
