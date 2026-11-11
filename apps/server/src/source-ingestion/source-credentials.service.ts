import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ENVIRONMENT, type Environment } from "../config/environment.js";
import { PrismaService } from "../database/prisma.service.js";
import type {
  Prisma,
  SourceCredentialChangeOperation,
} from "../generated/prisma/client.js";
import {
  ControlledGalleryCredentials,
  CredentialFileError,
  type CredentialInput,
  type CredentialPlatform,
} from "./adapters/gallery-dl/controlled-gallery-credentials.js";
import {
  credentialInput,
  credentialIntentHash,
  credentialOperationReceipt,
  maintenanceExpectation,
} from "./source-credential-contract.js";
import type {
  SourceCredentialInputDto,
  SourceMaintenanceDto,
  SourceMaintenanceExpectedDto,
} from "./source-credentials.dto.js";
import { SourceFetchService } from "./source-fetch.service.js";
import { ContentSourceRegistry } from "./source-registry.js";
import { SourceResponseError } from "./source-response.js";

const activePhases = ["preparing", "prepared", "promoted", "blocked"];
type Expected = ReturnType<typeof maintenanceExpectation>;
type Tx = Prisma.TransactionClient;

@Injectable()
export class SourceCredentialsService {
  private readonly store: ControlledGalleryCredentials | null;
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(SourceFetchService) private readonly sources: SourceFetchService,
    @Inject(ContentSourceRegistry)
    private readonly registry: ContentSourceRegistry,
    @Inject(ENVIRONMENT) private readonly environment: Environment,
  ) {
    this.store =
      environment.sourceCredentialsStateDirectory && environment.galleryDl
        ? new ControlledGalleryCredentials({
            stateDirectory: environment.sourceCredentialsStateDirectory,
            configPaths: {
              x: environment.galleryDl.xConfigPath,
              pixiv: environment.galleryDl.pixivConfigPath,
            },
          })
        : null;
  }
  private platform(value: string): CredentialPlatform {
    if (value !== "x" && value !== "pixiv")
      throw new BadRequestException("不支持的图源平台。");
    return value;
  }
  private files() {
    if (!this.store)
      throw new ConflictException(
        "在线凭据维护未启用，请由管理员检查部署配置。",
      );
    return this.store;
  }
  private expected(operation: SourceCredentialChangeOperation): Expected {
    return {
      expectedEpoch: operation.expectedEpoch,
      expectedGeneration: operation.expectedGeneration,
    };
  }
  private async actor(tx: Tx, actorId: string, platform: string) {
    await this.sources.platforms.lockMaintenance(tx, platform);
    await this.sources.platforms.actor(tx, actorId, "system:manage");
  }
  async status(value: string): Promise<SourceMaintenanceDto> {
    const platform = this.platform(value);
    const [status, state, operation, lastOperation] = await Promise.all([
      this.sources.platforms.maintenanceStatus(platform),
      this.db.sourcePlatformState.findUnique({ where: { platform } }),
      this.db.sourceCredentialChangeOperation.findFirst({
        where: { platform, phase: { in: activePhases } },
        orderBy: { createdAt: "desc" },
      }),
      this.db.sourceCredentialChangeOperation.findFirst({
        where: { platform },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    let supported = false,
      readonlyReason: string | null = "not_enabled";
    if (this.store) {
      try {
        await this.store.inspect(platform);
        supported = true;
        readonlyReason = null;
      } catch (error) {
        readonlyReason =
          error instanceof CredentialFileError ? error.code : "unavailable";
      }
    }
    const drained = await this.db.$transaction((tx) =>
      this.sources.platforms.drained(tx, platform, new Date()),
    );
    return {
      ...status,
      supported,
      readonlyReason,
      canSave:
        supported &&
        status.maintenancePaused &&
        drained &&
        status.unsettledExecutions === 0 &&
        !operation,
      authStatus: state?.status ?? "unverified",
      errorCode: state?.errorCode ?? null,
      cooldownUntil: state?.cooldownUntil?.toISOString() ?? null,
      activeOperation: operation ? credentialOperationReceipt(operation) : null,
      lastOperation: lastOperation
        ? credentialOperationReceipt(lastOperation)
        : null,
    };
  }
  async pause(
    value: string,
    actorId: string,
    input: SourceMaintenanceExpectedDto,
  ) {
    const platform = this.platform(value);
    this.files();
    await this.files().inspect(platform);
    await this.sources.platforms.pauseMaintenance(
      platform,
      actorId,
      maintenanceExpectation(input),
    );
    return this.status(platform);
  }
  async resume(
    value: string,
    actorId: string,
    input: SourceMaintenanceExpectedDto,
  ) {
    const platform = this.platform(value);
    await this.sources.platforms.resumeMaintenance(
      platform,
      actorId,
      maintenanceExpectation(input),
    );
    return this.status(platform);
  }
  async receipt(value: string, actorId: string, id: string) {
    const platform = this.platform(value);
    return this.db.$transaction(async (tx) => {
      // Reading a receipt never creates material, verifies a platform, or repairs a job.
      await this.sources.platforms.actor(tx, actorId, "system:manage");
      const operation = await tx.sourceCredentialChangeOperation.findFirst({
        where: { id, platform },
      });
      if (!operation) throw new NotFoundException("凭据更新记录不存在。");
      return credentialOperationReceipt(operation);
    });
  }
  async save(value: string, actorId: string, input: SourceCredentialInputDto) {
    const platform = this.platform(value),
      expected = maintenanceExpectation(input),
      secrets = credentialInput(platform, input);
    const hash = credentialIntentHash(expected, secrets);
    this.files();
    const previous = await this.db.$transaction(async (tx) => {
      await this.actor(tx, actorId, platform);
      return tx.sourceCredentialChangeOperation.findUnique({
        where: { actorId_requestId: { actorId, requestId: input.requestId } },
      });
    });
    if (previous) {
      if (previous.platform !== platform || previous.inputHash !== hash)
        throw new ConflictException("同一更新请求不能更换凭据或维护版本。");
      if (previous.phase === "activated" || previous.phase === "aborted")
        return credentialOperationReceipt(previous);
      return this.finish(previous, actorId, secrets);
    }
    // Configuration and file-policy errors are rejected before creating an
    // unresolved intent. Committed replay above is independent of current files.
    await this.files().inspect(platform);
    if (
      (await this.sources.platforms.fingerprint(platform)) !==
      expected.expectedGeneration
    )
      throw new ConflictException("凭据文件已变化，请重新读取平台状态。");
    const operation = await this.db.$transaction(async (tx) => {
      await this.actor(tx, actorId, platform);
      const previous = await tx.sourceCredentialChangeOperation.findUnique({
        where: { actorId_requestId: { actorId, requestId: input.requestId } },
      });
      if (previous) {
        if (previous.platform !== platform || previous.inputHash !== hash)
          throw new ConflictException("同一更新请求不能更换凭据或维护版本。");
        return previous;
      }
      await this.sources.platforms.assertMaintenance(
        tx,
        platform,
        expected,
        actorId,
      );
      return tx.sourceCredentialChangeOperation.create({
        data: {
          id: randomUUID(),
          platform,
          actorId,
          requestId: input.requestId,
          inputHash: hash,
          expectedEpoch: expected.expectedEpoch,
          expectedGeneration: expected.expectedGeneration,
          phase: "preparing",
        },
      });
    });
    if (operation.phase === "activated" || operation.phase === "aborted")
      return credentialOperationReceipt(operation);
    return this.finish(operation, actorId, secrets);
  }
  async reconcile(
    value: string,
    actorId: string,
    id: string,
    input: SourceMaintenanceExpectedDto,
  ) {
    const platform = this.platform(value),
      expected = maintenanceExpectation(input);
    const operation = await this.db.$transaction(async (tx) => {
      await this.actor(tx, actorId, platform);
      const op = await tx.sourceCredentialChangeOperation.findFirst({
        where: { id, platform },
      });
      if (!op) throw new NotFoundException("凭据更新记录不存在。");
      if (
        op.expectedEpoch !== expected.expectedEpoch ||
        ![op.expectedGeneration, op.targetGeneration].includes(
          expected.expectedGeneration,
        )
      )
        throw new ConflictException("更新回执与当前维护版本不一致。");
      return op;
    });
    if (operation.phase === "activated" || operation.phase === "aborted")
      return credentialOperationReceipt(operation);
    return this.finish(operation, actorId);
  }
  private async phase(
    operation: SourceCredentialChangeOperation,
    actorId: string,
    next?: string,
  ) {
    return this.db.$transaction(async (tx) => {
      await this.sources.platforms.assertMaintenance(
        tx,
        operation.platform,
        this.expected(operation),
        actorId,
        operation.id,
      );
      const op = await tx.sourceCredentialChangeOperation.findUniqueOrThrow({
        where: { id: operation.id },
      });
      if (op.phase === "activated" || op.phase === "aborted") return op;
      if (!next) return op;
      return tx.sourceCredentialChangeOperation.update({
        where: { id: operation.id },
        data: { phase: next, failureCode: null },
      });
    });
  }
  private async finish(
    operation: SourceCredentialChangeOperation,
    actorId: string,
    secrets?: CredentialInput,
  ) {
    const files = this.files(),
      platform = this.platform(operation.platform);
    try {
      // A durable unresolved operation keeps resume and other update intents out
      // while bounded filesystem work happens outside database transactions.
      let op = await this.phase(operation, actorId);
      if (op.phase === "activated" || op.phase === "aborted")
        return credentialOperationReceipt(op);
      try {
        await files.recover(op.id);
      } catch (error) {
        if (
          !(error instanceof CredentialFileError) ||
          error.code !== "material_missing" ||
          !secrets
        )
          throw error;
        if (
          (await this.sources.platforms.fingerprint(platform)) !==
          op.expectedGeneration
        )
          throw new CredentialFileError("baseline_changed");
        const { baselineDigest } = await files.inspect(platform);
        if (
          (await this.sources.platforms.fingerprint(platform)) !==
          op.expectedGeneration
        )
          throw new CredentialFileError("baseline_changed");
        await files.prepare(op.id, platform, baselineDigest, secrets);
      }
      op = await this.phase(op, actorId, "prepared");
      if (op.phase === "activated" || op.phase === "aborted")
        return credentialOperationReceipt(op);
      await files.promote(op.id);
      if ((await files.recover(op.id)).state !== "promoted")
        throw new CredentialFileError("baseline_changed");
      const generation = await this.sources.platforms.fingerprint(platform);
      if (!generation) throw new CredentialFileError("invalid_configuration");
      if (
        (await files.recover(op.id)).state !== "promoted" ||
        (await this.sources.platforms.fingerprint(platform)) !== generation
      )
        throw new CredentialFileError("baseline_changed");
      return await this.db.$transaction(async (tx) => {
        await this.actor(tx, actorId, platform);
        const current =
          await tx.sourceCredentialChangeOperation.findUniqueOrThrow({
            where: { id: op.id },
          });
        if (current.phase === "activated" || current.phase === "aborted")
          return credentialOperationReceipt(current);
        await this.sources.platforms.activateMaintenance(
          tx,
          platform,
          actorId,
          this.expected(op),
          generation,
          op.id,
        );
        const done = await tx.sourceCredentialChangeOperation.update({
          where: { id: op.id },
          data: {
            phase: "activated",
            targetGeneration: generation,
            failureCode: null,
            completedAt: new Date(),
          },
        });
        return credentialOperationReceipt(done);
      });
    } catch (error) {
      // Lost commit replies may already have a terminal receipt. Never regress it.
      const current = await this.db.sourceCredentialChangeOperation
        .findUnique({ where: { id: operation.id } })
        .catch(() => null);
      if (current?.phase === "activated" || current?.phase === "aborted")
        return this.receipt(platform, actorId, operation.id);
      const code =
        error instanceof CredentialFileError
          ? error.code
          : "update_outcome_unknown";
      // A failed prepare with no published material must remain cancellable.
      // Once material exists, an unknown outcome must be reconciled instead.
      let missingMaterial = false;
      try {
        await files.recover(operation.id);
      } catch (recoveryError) {
        missingMaterial =
          recoveryError instanceof CredentialFileError &&
          recoveryError.code === "material_missing";
      }
      await this.db
        .$transaction(async (tx) => {
          await this.actor(tx, actorId, platform);
          await tx.sourceCredentialChangeOperation.updateMany({
            where: {
              id: operation.id,
              phase: missingMaterial ? "preparing" : { in: activePhases },
            },
            data: {
              phase: missingMaterial ? "preparing" : "blocked",
              failureCode: code,
            },
          });
        })
        .catch(() => undefined);
      throw new ConflictException({
        message:
          code === "material_missing"
            ? "更新尚未准备，请重新提交原请求或取消未开始的更新。"
            : "凭据更新尚未确认，请查询或继续原操作。",
        code,
        operationId: operation.id,
      });
    }
  }
  async abortUnprepared(
    value: string,
    actorId: string,
    id: string,
    input: SourceMaintenanceExpectedDto,
  ) {
    const platform = this.platform(value),
      expected = maintenanceExpectation(input),
      files = this.files();
    // Only an intent that has never published recovery material may be aborted.
    // Prepared/promoted material must be reconciled, not discarded by the UI.
    try {
      await files.recover(id);
      throw new ConflictException("更新材料已准备，请继续原操作。");
    } catch (error) {
      if (
        !(error instanceof CredentialFileError) ||
        error.code !== "material_missing"
      )
        throw error;
    }
    if (
      (await this.sources.platforms.fingerprint(platform)) !==
      expected.expectedGeneration
    )
      throw new ConflictException("凭据文件已变化，不能取消更新。");
    return this.db.$transaction(async (tx) => {
      await this.sources.platforms.assertMaintenance(
        tx,
        platform,
        expected,
        actorId,
        id,
      );
      const op = await tx.sourceCredentialChangeOperation.findFirst({
        where: { id, platform },
      });
      if (!op) throw new NotFoundException("凭据更新记录不存在。");
      if (
        op.phase !== "preparing" ||
        op.expectedEpoch !== expected.expectedEpoch ||
        op.expectedGeneration !== expected.expectedGeneration
      )
        throw new ConflictException("更新已经开始，请继续原操作。");
      return credentialOperationReceipt(
        await tx.sourceCredentialChangeOperation.update({
          where: { id },
          data: { phase: "aborted", completedAt: new Date() },
        }),
      );
    });
  }
  async verify(
    value: string,
    actorId: string,
    id: string,
    input: SourceMaintenanceExpectedDto,
  ) {
    const platform = this.platform(value),
      expected = maintenanceExpectation(input);
    const op = await this.db.$transaction(async (tx) => {
      await this.sources.platforms.assertMaintenance(
        tx,
        platform,
        expected,
        actorId,
      );
      const op = await tx.sourceCredentialChangeOperation.findFirst({
        where: {
          id,
          platform,
          phase: "activated",
          targetGeneration: expected.expectedGeneration,
        },
      });
      if (!op) throw new NotFoundException("当前凭据更新记录不存在。");
      return op;
    });
    const account = await this.db.authorExternalAccount.findFirst({
      where: { platform, deletedAt: null, author: { deletedAt: null } },
      select: { externalUserId: true },
    });
    let verificationOutcome = "unknown",
      verificationCode: string | null = "no_verification_target";
    const adapter = this.registry
      .forPlatform(platform)
      .find((source) => source.available);
    if (account && adapter) {
      try {
        await this.sources.platforms.runMaintenanceValidation(
          platform,
          actorId,
          expected,
          async () => {
            const result = await adapter.checkAccount({
              externalUserId: account.externalUserId,
            });
            if (result.externalUserId !== account.externalUserId)
              throw new SourceResponseError("invalid_response", {
                reason: "source_identity_conflict",
                scope: "source",
              });
          },
        );
        verificationOutcome = "passed";
        verificationCode = null;
      } catch (error) {
        if (error instanceof SourceResponseError) {
          verificationCode = error.details?.reason ?? "unknown_failure";
          if (
            error.details?.scope === "credential" &&
            ["auth_failed", "challenge_required", "request_http_401"].includes(
              verificationCode,
            )
          )
            verificationOutcome = "failed";
        } else verificationCode = "verification_unavailable";
      }
    }
    return this.db.$transaction(async (tx) => {
      await this.sources.platforms.assertMaintenance(
        tx,
        platform,
        expected,
        actorId,
      );
      return credentialOperationReceipt(
        await tx.sourceCredentialChangeOperation.update({
          where: { id: op.id },
          data: {
            verificationOutcome,
            verificationCode,
            verifiedAt: new Date(),
          },
        }),
      );
    });
  }
}
