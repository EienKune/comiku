import {
  BadRequestException,
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
import { BirthdaysService } from "./birthdays.service.js";
import { BirthdayReminderService } from "./birthday-reminder.service.js";
import {
  BirthdayCalendarDto,
  BirthdayChannelDto,
  BirthdayManagementDto,
  BirthdayPreviewDto,
  BirthdaySettingsDto,
  BirthdaySettingsInputDto,
  BirthdaySubscriptionInputDto,
  BirthdaySyncDto,
  BirthdayTemplateDto,
  BirthdayTemplateInputDto,
} from "./birthdays.dto.js";

@ApiTags("birthdays")
@ApiCookieAuth()
@Controller("birthdays")
export class BirthdaysController {
  constructor(
    @Inject(BirthdaysService) private readonly birthdays: BirthdaysService,
    @Inject(BirthdayReminderService)
    private readonly reminders: BirthdayReminderService,
  ) {}

  @Get("summary")
  @Access({ permission: "dashboard:read" })
  @Header("Cache-Control", "private, no-store")
  @ApiOperation({ operationId: "getBirthdaySummary" })
  @ApiOkResponse({ type: BirthdayCalendarDto })
  summary(): Promise<BirthdayCalendarDto> {
    return this.birthdays.calendar(new Date(), true);
  }

  @Get("calendar")
  @Access({ permission: "dashboard:read" })
  @Header("Cache-Control", "private, no-store")
  @ApiOperation({ operationId: "getBirthdayCalendar" })
  @ApiOkResponse({ type: BirthdayCalendarDto })
  calendar(): Promise<BirthdayCalendarDto> {
    return this.birthdays.calendar();
  }

  @Get("settings")
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "getBirthdaySettings" })
  @ApiOkResponse({ type: BirthdayManagementDto })
  async settings(): Promise<BirthdayManagementDto> {
    const [settings, status] = await Promise.all([
      this.reminders.settings(),
      this.birthdays.catalogStatus(),
    ]);
    return { ...status, settings };
  }
  @Patch("settings")
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "updateBirthdaySettings" })
  @ApiBody({ type: BirthdaySettingsInputDto })
  @ApiOkResponse({ type: BirthdaySettingsDto })
  updateSettings(
    @Req() req: AuthRequest,
    @Body(bodyValidation(BirthdaySettingsInputDto))
    input: BirthdaySettingsInputDto,
  ): Promise<BirthdaySettingsDto> {
    return this.reminders.updateSettings(req.actor.userId, input);
  }
  @Post("sync")
  @HttpCode(202)
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "synchronizeBirthdayCatalog" })
  @ApiAcceptedResponse({ type: BirthdaySyncDto })
  sync(@Req() req: AuthRequest): Promise<BirthdaySyncDto> {
    return this.birthdays.schedule(req.actor.userId);
  }

  @Get("subscriptions")
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "getBirthdaySubscriptions" })
  @ApiOkResponse({ type: BirthdayChannelDto, isArray: true })
  subscriptions(): Promise<BirthdayChannelDto[]> {
    return this.reminders.channels();
  }

  @Patch("subscriptions/:id")
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "updateBirthdaySubscription" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiBody({ type: BirthdaySubscriptionInputDto })
  @ApiOkResponse({ type: BirthdayChannelDto })
  updateSubscription(
    @Req() req: AuthRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(bodyValidation(BirthdaySubscriptionInputDto))
    input: BirthdaySubscriptionInputDto,
  ): Promise<BirthdayChannelDto> {
    return this.reminders.updateSubscription(req.actor.userId, id, input);
  }
  @Get("template")
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "getBirthdayTemplate" })
  @ApiOkResponse({ type: BirthdayTemplateDto })
  template(): Promise<BirthdayTemplateDto> {
    return this.reminders.template();
  }

  @Patch("template")
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "updateBirthdayTemplate" })
  @ApiBody({ type: BirthdayTemplateInputDto })
  @ApiOkResponse({ type: BirthdayTemplateDto })
  updateTemplate(
    @Req() req: AuthRequest,
    @Body(bodyValidation(BirthdayTemplateInputDto))
    input: BirthdayTemplateInputDto,
  ): Promise<BirthdayTemplateDto> {
    return this.reminders.updateTemplate(req.actor.userId, input);
  }
  @Get("preview")
  @Access({ permission: "system:manage" })
  @ApiOperation({ operationId: "previewBirthdayReminder" })
  @ApiQuery({
    name: "offsetDays",
    type: Number,
    required: false,
    enum: [0, 1, 7],
  })
  @ApiOkResponse({ type: BirthdayPreviewDto })
  preview(@Query("offsetDays") offset?: string): Promise<BirthdayPreviewDto> {
    if (offset !== undefined && !/^(0|1|7)$/.test(offset))
      throw new BadRequestException("提醒日期无效");
    return this.reminders.preview(Number(offset ?? 0));
  }
}
