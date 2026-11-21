import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { ForbiddenException } from "@nestjs/common";
import { permissionsFor } from "../src/common/access.js";
import { PublishingService } from "../src/publishing/publishing.service.js";
import type { PrismaService } from "../src/database/prisma.service.js";
import type { FileObjectsService } from "../src/files/file-objects.service.js";
import { Role } from "../src/generated/prisma/client.js";

test("publishing requires the operator role while administrator management stays available", () => {
  for (const role of Object.values(Role)) {
    assert.equal(
      permissionsFor([role], false).includes("works:publish"),
      role === Role.operator,
    );
  }
  assert.ok(
    permissionsFor([Role.admin, Role.operator], false).includes(
      "works:publish",
    ),
  );
  for (const permission of [
    "accounts:manage",
    "system:manage",
    "works:admin",
    "works:metadata",
    "reviews:resolve",
  ] as const)
    assert.ok(permissionsFor([Role.admin], false).includes(permission));
});

for (const roles of [[Role.admin], [Role.reviewer], [Role.typesetter], []]) {
  test(`publishing service rejects ${roles.join("/") || "roleless"} before reading work or replaying a confirmation`, async () => {
    const tx = {
      $queryRaw: async () => [],
      user: {
        findUnique: async () => ({
          isActive: true,
          mustChangePassword: false,
          roles: roles.map((role) => ({ role })),
          workParticipations: [{ id: "retained-typesetter" }],
        }),
      },
    };
    const db = {
      ...tx,
      $transaction: async (operation: (client: unknown) => unknown) =>
        operation(tx),
    };
    const service = new PublishingService(
      db as unknown as PrismaService,
      {} as FileObjectsService,
    );
    await assert.rejects(service.view("actor", "work"), ForbiddenException);
    await assert.rejects(
      service.readCurrentImages("actor", "work"),
      ForbiddenException,
    );
    await assert.rejects(
      service.confirm("actor", "work", {
        expectedRevision: 1,
        idempotencyKey: "previous-key",
      }),
      ForbiddenException,
    );
  });
}
