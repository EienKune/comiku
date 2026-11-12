import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from "@nestjs/common";
import {
  ApiBody,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import { Access, type AuthRequest } from "../common/access.js";
import { bodyValidation } from "../common/http.js";
import { WorkRemindersService } from "./work-reminders.service.js";
import {
  WorkReminderManagementDto,
  WorkReminderSettingsDto,
  WorkReminderSettingsInputDto,
  WorkReminderSubscriptionInputDto,
  WorkReminderChannelDto,
  WorkReminderPreviewInputDto,
  WorkReminderPreviewDto,
} from "./work-reminders.dto.js";

@ApiTags("notifications")
@ApiCookieAuth()
@Controller("notifications/work-reminders")
export class WorkRemindersController {
  constructor(
    @Inject(WorkRemindersService)
    private readonly reminders: WorkRemindersService,
  ) {}
  @Get()
  @Access({ permission: "system:manage" })
  @Header("Cache-Control", "private, no-store")
  @ApiOperation({ operationId: "getWorkReminders" })
  @ApiOkResponse({ type: WorkReminderManagementDto })
  management(): Promise<WorkReminderManagementDto> {
    return this.reminders.management();
  }
  @Patch("settings")
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "updateWorkReminderSettings" })
  @ApiBody({ type: WorkReminderSettingsInputDto })
  @ApiOkResponse({ type: WorkReminderSettingsDto })
  updateSettings(
    @Req() req: AuthRequest,
    @Body(bodyValidation(WorkReminderSettingsInputDto))
    input: WorkReminderSettingsInputDto,
  ): Promise<WorkReminderSettingsDto> {
    return this.reminders.updateSettings(req.actor.userId, input);
  }
  @Patch("subscriptions/:id")
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "updateWorkReminderSubscription" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiBody({ type: WorkReminderSubscriptionInputDto })
  @ApiOkResponse({ type: WorkReminderChannelDto })
  updateSubscription(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(bodyValidation(WorkReminderSubscriptionInputDto))
    input: WorkReminderSubscriptionInputDto,
  ): Promise<WorkReminderChannelDto> {
    return this.reminders.updateSubscription(req.actor.userId, id, input);
  }
  @Post("preview")
  @HttpCode(200)
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "previewWorkReminder" })
  @ApiBody({ type: WorkReminderPreviewInputDto })
  @ApiOkResponse({ type: WorkReminderPreviewDto })
  preview(
    @Body(bodyValidation(WorkReminderPreviewInputDto))
    input: WorkReminderPreviewInputDto,
  ): Promise<WorkReminderPreviewDto> {
    return this.reminders.preview(input.note);
  }
}
