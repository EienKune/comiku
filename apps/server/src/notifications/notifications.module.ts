import { Inject, Module, type OnModuleDestroy } from "@nestjs/common";
import { ENVIRONMENT, type Environment } from "../config/environment.js";
import { DatabaseModule } from "../database/database.module.js";
import { JobsModule } from "../jobs/jobs.module.js";
import { NotificationConnectionRegistry } from "./notification-connections.js";
import { NotificationPublisherService } from "./notification-publisher.service.js";
import { NotificationRuntimeService } from "./notification-runtime.service.js";
import { NotificationStatusService } from "./notification-status.service.js";
import { NotificationWorkEventBridgeService } from "./notification-work-event-bridge.service.js";
import { NotificationsController } from "./notifications.controller.js";
import { NotificationsService } from "./notifications.service.js";
import { OneBotHttpAdapter } from "./onebot-http.adapter.js";
import { WorkRemindersService } from "../work-reminders/work-reminders.service.js";
import { WorkRemindersController } from "../work-reminders/work-reminders.controller.js";

// Explicit environment injection keeps offline OpenAPI exports and synthetic
// application construction independent from the machine's private bot config.
export const notificationConnectionProvider = {
  provide: NotificationConnectionRegistry,
  inject: [ENVIRONMENT],
  useFactory: (environment: Environment) =>
    new NotificationConnectionRegistry({
      env: environment.notifications
        ? {
            ...process.env,
            NOTIFICATIONS_ENABLED: String(environment.notifications.enabled),
            NOTIFICATION_CONNECTIONS_FILE:
              environment.notifications.connectionsFile,
          }
        : {},
    }),
};

class NotificationTransportLifecycle implements OnModuleDestroy {
  constructor(
    @Inject(OneBotHttpAdapter) private readonly adapter: OneBotHttpAdapter,
  ) {}
  onModuleDestroy() {
    this.adapter.close();
  }
}

@Module({
  imports: [DatabaseModule, JobsModule],
  controllers: [NotificationsController, WorkRemindersController],
  providers: [
    notificationConnectionProvider,
    OneBotHttpAdapter,
    NotificationTransportLifecycle,
    NotificationPublisherService,
    NotificationWorkEventBridgeService,
    NotificationsService,
    NotificationStatusService,
    NotificationRuntimeService,
    WorkRemindersService,
  ],
  exports: [
    NotificationPublisherService,
    NotificationRuntimeService,
    NotificationConnectionRegistry,
    WorkRemindersService,
  ],
})
export class NotificationsModule {}
