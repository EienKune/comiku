import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { Test } from "@nestjs/testing";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { NotificationsController } from "../src/notifications/notifications.controller.js";
import { NotificationsService } from "../src/notifications/notifications.service.js";
import { NotificationStatusService } from "../src/notifications/notification-status.service.js";
import { NOTIFICATION_EVENT_KEYS } from "../src/notifications/notification-events.js";
import { NOTIFICATION_TIMESTAMP_PATTERN } from "../src/notifications/notification-history-query.js";
import { notificationDeliveryStatuses } from "../src/notifications/notifications.dto.js";

test("Swagger exports the complete notification delivery history query contract", async () => {
  const module = await Test.createTestingModule({
    controllers: [NotificationsController],
    providers: [
      { provide: NotificationsService, useValue: {} },
      { provide: NotificationStatusService, useValue: {} },
    ],
  }).compile();
  const app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix("api");
  try {
    // Metadata export needs neither app.init/listen nor database/network services.
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle("Notification contract fixture").build(),
    );
    const operation = document.paths["/api/notifications/deliveries"]?.get;
    assert.equal(operation?.operationId, "listNotificationDeliveries");
    const parameters = operation?.parameters ?? [];
    assert.deepEqual(
      parameters
        .map((parameter) => ("name" in parameter ? parameter.name : null))
        .sort(),
      [
        "createdBefore",
        "createdFrom",
        "cursor",
        "eventType",
        "groupId",
        "limit",
        "status",
        "workNumber",
      ],
    );
    const query = new Map(
      parameters.map((parameter) => {
        assert.ok("name" in parameter);
        assert.equal(parameter.in, "query");
        assert.equal(parameter.required, false);
        assert.ok(parameter.schema && !("$ref" in parameter.schema));
        return [parameter.name, parameter.schema] as const;
      }),
    );
    assert.deepEqual(query.get("groupId"), {
      type: "string",
      pattern: "^[1-9][0-9]{0,19}$",
    });
    assert.deepEqual(query.get("workNumber"), {
      type: "integer",
      minimum: 1,
      maximum: 2147483647,
    });
    assert.deepEqual(query.get("eventType"), {
      type: "string",
      enum: [
        ...NOTIFICATION_EVENT_KEYS,
        "notification.test",
        "birthday.reminder",
      ],
    });
    for (const name of ["createdFrom", "createdBefore"]) {
      assert.deepEqual(query.get(name), {
        type: "string",
        format: "date-time",
        pattern: NOTIFICATION_TIMESTAMP_PATTERN.source,
      });
    }
    const before = parameters.find(
      (parameter) => "name" in parameter && parameter.name === "createdBefore",
    );
    assert.ok(before && "description" in before);
    assert.match(before.description ?? "", /exclusive/i);
    assert.deepEqual(query.get("cursor"), { type: "string", maxLength: 512 });
    assert.deepEqual(query.get("status"), {
      type: "string",
      enum: [...notificationDeliveryStatuses],
    });
    assert.deepEqual(query.get("limit"), {
      type: "integer",
      minimum: 1,
      maximum: 50,
      default: 20,
    });
  } finally {
    await app.close();
  }
});
