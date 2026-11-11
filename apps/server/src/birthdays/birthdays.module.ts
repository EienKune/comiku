import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module.js";
import { JobsModule } from "../jobs/jobs.module.js";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { BirthdaysController } from "./birthdays.controller.js";
import { BirthdaysService } from "./birthdays.service.js";
import { BirthdayReminderService } from "./birthday-reminder.service.js";

@Module({
  imports: [DatabaseModule, JobsModule, NotificationsModule],
  controllers: [BirthdaysController],
  providers: [BirthdaysService, BirthdayReminderService],
  exports: [BirthdaysService, BirthdayReminderService],
})
export class BirthdaysModule {}
