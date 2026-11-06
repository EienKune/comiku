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
  ApiAcceptedResponse,
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
  NotificationChannelDto,
  NotificationChannelInputDto,
  NotificationChannelUpdateDto,
  NotificationConfigurationDto,
  NotificationDeliveryDto,
  NotificationDeliveryPageDto,
  NotificationDeliveryQueryDto,
  NotificationPreviewDto,
  NotificationPreviewInputDto,
  NotificationResolveDto,
  NotificationTestDto,
  NotificationTemplateDto,
  NotificationTemplateUpdateDto,
  notificationDeliveryStatuses,
} from "./notifications.dto.js";
import { NotificationsService } from "./notifications.service.js";

@ApiTags("notifications")
@ApiCookieAuth()
@Controller("notifications")
export class NotificationsController {
  constructor(
    @Inject(NotificationsService)
    private readonly notifications: NotificationsService,
  ) {}

  @Get("configuration")
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "getNotificationConfiguration" })
  @ApiOkResponse({ type: NotificationConfigurationDto })
  configuration(): Promise<NotificationConfigurationDto> {
    return this.notifications.configuration();
  }

  @Patch("templates/:eventType")
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "updateNotificationTemplate" })
  @ApiParam({ name: "eventType", type: String })
  @ApiBody({ type: NotificationTemplateUpdateDto })
  @ApiOkResponse({ type: NotificationTemplateDto })
  updateTemplate(
    @Req() request: AuthRequest,
    @Param("eventType") eventType: string,
    @Body(bodyValidation(NotificationTemplateUpdateDto))
    input: NotificationTemplateUpdateDto,
  ): Promise<NotificationTemplateDto> {
    return this.notifications.updateTemplate(
      request.actor.userId,
      eventType,
      input,
    );
  }

  @Post("channels")
  @HttpCode(200)
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "createNotificationChannel" })
  @ApiBody({ type: NotificationChannelInputDto })
  @ApiOkResponse({ type: NotificationChannelDto })
  createChannel(
    @Req() request: AuthRequest,
    @Body(bodyValidation(NotificationChannelInputDto))
    input: NotificationChannelInputDto,
  ): Promise<NotificationChannelDto> {
    return this.notifications.createChannel(request.actor.userId, input);
  }

  @Patch("channels/:id")
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "updateNotificationChannel" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiBody({ type: NotificationChannelUpdateDto })
  @ApiOkResponse({ type: NotificationChannelDto })
  updateChannel(
    @Req() request: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(bodyValidation(NotificationChannelUpdateDto))
    input: NotificationChannelUpdateDto,
  ): Promise<NotificationChannelDto> {
    return this.notifications.updateChannel(request.actor.userId, id, input);
  }

  @Post("preview")
  @HttpCode(200)
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "previewNotification" })
  @ApiBody({ type: NotificationPreviewInputDto })
  @ApiOkResponse({ type: NotificationPreviewDto })
  preview(
    @Body(bodyValidation(NotificationPreviewInputDto))
    input: NotificationPreviewInputDto,
  ): NotificationPreviewDto {
    return this.notifications.preview(input);
  }

  @Get("deliveries")
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "listNotificationDeliveries" })
  @ApiQuery({ name: "cursor", required: false, type: String, maxLength: 512 })
  @ApiQuery({
    name: "status",
    required: false,
    enum: notificationDeliveryStatuses,
  })
  @ApiQuery({
    name: "limit",
    required: false,
    type: Number,
    minimum: 1,
    maximum: 50,
  })
  @ApiOkResponse({ type: NotificationDeliveryPageDto })
  deliveries(
    @Query(bodyValidation(NotificationDeliveryQueryDto))
    query: NotificationDeliveryQueryDto,
  ): Promise<NotificationDeliveryPageDto> {
    return this.notifications.listDeliveries(query);
  }

  @Post("channels/:id/test")
  @HttpCode(202)
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "testNotificationChannel" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiBody({ type: NotificationTestDto })
  @ApiAcceptedResponse({ type: NotificationDeliveryDto })
  testChannel(
    @Req() request: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(bodyValidation(NotificationTestDto)) input: NotificationTestDto,
  ): Promise<NotificationDeliveryDto> {
    return this.notifications.testChannel(
      request.actor.userId,
      id,
      input.idempotencyKey,
      input,
    );
  }

  @Post("deliveries/:id/resolve")
  @HttpCode(200)
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "resolveNotificationDelivery" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiBody({ type: NotificationResolveDto })
  @ApiOkResponse({ type: NotificationDeliveryDto })
  resolveDelivery(
    @Req() request: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(bodyValidation(NotificationResolveDto)) input: NotificationResolveDto,
  ): Promise<NotificationDeliveryDto> {
    return this.notifications.resolveDelivery(request.actor.userId, id, input);
  }
}
