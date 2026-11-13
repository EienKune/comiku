import type { components } from "@comiku/api-client";
export const workflowLabels: Record<
  components["schemas"]["WorkflowStatus"],
  string
> = {
  pending_translate: "待翻译",
  translating: "翻译中",
  pending_proofread: "待校对",
  proofreading: "校对中",
  pending_typeset: "待嵌字",
  typesetting: "嵌字中",
  pending_publish: "待发布",
  published: "已发布",
  archived: "已归档",
};
export const reviewLabels: Record<
  components["schemas"]["ReviewStatus"],
  string
> = { normal: "正常", needs_review: "待审核", blocked: "阻塞" };
