import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor, FilesInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import {
  ApiBody,
  ApiCookieAuth,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { Access, type AuthRequest } from "../common/access.js";
import { bodyValidation } from "../common/http.js";
import type { ManualUploadFile } from "../candidates/manual-candidate-upload.js";
import {
  AuthorDto,
  AuthorEvidenceDto,
  AuthorEvidenceUploadDto,
  AuthorImportPreviewDto,
  AuthorImportResultDto,
  AuthorPageDto,
  AuthorQueryDto,
  CreateAuthorDto,
  CreateExternalAccountDto,
  CreateTagDto,
  ExternalAccountDto,
  ImportAuthorsDto,
  ManagedAuthorDto,
  ReorderAuthorEvidenceDto,
  ResolvedXProfileDto,
  ResolveXProfileDto,
  RevisionDto,
  SourceCapabilityDto,
  TagDto,
  UpdateAuthorDto,
  UpdateExternalAccountDto,
  UpdateSourceAdapterStateDto,
  UpdateTagDto,
} from "./authors.dto.js";
import { AuthorsService } from "./authors.service.js";

@ApiTags("authors")
@ApiCookieAuth()
@Controller("authors")
export class AuthorsController {
  constructor(
    @Inject(AuthorsService) private readonly authors: AuthorsService,
  ) {}

  @Get()
  @Access({ permission: "authors:read" })
  @ApiOperation({ operationId: "listAuthors" })
  @ApiQuery({ type: AuthorQueryDto })
  @ApiOkResponse({ type: AuthorPageDto })
  list(@Query(bodyValidation(AuthorQueryDto)) query: AuthorQueryDto) {
    return this.authors.list(query);
  }

  @Get("archived")
  @Access({ permission: "authors:admin" })
  @ApiOperation({ operationId: "listArchivedAuthors" })
  @ApiOkResponse({ type: ManagedAuthorDto, isArray: true })
  archived() {
    return this.authors.listArchived();
  }

  @Get("sources")
  @Access({ permission: "authors:read" })
  @ApiOperation({ operationId: "listContentSources" })
  @ApiOkResponse({ type: SourceCapabilityDto, isArray: true })
  sources() {
    return this.authors.listSources();
  }

  @Get("tags")
  @Access({ permission: "authors:read" })
  @ApiOperation({ operationId: "listAuthorTags" })
  @ApiOkResponse({ type: TagDto, isArray: true })
  tags() {
    return this.authors.listTags();
  }

  @Post("tags")
  @Access({ permission: "authors:manage" })
  @ApiOperation({ operationId: "createAuthorTag" })
  @ApiBody({ type: CreateTagDto })
  @ApiCreatedResponse({ type: TagDto })
  createTag(@Body(bodyValidation(CreateTagDto)) input: CreateTagDto) {
    return this.authors.createTag(input);
  }

  @Patch("tags/:id")
  @Access({ permission: "authors:manage" })
  @ApiOperation({ operationId: "updateAuthorTag" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ type: UpdateTagDto })
  @ApiOkResponse({ type: TagDto })
  updateTag(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(bodyValidation(UpdateTagDto)) input: UpdateTagDto,
  ) {
    return this.authors.updateTag(id, input);
  }

  @Delete("tags/:id")
  @Access({ permission: "authors:manage" })
  @ApiOperation({ operationId: "deleteAuthorTag" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ type: RevisionDto })
  @ApiOkResponse({ schema: { example: { ok: true } } })
  deleteTag(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(bodyValidation(RevisionDto)) input: RevisionDto,
  ) {
    return this.authors.deleteTag(id, input.expectedRevision);
  }

  @Get("import-template")
  @Access({ permission: "authors:manage" })
  @ApiOperation({ operationId: "downloadAuthorImportTemplate" })
  @ApiOkResponse({ content: { "text/csv": { schema: { type: "string" } } } })
  importTemplate(@Res({ passthrough: true }) response: Response) {
    response.setHeader("Content-Type", "text/csv; charset=utf-8");
    response.setHeader(
      "Content-Disposition",
      'attachment; filename="comiku-authors.csv"',
    );
    return new StreamableFile(Buffer.from(this.authors.importTemplate()));
  }

  @Post("imports/preview")
  @HttpCode(200)
  @Access({ permission: "authors:manage", contentType: "multipart/form-data" })
  @UseInterceptors(
    FileInterceptor("file", { limits: { files: 1, fileSize: 1024 * 1024 } }),
  )
  @ApiOperation({ operationId: "previewAuthorImport" })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["file"],
      properties: { file: { type: "string", format: "binary" } },
    },
  })
  @ApiOkResponse({ type: AuthorImportPreviewDto })
  previewImport(
    @Req() request: AuthRequest,
    @UploadedFile() file: ManualUploadFile | undefined,
  ) {
    if (!file) throw new BadRequestException("请选择 CSV 文件");
    return this.authors.previewImport(request.actor.userId, file);
  }

  @Post("imports")
  @Access({ permission: "authors:manage" })
  @ApiOperation({ operationId: "importAuthors" })
  @ApiBody({ type: ImportAuthorsDto })
  @ApiCreatedResponse({ type: AuthorImportResultDto })
  importAuthors(
    @Req() request: AuthRequest,
    @Body(bodyValidation(ImportAuthorsDto)) input: ImportAuthorsDto,
  ) {
    return this.authors.importAuthors(request.actor.userId, input.rows);
  }

  @Post("x-profile/resolve")
  @HttpCode(200)
  @Access({ permission: "authors:manage" })
  @ApiOperation({ operationId: "resolveXProfile" })
  @ApiBody({ type: ResolveXProfileDto })
  @ApiOkResponse({ type: ResolvedXProfileDto })
  resolveXProfile(
    @Req() request: AuthRequest,
    @Body(bodyValidation(ResolveXProfileDto)) input: ResolveXProfileDto,
  ) {
    return this.authors.resolveXProfile(
      request.actor.userId,
      input.handle,
      input.authorId,
    );
  }

  @Post()
  @Access({ permission: "authors:manage" })
  @ApiOperation({ operationId: "createAuthor" })
  @ApiBody({ type: CreateAuthorDto })
  @ApiCreatedResponse({ type: ManagedAuthorDto })
  create(@Body(bodyValidation(CreateAuthorDto)) input: CreateAuthorDto) {
    return this.authors.create(input);
  }

  @Get(":id")
  @Access({ permission: "authors:read" })
  @ApiOperation({ operationId: "getAuthor" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ type: AuthorDto })
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.authors.get(id);
  }

  @Get(":id/avatar/url")
  @Access({ permission: "authors:read" })
  @ApiOperation({ operationId: "getAuthorAvatarUrl" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({
    schema: {
      type: "object",
      required: ["url", "expiresInSeconds"],
      properties: {
        url: { type: "string" },
        expiresInSeconds: { type: "integer" },
      },
    },
  })
  avatarUrl(@Param("id", ParseUUIDPipe) id: string) {
    return this.authors.avatarUrl(id);
  }

  @Post(":id/avatar")
  @HttpCode(200)
  @Access({ permission: "authors:manage", contentType: "multipart/form-data" })
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { files: 1, fileSize: 5 * 1024 * 1024 },
    }),
  )
  @ApiOperation({ operationId: "uploadAuthorAvatar" })
  @ApiConsumes("multipart/form-data")
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({
    schema: {
      type: "object",
      required: ["expectedRevision", "file"],
      properties: {
        expectedRevision: { type: "integer", minimum: 0 },
        file: { type: "string", format: "binary" },
      },
    },
  })
  @ApiOkResponse({ type: ManagedAuthorDto })
  uploadAvatar(
    @Req() request: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @UploadedFile() file: ManualUploadFile | undefined,
    @Body(bodyValidation(AuthorEvidenceUploadDto))
    input: AuthorEvidenceUploadDto,
  ) {
    if (!file) throw new BadRequestException("请选择头像图片");
    return this.authors.uploadAvatar(
      request.actor.userId,
      id,
      input.expectedRevision,
      file,
    );
  }

  @Get(":id/authorization-evidence")
  @Access({ permission: "authors:sensitive" })
  @ApiOperation({ operationId: "listAuthorAuthorizationEvidence" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiOkResponse({ type: AuthorEvidenceDto, isArray: true })
  evidence(@Param("id", ParseUUIDPipe) id: string) {
    return this.authors.listEvidence(id);
  }

  @Post(":id/authorization-evidence")
  @Access({
    permission: "authors:sensitive",
    contentType: "multipart/form-data",
  })
  @UseInterceptors(
    FilesInterceptor("files", 10, {
      limits: { files: 10, fileSize: 10 * 1024 * 1024 },
    }),
  )
  @ApiOperation({ operationId: "uploadAuthorAuthorizationEvidence" })
  @ApiConsumes("multipart/form-data")
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({
    schema: {
      type: "object",
      required: ["expectedRevision", "files"],
      properties: {
        expectedRevision: { type: "integer", minimum: 0 },
        files: {
          type: "array",
          maxItems: 10,
          items: { type: "string", format: "binary" },
        },
      },
    },
  })
  @ApiCreatedResponse({ type: AuthorEvidenceDto, isArray: true })
  uploadEvidence(
    @Req() request: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @UploadedFiles() files: ManualUploadFile[] | undefined,
    @Body(bodyValidation(AuthorEvidenceUploadDto))
    input: AuthorEvidenceUploadDto,
  ) {
    return this.authors.uploadEvidence(
      request.actor.userId,
      id,
      input.expectedRevision,
      files ?? [],
    );
  }

  @Patch(":id/authorization-evidence/order")
  @Access({ permission: "authors:sensitive" })
  @ApiOperation({ operationId: "reorderAuthorAuthorizationEvidence" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ type: ReorderAuthorEvidenceDto })
  @ApiOkResponse({ type: AuthorEvidenceDto, isArray: true })
  reorderEvidence(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(bodyValidation(ReorderAuthorEvidenceDto))
    input: ReorderAuthorEvidenceDto,
  ) {
    return this.authors.reorderEvidence(
      id,
      input.evidenceIds,
      input.expectedRevision,
    );
  }

  @Delete(":id/authorization-evidence/:evidenceId")
  @Access({ permission: "authors:sensitive" })
  @ApiOperation({ operationId: "deleteAuthorAuthorizationEvidence" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiParam({ name: "evidenceId", format: "uuid" })
  @ApiBody({ type: RevisionDto })
  @ApiOkResponse({ type: AuthorEvidenceDto, isArray: true })
  deleteEvidence(
    @Req() request: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("evidenceId", ParseUUIDPipe) evidenceId: string,
    @Body(bodyValidation(RevisionDto)) input: RevisionDto,
  ) {
    return this.authors.deleteEvidence(
      request.actor.userId,
      id,
      evidenceId,
      input.expectedRevision,
    );
  }

  @Patch(":id")
  @Access({ permission: "authors:manage" })
  @ApiOperation({ operationId: "updateAuthor" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ type: UpdateAuthorDto })
  @ApiOkResponse({ type: ManagedAuthorDto })
  update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(bodyValidation(UpdateAuthorDto)) input: UpdateAuthorDto,
  ) {
    return this.authors.update(id, input);
  }

  @Delete(":id")
  @Access({ permission: "authors:admin" })
  @ApiOperation({ operationId: "archiveAuthor" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ type: RevisionDto })
  @ApiOkResponse({ type: ManagedAuthorDto })
  archive(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(bodyValidation(RevisionDto)) input: RevisionDto,
  ) {
    return this.authors.archive(id, input.expectedRevision);
  }

  @Post(":id/restore")
  @HttpCode(200)
  @Access({ permission: "authors:admin" })
  @ApiOperation({ operationId: "restoreAuthor" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ type: RevisionDto })
  @ApiOkResponse({ type: ManagedAuthorDto })
  restore(
    @Param("id", ParseUUIDPipe) id: string,
    @Body(bodyValidation(RevisionDto)) input: RevisionDto,
  ) {
    return this.authors.restore(id, input.expectedRevision);
  }

  @Get(":authorId/accounts/archived")
  @Access({ permission: "authors:manage" })
  @ApiOperation({ operationId: "listArchivedAuthorAccounts" })
  @ApiParam({ name: "authorId", format: "uuid" })
  @ApiOkResponse({ type: ExternalAccountDto, isArray: true })
  archivedAccounts(@Param("authorId", ParseUUIDPipe) authorId: string) {
    return this.authors.listArchivedAccounts(authorId);
  }

  @Post(":authorId/accounts")
  @Access({ permission: "authors:manage" })
  @ApiOperation({ operationId: "createAuthorAccount" })
  @ApiParam({ name: "authorId", format: "uuid" })
  @ApiBody({ type: CreateExternalAccountDto })
  @ApiCreatedResponse({ type: ExternalAccountDto })
  createAccount(
    @Param("authorId", ParseUUIDPipe) authorId: string,
    @Body(bodyValidation(CreateExternalAccountDto))
    input: CreateExternalAccountDto,
  ) {
    return this.authors.createAccount(authorId, input);
  }

  @Get(":authorId/accounts")
  @Access({ permission: "authors:manage" })
  @ApiOperation({ operationId: "listAuthorAccounts" })
  @ApiParam({ name: "authorId", format: "uuid" })
  @ApiOkResponse({ type: ExternalAccountDto, isArray: true })
  accounts(@Param("authorId", ParseUUIDPipe) authorId: string) {
    return this.authors.listAccounts(authorId);
  }

  @Patch(":authorId/accounts/:id")
  @Access({ permission: "authors:manage" })
  @ApiOperation({ operationId: "updateAuthorAccount" })
  @ApiParam({ name: "authorId", format: "uuid" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ type: UpdateExternalAccountDto })
  @ApiOkResponse({ type: ExternalAccountDto })
  updateAccount(
    @Req() request: AuthRequest,
    @Param("authorId", ParseUUIDPipe) authorId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(bodyValidation(UpdateExternalAccountDto))
    input: UpdateExternalAccountDto,
  ) {
    return this.authors.updateAccount(
      authorId,
      id,
      input,
      request.actor.userId,
    );
  }

  @Patch(":authorId/accounts/:id/adapters/:adapterKey")
  @Access({ permission: "authors:manage" })
  @ApiOperation({ operationId: "updateAuthorAccountAdapter" })
  @ApiParam({ name: "authorId", format: "uuid" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiParam({ name: "adapterKey", type: String })
  @ApiBody({ type: UpdateSourceAdapterStateDto })
  @ApiOkResponse({ type: ExternalAccountDto })
  updateAdapter(
    @Param("authorId", ParseUUIDPipe) authorId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("adapterKey") adapterKey: string,
    @Body(bodyValidation(UpdateSourceAdapterStateDto))
    input: UpdateSourceAdapterStateDto,
  ) {
    return this.authors.updateAdapterState(authorId, id, adapterKey, input);
  }

  @Delete(":authorId/accounts/:id")
  @Access({ permission: "authors:manage" })
  @ApiOperation({ operationId: "archiveAuthorAccount" })
  @ApiParam({ name: "authorId", format: "uuid" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ type: RevisionDto })
  @ApiOkResponse({ schema: { example: { ok: true } } })
  archiveAccount(
    @Req() request: AuthRequest,
    @Param("authorId", ParseUUIDPipe) authorId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(bodyValidation(RevisionDto)) input: RevisionDto,
  ) {
    return this.authors.archiveAccount(
      authorId,
      id,
      input.expectedRevision,
      request.actor.userId,
    );
  }

  @Post(":authorId/accounts/:id/restore")
  @HttpCode(200)
  @Access({ permission: "authors:manage" })
  @ApiOperation({ operationId: "restoreAuthorAccount" })
  @ApiParam({ name: "authorId", format: "uuid" })
  @ApiParam({ name: "id", format: "uuid" })
  @ApiBody({ type: RevisionDto })
  @ApiOkResponse({ type: ExternalAccountDto })
  restoreAccount(
    @Req() request: AuthRequest,
    @Param("authorId", ParseUUIDPipe) authorId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(bodyValidation(RevisionDto)) input: RevisionDto,
  ) {
    return this.authors.restoreAccount(
      authorId,
      id,
      input.expectedRevision,
      request.actor.userId,
    );
  }
}
