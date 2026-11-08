import "reflect-metadata";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { createApplication } from "../../src/application.js";
import {
  loadRootEnvironment,
  parseEnvironment,
} from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { tokenHash } from "../../src/users/password.js";

loadRootEnvironment();
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("_test"))
  throw Error("Isolated TEST_DATABASE_URL required");

test("authenticated candidate live pagination rejects malformed UUID cursors with explicit HTTP 400", async () => {
  const app = await createApplication(
    parseEnvironment({ NODE_ENV: "test", DATABASE_URL: url }),
  );
  await app.listen(0, "127.0.0.1");
  const db = app.get(PrismaService);
  let actorId = "",
    authorId = "";
  try {
    const actor = await db.user.create({
      data: {
        username: `cursor_${randomUUID()}`,
        displayName: "Synthetic source",
        passwordHash: "disabled",
        mustChangePassword: false,
        roles: { create: { role: "source" } },
      },
    });
    actorId = actor.id;
    const token = randomBytes(32).toString("base64url");
    await db.authSession.create({
      data: {
        userId: actor.id,
        tokenHash: tokenHash(token),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const author = await db.author.create({
      data: {
        displayName: "Synthetic cursor author",
        authorizationStatus: "authorized",
      },
    });
    authorId = author.id;
    await db.candidatePost.createMany({
      data: [0, 1].map(() => ({
        authorId: author.id,
        platform: "synthetic-cursor",
        externalPostId: randomUUID(),
        postedAt: new Date(),
        rawJson: {},
      })),
    });
    const base = await app.getUrl();
    const query = new URLSearchParams({ authorId: author.id, limit: "1" });
    const headers = { Cookie: `comiku_session=${token}` };
    const first = await fetch(`${base}/api/candidates?${query}`, { headers });
    assert.equal(first.status, 200);
    const page = (await first.json()) as { nextCursor: string };
    assert.ok(page.nextCursor);
    const body = JSON.parse(
      Buffer.from(page.nextCursor, "base64url").toString(),
    );
    for (const id of [
      "a".repeat(36),
      "-".repeat(36),
      "000000000-000-4000-8000-000000000000",
    ]) {
      query.set(
        "cursor",
        Buffer.from(JSON.stringify({ ...body, id })).toString("base64url"),
      );
      const response = await fetch(`${base}/api/candidates?${query}`, {
        headers,
      });
      assert.equal(response.status, 400);
      assert.match(JSON.stringify(await response.json()), /游标/);
    }
  } finally {
    if (authorId) {
      await db.candidatePost.deleteMany({ where: { authorId } });
      await db.author.delete({ where: { id: authorId } });
    }
    if (actorId) {
      await db.authSession.deleteMany({ where: { userId: actorId } });
      await db.userRole.deleteMany({ where: { userId: actorId } });
      await db.user.delete({ where: { id: actorId } });
    }
    await app.close();
  }
});
