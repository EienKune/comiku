import { ImageReadQueryDto, ImageUrlDto } from "../files/image-url.dto.js";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import {
  ApiBody,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { Access, type AuthRequest } from "../common/access.js";
import { bodyValidation } from "../common/http.js";
import {
  CancelWorkStageSubmissionDto,
  ClaimWorkStagesDto,
  CompleteStageContributionDto,
  JoinWorkStageDto,
  LeaveWorkStageDto,
  SubmitWorkStageDto,
  SkipProofreadingDto,
  UpdateStageCreditDto,
  UpdateStageAssignmentsDto,
  UpdateWorkCollaborationDto,
  UpdateWorkDto,
  WorkDetailDto,
  WorkClaimBatchResultDto,
  WorkMutationDto,
  WorkPageDto,
  WorkQueryDto,
} from "./works.dto.js";
import { WorksService } from "./works.service.js";

@ApiTags("works")
@ApiCookieAuth()
@Controller("works")
export class WorksController {
  constructor(@Inject(WorksService) private readonly works: WorksService) {}

  @Get()
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "listWorks" })
  @ApiQuery({ type: WorkQueryDto })
  @ApiOkResponse({ type: WorkPageDto })
  list(
    @Req() request: AuthRequest,
    @Query(bodyValidation(WorkQueryDto)) query: WorkQueryDto,
  ) {
    return this.works.list(request.actor.userId, query);
  }

  @Get(":id")
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "getWork" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ type: WorkDetailDto })
  get(@Param("id", ParseUUIDPipe) id: string, @Req() request: AuthRequest) {
    return this.works.get(id, request.actor.userId);
  }

  @Get(":workId/images/:imageId/url")
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "getWorkImageUrl" })
  @ApiParam({ name: "workId", format: "uuid" })
  @ApiParam({ name: "imageId", format: "uuid" })
  @ApiQuery({ type: ImageReadQueryDto })
  @ApiOkResponse({ type: ImageUrlDto })
  imageUrl(
    @Param("workId", ParseUUIDPipe) workId: string,
    @Param("imageId", ParseUUIDPipe) imageId: string,
    @Query(bodyValidation(ImageReadQueryDto)) query: ImageReadQueryDto,
  ) {
    return this.works.imageUrl(workId, imageId, query.variant);
  }

  @Patch(":id")
  @Access({ permission: "works:metadata" })
  @ApiOperation({ operationId: "updateWork" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ type: UpdateWorkDto })
  @ApiOkResponse({ type: WorkDetailDto })
  update(
    @Req() request: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(bodyValidation(UpdateWorkDto)) input: UpdateWorkDto,
  ) {
    return this.works.update(request.actor.userId, id, input);
  }

  @Patch(":id/collaboration")
  @Access({ permission: "works:admin" })
  @ApiOperation({ operationId: "updateWorkCollaboration" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ type: UpdateWorkCollaborationDto })
  @ApiOkResponse({ type: WorkDetailDto })
  updateCollaboration(
    @Req() request: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(bodyValidation(UpdateWorkCollaborationDto))
    input: UpdateWorkCollaborationDto,
  ) {
    return this.works.updateCollaboration(request.actor.userId, id, input);
  }

  @Post(":id/stages/join")
  @HttpCode(200)
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "joinWorkStage" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ type: JoinWorkStageDto })
  @ApiOkResponse({ type: WorkDetailDto })
  join(
    @Req() request: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(bodyValidation(JoinWorkStageDto)) input: JoinWorkStageDto,
  ) {
    return this.works.joinStage(request.actor.userId, id, input);
  }

  @Post(":id/stages/claim")
  @HttpCode(200)
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "claimWorkStage" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ type: JoinWorkStageDto })
  @ApiOkResponse({ type: WorkDetailDto })
  claim(
    @Req() request: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(bodyValidation(JoinWorkStageDto)) input: JoinWorkStageDto,
  ) {
    return this.works.claimStage(request.actor.userId, id, input);
  }

  @Post("stages/claims")
  @HttpCode(200)
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "claimWorkStages" })
  @ApiBody({ type: ClaimWorkStagesDto })
  @ApiOkResponse({ type: WorkClaimBatchResultDto })
  claimMany(
    @Req() request: AuthRequest,
    @Body(bodyValidation(ClaimWorkStagesDto)) input: ClaimWorkStagesDto,
  ) {
    return this.works.claimStages(request.actor.userId, input);
  }

  @Patch(":id/stages/credit")
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "updateWorkStageCredit" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ type: UpdateStageCreditDto })
  @ApiOkResponse({ type: WorkDetailDto })
  updateStageCredit(
    @Req() request: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(bodyValidation(UpdateStageCreditDto)) input: UpdateStageCreditDto,
  ) {
    return this.works.updateStageCredit(request.actor.userId, id, input);
  }

  @Post(":id/stages/leave")
  @HttpCode(200)
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "leaveWorkStage" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ type: LeaveWorkStageDto })
  @ApiOkResponse({ type: WorkDetailDto })
  leave(
    @Req() request: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(bodyValidation(LeaveWorkStageDto)) input: LeaveWorkStageDto,
  ) {
    return this.works.leaveStage(request.actor.userId, id, input);
  }

  @Post(":id/stages/assignments")
  @HttpCode(200)
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "updateWorkStageAssignments" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ type: UpdateStageAssignmentsDto })
  @ApiOkResponse({ type: WorkDetailDto })
  updateStageAssignments(
    @Req() request: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(bodyValidation(UpdateStageAssignmentsDto))
    input: UpdateStageAssignmentsDto,
  ) {
    return this.works.updateStageAssignments(request.actor.userId, id, input);
  }

  @Post(":id/stages/contributions/complete")
  @HttpCode(200)
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "completeWorkStageContribution" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ type: CompleteStageContributionDto })
  @ApiOkResponse({ type: WorkDetailDto })
  completeStageContribution(
    @Req() request: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(bodyValidation(CompleteStageContributionDto))
    input: CompleteStageContributionDto,
  ) {
    return this.works.completeStageContribution(
      request.actor.userId,
      id,
      input,
    );
  }

  @Post(":id/stages/submit")
  @HttpCode(200)
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "submitWorkStage" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ type: SubmitWorkStageDto })
  @ApiOkResponse({ type: WorkDetailDto })
  submit(
    @Req() request: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(bodyValidation(SubmitWorkStageDto)) input: SubmitWorkStageDto,
  ) {
    return this.works.submitStage(request.actor.userId, id, input);
  }

  @Post(":id/stages/proofread/skip")
  @HttpCode(200)
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "skipWorkProofreading" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ type: SkipProofreadingDto })
  @ApiOkResponse({ type: WorkDetailDto })
  skipProofreading(
    @Req() request: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(bodyValidation(SkipProofreadingDto)) input: SkipProofreadingDto,
  ) {
    return this.works.skipProofreading(request.actor.userId, id, input);
  }

  @Post(":id/stages/submission/cancel")
  @HttpCode(200)
  @Access({ permission: "works:read" })
  @ApiOperation({ operationId: "cancelWorkStageSubmission" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ type: CancelWorkStageSubmissionDto })
  @ApiOkResponse({ type: WorkDetailDto })
  cancelSubmission(
    @Req() request: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(bodyValidation(CancelWorkStageSubmissionDto))
    input: CancelWorkStageSubmissionDto,
  ) {
    return this.works.cancelStageSubmission(request.actor.userId, id, input);
  }

  @Post(":id/archive")
  @HttpCode(200)
  @Access({ permission: "works:admin" })
  @ApiOperation({ operationId: "archiveWork" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ type: WorkDetailDto })
  archive(
    @Req() request: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(bodyValidation(WorkMutationDto)) input: WorkMutationDto,
  ) {
    return this.works.archive(request.actor.userId, id, input);
  }

  @Post(":id/restore")
  @HttpCode(200)
  @Access({ permission: "works:admin" })
  @ApiOperation({ operationId: "restoreWork" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ type: WorkDetailDto })
  restore(
    @Req() request: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(bodyValidation(WorkMutationDto)) input: WorkMutationDto,
  ) {
    return this.works.restore(request.actor.userId, id, input);
  }
}
