export const categories = [
  {
    name: "制作进度",
    ids: [
      "imported",
      "stage_joined",
      "stage_started",
      "typeset_handoff_started",
      "stage_left",
      "stage_assignment_updated",
      "stage_submitted",
      "stage_submission_cancelled",
      "stage_contribution_completed",
      "proofreading_skipped",
      "translation_imported",
      "publish_confirmed",
      "archived",
      "restored",
    ],
  },
  {
    name: "内容审核",
    ids: ["review_opened", "review_withdrawn", "review_resumed"],
  },
  {
    name: "资料变更",
    ids: [
      "metadata_updated",
      "collaboration_mode_updated",
      "stage_credit_updated",
    ],
  },
  {
    name: "成图版本",
    ids: [
      "typeset_version_uploaded",
      "typeset_version_selected",
      "typeset_version_deleted",
      "typeset_version_restored",
    ],
  },
];
export const keyEvents = [
  "imported",
  "stage_joined",
  "stage_left",
  "typeset_handoff_started",
  "stage_submitted",
  "stage_submission_cancelled",
  "review_opened",
  "review_resumed",
  "publish_confirmed",
];
export const stageNames = {
  translate: "翻译",
  proofread: "校对",
  typeset: "嵌字",
  publish: "发布",
};
