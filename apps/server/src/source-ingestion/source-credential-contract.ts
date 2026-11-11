import { createHash } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import type { CredentialInput } from "./adapters/gallery-dl/controlled-gallery-credentials.js";

export function maintenanceExpectation(input: {
  expectedEpoch?: unknown;
  expectedGeneration?: unknown;
}) {
  if (
    typeof input.expectedEpoch !== "number" ||
    !Number.isInteger(input.expectedEpoch) ||
    input.expectedEpoch < 0 ||
    input.expectedEpoch > 2147483647 ||
    typeof input.expectedGeneration !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.expectedGeneration)
  )
    throw new BadRequestException("平台维护版本无效，请重新读取状态。");
  return {
    expectedEpoch: input.expectedEpoch,
    expectedGeneration: input.expectedGeneration,
  };
}

export function credentialInput(
  platform: string,
  input: { authToken?: unknown; ct0?: unknown; refreshToken?: unknown },
): CredentialInput {
  const text = (value: unknown) => {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.length > 8192 ||
      /[\r\n\0]/.test(value)
    )
      throw new BadRequestException("请输入完整、有效的凭据字段。");
    return value.trim();
  };
  if (platform === "x" && input.refreshToken === undefined)
    return { platform, authToken: text(input.authToken), ct0: text(input.ct0) };
  if (
    platform === "pixiv" &&
    input.authToken === undefined &&
    input.ct0 === undefined
  )
    return { platform, refreshToken: text(input.refreshToken) };
  throw new BadRequestException("凭据字段与平台不匹配。");
}

export function credentialIntentHash(
  expected: ReturnType<typeof maintenanceExpectation>,
  input: CredentialInput,
) {
  const values =
    input.platform === "x"
      ? [input.platform, input.authToken, input.ct0]
      : [input.platform, input.refreshToken];
  return createHash("sha256")
    .update(
      JSON.stringify([
        expected.expectedEpoch,
        expected.expectedGeneration,
        values,
      ]),
    )
    .digest("hex");
}

export function credentialOperationReceipt(operation: {
  id: string;
  platform: string;
  requestId: string;
  phase: string;
  failureCode: string | null;
  expectedEpoch: number;
  expectedGeneration: string;
  targetGeneration: string | null;
  verificationOutcome: string | null;
  verificationCode: string | null;
  verifiedAt: Date | null;
  createdAt: Date;
  completedAt: Date | null;
  [key: string]: unknown;
}) {
  return {
    id: operation.id,
    platform: operation.platform,
    requestId: operation.requestId,
    phase: operation.phase,
    failureCode: operation.failureCode,
    expectedEpoch: operation.expectedEpoch,
    expectedGeneration: operation.expectedGeneration,
    targetGeneration: operation.targetGeneration,
    verificationOutcome: operation.verificationOutcome,
    verificationCode: operation.verificationCode,
    verifiedAt: operation.verifiedAt?.toISOString() ?? null,
    createdAt: operation.createdAt.toISOString(),
    completedAt: operation.completedAt?.toISOString() ?? null,
  };
}
