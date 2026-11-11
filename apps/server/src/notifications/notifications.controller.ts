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
import { NotificationStatusService } from "./notification-status.service.js";
import { NOTIFICATION_EVENT_KEYS } from "./notification-events.js";
import { NOTIFICATION_TIMESTAMP_PATTERN } from "./notification-history-query.js";
import {
  NotificationReceiptPageDto,
  NotificationReceiptsQueryDto,
  NotificationStatusDto,
  notificationReceiptStatuses,
} from "./notifications-status.dto.js";

@ApiTags("notifications")
@ApiCookieAuth()
@Controller("notifications")
export class NotificationsController {
  constructor(
    @Inject(NotificationsService)
    private readonly notifications: NotificationsService,
    @Inject(NotificationStatusService)
    private readonly notificationStatus: NotificationStatusService,
  ) {}

  @Get("status")
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "getNotificationStatus" })
  @ApiOkResponse({ type: NotificationStatusDto })
  status(): Promise<NotificationStatusDto> {
    return this.notificationStatus.status();
  }

  @Get("receipts")
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "listNotificationReceipts" })
  @ApiQuery({ name: "cursor", required: false, type: String, maxLength: 512 })
  @ApiQuery({
    name: "status",
    required: false,
    enum: notificationReceiptStatuses,
  })
  @ApiQuery({
    name: "limit",
    required: false,
    type: Number,
    minimum: 1,
    maximum: 50,
  })
  @ApiOkResponse({ type: NotificationReceiptPageDto })
  receipts(
    @Query(bodyValidation(NotificationReceiptsQueryDto))
    query: NotificationReceiptsQueryDto,
  ): Promise<NotificationReceiptPageDto> {
    return this.notificationStatus.receipts(query);
  }

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
  @ApiQuery({
    name: "groupId",
    required: false,
    type: String,
    pattern: "^[1-9][0-9]{0,19}$",
  })
  @ApiQuery({
    name: "workNumber",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: 2147483647 },
  })
  @ApiQuery({
    name: "eventType",
    required: false,
    enum: [
      ...NOTIFICATION_EVENT_KEYS,
      "notification.test",
      "birthday.reminder",
    ],
  })
  @ApiQuery({
    name: "createdFrom",
    required: false,
    type: String,
    format: "date-time",
    pattern: NOTIFICATION_TIMESTAMP_PATTERN.source,
  })
  @ApiQuery({
    name: "createdBefore",
    required: false,
    type: String,
    format: "date-time",
    pattern: NOTIFICATION_TIMESTAMP_PATTERN.source,
    description: "Exclusive creation-time upper bound.",
  })
  @ApiQuery({ name: "cursor", required: false, type: String, maxLength: 512 })
  @ApiQuery({
    name: "status",
    required: false,
    enum: notificationDeliveryStatuses,
  })
  @ApiQuery({
    name: "limit",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
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
