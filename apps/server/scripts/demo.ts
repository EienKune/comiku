import "reflect-metadata";
import { readFile } from "node:fs/promises";
import { zipSync } from "fflate";
import { createApplication } from "../src/application.js";
import { CandidatesService } from "../src/candidates/candidates.service.js";
import { loadEnvironment } from "../src/config/environment.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { hashPassword } from "../src/users/password.js";

const username = "comikudemo";
const proofreaderUsername = "comikudemoproofreader";
const password = "ComikuDemo!2026";
const environment = loadEnvironment();
const database = new URL(environment.databaseUrl);
if (
  environment.nodeEnv !== "development" ||
  environment.objectStorageDriver !== "local" ||
  !["127.0.0.1", "localhost", "::1"].includes(database.hostname)
) {
  throw new Error(
    "demo:init 只允许在本机 development 数据库和 local 对象存储中运行。",
  );
}

const app = await createApplication(environment);
try {
  await app.init();
  const db = app.get(PrismaService);
  const candidates = app.get(CandidatesService);
  const [oldWorkCount, oldCandidateCount] = await Promise.all([
    db.work.count(),
    db.candidatePost.count(),
  ]);
  await db.$executeRaw`TRUNCATE TABLE "works", "candidate_posts", "candidate_upload_sessions" CASCADE`;
  const passwordHash = await hashPassword(password);
  const user = await db.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({ where: { username } });
    const saved = existing
      ? await tx.user.update({
          where: { id: existing.id },
          data: {
            displayName: "Comiku 演示成员",
            passwordHash,
            isActive: true,
            mustChangePassword: false,
            revision: { increment: 1 },
          },
        })
      : await tx.user.create({
          data: {
            username,
            displayName: "Comiku 演示成员",
            passwordHash,
            mustChangePassword: false,
          },
        });
    await tx.userRole.deleteMany({ where: { userId: saved.id } });
    await tx.userRole.createMany({
      data: ["source", "translator", "typesetter", "operator", "reviewer"].map(
        (role) => ({
          userId: saved.id,
          role: role as
            "source" | "translator" | "typesetter" | "operator" | "reviewer",
        }),
      ),
    });
    await tx.userLanguageCapability.deleteMany({ where: { userId: saved.id } });
    await tx.userLanguageCapability.createMany({
      data: ["ja", "ko"].map((language) => ({
        userId: saved.id,
        language: language as "ja" | "ko",
      })),
    });
    await tx.authSession.updateMany({
      where: { userId: saved.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return saved;
  });

  await db.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({
      where: { username: proofreaderUsername },
    });
    const saved = existing
      ? await tx.user.update({
          where: { id: existing.id },
          data: {
            displayName: "Comiku 演示校对",
            passwordHash,
            isActive: true,
            mustChangePassword: false,
            revision: { increment: 1 },
          },
        })
      : await tx.user.create({
          data: {
            username: proofreaderUsername,
            displayName: "Comiku 演示校对",
            passwordHash,
            mustChangePassword: false,
          },
        });
    await tx.userRole.deleteMany({ where: { userId: saved.id } });
    await tx.userRole.create({
      data: { userId: saved.id, role: "proofreader" },
    });
    await tx.userLanguageCapability.deleteMany({ where: { userId: saved.id } });
    await tx.userLanguageCapability.createMany({
      data: ["ja", "ko"].map((language) => ({
        userId: saved.id,
        language: language as "ja" | "ko",
      })),
    });
    await tx.authSession.updateMany({
      where: { userId: saved.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  });

  const tag = await db.tag.upsert({
    where: { normalizedName: "development-demo" },
    create: {
      name: "development-demo",
      normalizedName: "development-demo",
    },
    update: {},
  });
  let author = await db.author.findFirst({
    where: { tags: { some: { tagId: tag.id } }, deletedAt: null },
  });
  if (!author) {
    author = await db.author.create({
      data: {
        displayName: "Comiku 演示作者",
        authorizationStatus: "authorized",
        sourceLanguage: "ja",
        tags: { create: { tagId: tag.id } },
      },
    });
  } else {
    author = await db.author.update({
      where: { id: author.id },
      data: {
        displayName: "Comiku 演示作者",
        authorizationStatus: "authorized",
        sourceLanguage: "ja",
      },
    });
  }

  const sample = await readFile(
    new URL("../../web/public/samples/demo-work.png", import.meta.url),
  );
  const pending = await db.candidatePost.findMany({
    where: { authorId: author.id, platform: "manual", status: "pending" },
    select: { text: true },
  });
  const uploads = [];
  if (!pending.some((item) => item.text?.startsWith("单图"))) {
    uploads.push({
      input: { text: "单图候选" },
      file: {
        originalname: "demo-single.png",
        mimetype: "image/png",
        size: sample.byteLength,
        buffer: sample,
      },
    });
  }
  if (!pending.some((item) => item.text?.startsWith("三图"))) {
    const archive = Buffer.from(
      zipSync({
        "139/demo-page-03.png": sample,
        "139/demo-page-01.png": sample,
        "139/demo-page-02.png": sample,
      }),
    );
    uploads.push({
      input: { text: "三图 ZIP 候选" },
      file: {
        originalname: "demo-multi.zip",
        mimetype: "application/zip",
        size: archive.byteLength,
        buffer: archive,
      },
    });
  }
  for (const upload of uploads) {
    const result = await candidates.uploadManual(
      user.id,
      { authorId: author.id, ...upload.input },
      [upload.file],
    );
    const failed = result.results.find((item) => item.outcome === "failed");
    if (failed) throw new Error(failed.message ?? "演示候选创建失败");
  }

  console.log(
    [
      "开发演示数据已准备完成。",
      "登录地址：http://localhost:5173/login",
      "翻译及其他岗位账号：" + username,
      "校对账号：" + proofreaderUsername,
      "两者密码：" + password,
      `已清理 ${oldWorkCount} 个旧作品和 ${oldCandidateCount} 个旧候选。`,
      "候选池中已确保存在一个单图候选和一个三图 ZIP 候选。",
    ].join("\n"),
  );
} finally {
  await app.close();
}
