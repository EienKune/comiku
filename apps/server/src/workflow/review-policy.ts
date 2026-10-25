import { ConflictException } from "@nestjs/common";
import { ReviewStatus, WorkflowStatus } from "../generated/prisma/client.js";

/** Invoke after taking the work row lock, before every production mutation. */
export function assertProductionWritable(work: {
  reviewStatus: ReviewStatus;
  workflowStatus: WorkflowStatus;
}) {
  if (work.reviewStatus !== ReviewStatus.normal) {
    throw new ConflictException({
      code: "WORK_REVIEW_PAUSED",
      message: "作品因审核只读挂起，请先处理审核事项",
    });
  }
  if (work.workflowStatus === WorkflowStatus.archived) {
    throw new ConflictException("归档或舍弃作品只允许查看");
  }
}
