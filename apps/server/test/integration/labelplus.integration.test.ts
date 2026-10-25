import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../src/app.module.js";
import { configureApplication } from "../../src/application.js";
import {
  loadRootEnvironment,
  parseEnvironment,
} from "../../src/config/environment.js";
import { PrismaService } from "../../src/database/prisma.service.js";
import { FileObjectsService } from "../../src/files/file-objects.service.js";
import { parseLabelPlus } from "../../src/labelplus/labelplus-codec.js";
import { hashPassword } from "../../src/users/password.js";

loadRootEnvironment();
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith("_test")) {
  throw new Error(
    "TEST_DATABASE_URL must point to a disposable _test database.",
  );
}

type Browser = { cookie?: string };

test("LabelPlus preview, atomic import, export and download round trip", async () => {
  const prefix = randomUUID().slice(0, 8);
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.forRoot(
        parseEnvironment({ NODE_ENV: "test", DATABASE_URL: testUrl }),
      ),
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  configureApplication(app);
  const db = app.get(PrismaService);
  const files = app.get(FileObjectsService);
  const password = "labelplus-password-12345";
  const userIds: string[] = [];
  let workId = "";
  let candidateId = "";
  let accountId = "";
  let authorId = "";
  let base = "";

  async function jsonRequest<T>(
    browser: Browser,
    method: string,
    path: string,
    body?: object,
  ) {
    const response = await fetch(base + path, {
      method,
      headers: {
        Origin: "http://localhost:5173",
        "X-Comiku-Request": "1",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(browser.cookie ? { Cookie: browser.cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const cookie = response.headers.get("set-cookie");
    if (cookie) browser.cookie = cookie.split(";")[0];
    return { status: response.status, data: (await response.json()) as T };
  }

  async function multipartRequest<T>(
    browser: Browser,
    path: string,
    fileText: string,
    fields: Record<string, string> = {},
  ) {
    const body = new FormData();
    body.append(
      "file",
      new Blob([fileText], { type: "text/plain" }),
      "fixture.txt",
    );
    for (const [key, value] of Object.entries(fields)) body.append(key, value);
    const response = await fetch(base + path, {
      method: "POST",
      headers: {
        Origin: "http://localhost:5173",
        "X-Comiku-Request": "1",
        ...(browser.cookie ? { Cookie: browser.cookie } : {}),
      },
      body,
    });
    return { status: response.status, data: (await response.json()) as T };
  }

  async function createBrowser(
    suffix: string,
    role: "translator" | "operator",
  ) {
    const user = await db.user.create({
      data: {
        username: `label_${prefix}_${suffix}`,
        displayName: suffix,
        passwordHash: await hashPassword(password),
        mustChangePassword: false,
        roles: { create: { role } },
        languageCapabilities: {
          create: [{ language: "ja" }, { language: "ko" }],
        },
      },
    });
    userIds.push(user.id);
    const browser: Browser = {};
    assert.equal(
      (
        await jsonRequest(browser, "POST", "/api/auth/login", {
          username: user.username,
          password,
        })
      ).status,
      200,
    );
    return { browser, user };
  }

  try {
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
    const translator = await createBrowser("translator", "translator");
    const operator = await createBrowser("operator", "operator");
    const author = await db.author.create({
      data: { displayName: `LabelPlus 作者 ${prefix}` },
    });
    authorId = author.id;
    const account = await db.authorExternalAccount.create({
      data: {
        authorId,
        platform: "fixture",
        externalUserId: `labelplus-${prefix}`,
      },
    });
    accountId = account.id;
    const originals = await Promise.all([
      files.store({
        body: new Uint8Array([1]),
        contentType: "image/png",
        bucketScope: "source",
        kind: "candidate-media",
        createdById: translator.user.id,
      }),
      files.store({
        body: new Uint8Array([2]),
        contentType: "image/jpeg",
        bucketScope: "source",
        kind: "candidate-media",
        createdById: translator.user.id,
      }),
    ]);
    const candidate = await db.candidatePost.create({
      data: {
        authorId,
        authorExternalAccountId: accountId,
        platform: "fixture",
        externalPostId: `labelplus-post-${prefix}`,
        externalPostUrl: `https://fixture.invalid/${prefix}`,
        postedAt: new Date(),
        rawJson: { fixture: true },
      },
    });
    candidateId = candidate.id;
    const work = await db.work.create({
      data: {
        authorId,
        sourceCandidatePostId: candidateId,
        sourcePostUrl: candidate.externalPostUrl,
        title: "LabelPlus 往返测试",
        workflowStatus: "translating",
        importedById: translator.user.id,
        images: {
          create: originals.map((file, orderIndex) => ({
            originalFileObjectId: file.id,
            orderIndex,
          })),
        },
        stageParticipants: {
          create: {
            stage: "translate",
            userId: translator.user.id,
            participationMode: "owner",
          },
        },
      },
    });
    workId = work.id;

    const labelPlus = [
      "1,0",
      "-",
      "框内",
      "框外",
      "-",
      "",
      ">>>>>>>>[任意来源第一页.png]<<<<<<<<",
      "",
      "----------------[3]----------------[0.25,0.375,1]",
      "第一行",
      "第二行",
      "",
      ">>>>>>>>[任意来源第二页.jpg]<<<<<<<<",
    ].join("\r\n");
    const preview = await multipartRequest<{
      canImport: boolean;
      imageCount: number;
      markerCount: number;
      warnings: { code: string }[];
      mappings: { targetFileName: string }[];
    }>(
      translator.browser,
      `/api/works/${workId}/labelplus/imports/preview`,
      labelPlus,
    );
    assert.equal(preview.status, 200);
    assert.equal(preview.data.canImport, true);
    assert.equal(preview.data.imageCount, 2);
    assert.equal(preview.data.markerCount, 1);
    assert.deepEqual(
      preview.data.mappings.map(({ targetFileName }) => targetFileName),
      [`${work.workNumber}-001.png`, `${work.workNumber}-002.jpg`],
    );
    assert.deepEqual(
      preview.data.warnings.map(({ code }) => code),
      ["non_sequential_marker_number"],
    );

    const importKey = randomUUID();
    const imported = await multipartRequest<{
      workRevision: number;
      editorEpoch: number;
      latestVersion: { kind: string; versionNumber: number };
      images: { entries: { translatedText: string }[] }[];
    }>(
      translator.browser,
      `/api/works/${workId}/labelplus/imports`,
      labelPlus,
      {
        stage: "translate",
        expectedRevision: "0",
        expectedEditorEpoch: "0",
        idempotencyKey: importKey,
      },
    );
    assert.equal(imported.status, 200);
    assert.equal(imported.data.workRevision, 1);
    assert.equal(imported.data.editorEpoch, 1);
    assert.equal(imported.data.latestVersion.kind, "labelplus_import");
    assert.equal(
      imported.data.images[0].entries[0].translatedText,
      "第一行\n第二行",
    );
    assert.equal(imported.data.images[1].entries.length, 0);

    const replayed = await multipartRequest<{ editorEpoch: number }>(
      translator.browser,
      `/api/works/${workId}/labelplus/imports`,
      labelPlus,
      {
        stage: "translate",
        expectedRevision: "0",
        expectedEditorEpoch: "0",
        idempotencyKey: importKey,
      },
    );
    assert.equal(replayed.status, 200);
    assert.equal(replayed.data.editorEpoch, 1);
    assert.equal(
      await db.labelPlusFile.count({ where: { workId, direction: "import" } }),
      1,
    );
    const staleImport = await multipartRequest<{ statusCode: number }>(
      translator.browser,
      `/api/works/${workId}/labelplus/imports`,
      labelPlus,
      {
        stage: "translate",
        expectedRevision: "0",
        expectedEditorEpoch: "0",
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(staleImport.status, 409);

    const exportKey = randomUUID();
    const exported = await jsonRequest<{
      fileId: string;
      fileName: string;
      downloadUrl: string;
      imageCount: number;
      markerCount: number;
    }>(translator.browser, "POST", `/api/works/${workId}/labelplus/exports`, {
      expectedRevision: 1,
      expectedEditorEpoch: 1,
      idempotencyKey: exportKey,
    });
    assert.equal(exported.status, 200);
    assert.equal(exported.data.fileName, `${work.workNumber}_翻译.txt`);
    assert.equal(exported.data.imageCount, 2);
    assert.equal(exported.data.markerCount, 1);
    const download = await fetch(base + exported.data.downloadUrl, {
      headers: { Cookie: translator.browser.cookie! },
    });
    assert.equal(download.status, 200);
    assert.match(
      download.headers.get("content-disposition") ?? "",
      /attachment/,
    );
    const reparsed = parseLabelPlus(
      new Uint8Array(await download.arrayBuffer()),
    );
    assert.deepEqual(
      reparsed.document.images.map((image) => image.fileName),
      [`${work.workNumber}-001.png`, `${work.workNumber}-002.jpg`],
    );
    assert.equal(
      reparsed.document.images[0].markers[0].translation,
      "第一行\n第二行",
    );
    assert.equal(reparsed.document.images[1].markers.length, 0);

    const replayedExport = await jsonRequest<{ fileId: string }>(
      translator.browser,
      "POST",
      `/api/works/${workId}/labelplus/exports`,
      {
        expectedRevision: 1,
        expectedEditorEpoch: 1,
        idempotencyKey: exportKey,
      },
    );
    assert.equal(replayedExport.status, 200);
    assert.equal(replayedExport.data.fileId, exported.data.fileId);
    assert.equal(
      (
        await jsonRequest(
          operator.browser,
          "POST",
          `/api/works/${workId}/labelplus/exports`,
          {
            expectedRevision: 1,
            expectedEditorEpoch: 1,
            idempotencyKey: randomUUID(),
          },
        )
      ).status,
      403,
    );

    const openedReview = await jsonRequest<{
      id: string;
      reviewStatus: string;
      workRevision: number;
    }>(translator.browser, "POST", `/api/works/${workId}/reviews`, {
      reason: "确认导入内容后再继续",
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    assert.equal(openedReview.status, 200);
    assert.equal(openedReview.data.reviewStatus, "needs_review");
    assert.equal(openedReview.data.workRevision, 2);
    const blockedEditor = await jsonRequest<{
      reviewStatus: string;
      openReviewCase: { id: string; reason: string } | null;
    }>(translator.browser, "GET", `/api/works/${workId}/translations`);
    assert.equal(blockedEditor.status, 200);
    assert.equal(blockedEditor.data.reviewStatus, "needs_review");
    assert.equal(blockedEditor.data.openReviewCase?.id, openedReview.data.id);
    assert.equal(
      blockedEditor.data.openReviewCase?.reason,
      "确认导入内容后再继续",
    );
    const blockedImport = await multipartRequest<{ statusCode: number }>(
      translator.browser,
      `/api/works/${workId}/labelplus/imports`,
      labelPlus,
      {
        stage: "translate",
        expectedRevision: "2",
        expectedEditorEpoch: "1",
        idempotencyKey: randomUUID(),
      },
    );
    assert.equal(blockedImport.status, 409);
    assert.equal(
      await db.labelPlusFile.count({ where: { workId, direction: "import" } }),
      1,
    );
  } finally {
    if (workId) {
      await db.workEvent.deleteMany({ where: { workId } });
      await db.labelPlusFile.deleteMany({ where: { workId } });
      await db.translationVersion.deleteMany({ where: { workId } });
      await db.workReviewCase.deleteMany({ where: { workId } });
      await db.translationEntry.deleteMany({
        where: { workImage: { workId } },
      });
      await db.workStageParticipant.deleteMany({ where: { workId } });
      await db.workImage.deleteMany({ where: { workId } });
      await db.work.deleteMany({ where: { id: workId } });
    }
    if (candidateId)
      await db.candidatePost.deleteMany({ where: { id: candidateId } });
    if (accountId)
      await db.authorExternalAccount.deleteMany({ where: { id: accountId } });
    if (authorId) await db.author.deleteMany({ where: { id: authorId } });
    await db.fileObject.deleteMany({ where: { createdById: { in: userIds } } });
    await db.authSession.deleteMany({ where: { userId: { in: userIds } } });
    await db.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await db.userLanguageCapability.deleteMany({
      where: { userId: { in: userIds } },
    });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
  }
});
