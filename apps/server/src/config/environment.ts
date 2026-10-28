import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { parseTrustedProxies } from "./trusted-proxies.js";

export interface Environment {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  databaseUrl: string;
  appOrigin: string;
  trustedProxyCidrs?: string[];
  galleryDl?: {
    python: string;
    xConfigPath?: string;
    pixivConfigPath?: string;
  };
  imageAnalysis?:
    | { adapter: "example" }
    | { adapter: "ba-pixai"; configFile: string }
    | { adapter: "external"; modulePath: string; configFile: string };
  xOfficialDailyBudget: number;
  xOfficialMonthlyBudget: number;
  sourceOverlapMinutes: number;
  sourceScheduleEnabled: boolean;
  sourceScheduleMinutes: number;
  sourceFailureThreshold: number;
  sourceCooldownMinutes: number;
  typesetBatchMaxBytes: number;
  typesetBatchMaxWorks: number;
  objectStorageDriver: "memory" | "local" | "r2";
  localStoragePath?: string;
  r2?: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    keyPrefix?: string;
  };
}

export const ENVIRONMENT = Symbol("ENVIRONMENT");
const workspaceRoot = fileURLToPath(new URL("../../../../", import.meta.url));

// Both src/config and dist/config resolve to the workspace root.
export function loadRootEnvironment(): void {
  const secretFile = process.env.COMIKU_ENV_FILE;
  if (secretFile && !isAbsolute(secretFile))
    throw new Error("COMIKU_ENV_FILE must be an absolute secret-file path.");
  const result = config({
    path:
      secretFile ?? fileURLToPath(new URL("../../../../.env", import.meta.url)),
    override: false,
    quiet: true,
  });
  if (
    result.error &&
    (secretFile || (result.error as NodeJS.ErrnoException).code !== "ENOENT")
  ) {
    throw new Error("Cannot read the environment file.");
  }
}

export function parseEnvironment(input: NodeJS.ProcessEnv): Environment {
  const nodeEnv = input.NODE_ENV ?? "development";
  if (!["development", "test", "production"].includes(nodeEnv)) {
    throw new Error("NODE_ENV must be development, test or production.");
  }
  const port = input.PORT ?? "3000";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  const host = input.HOST ?? "127.0.0.1";
  if (!host.trim() || host !== host.trim() || /[\s/]/.test(host)) {
    throw new Error("HOST must be a hostname or IP address.");
  }
  const databaseUrl = input.DATABASE_URL;
  const adapter = input.IMAGE_ANALYSIS_ADAPTER ?? "disabled";
  if (!["disabled", "example", "ba-pixai", "external"].includes(adapter))
    throw new Error(
      "IMAGE_ANALYSIS_ADAPTER must be disabled, example, ba-pixai or external.",
    );
  const modulePath = input.IMAGE_ANALYSIS_MODULE;
  const configFile = input.IMAGE_ANALYSIS_CONFIG_FILE;
  if (
    adapter === "external"
      ? !modulePath ||
        !configFile ||
        !isAbsolute(modulePath) ||
        !isAbsolute(configFile)
      : adapter === "ba-pixai"
        ? modulePath !== undefined || !configFile || !isAbsolute(configFile)
        : modulePath !== undefined || configFile !== undefined
  )
    throw new Error(
      "IMAGE_ANALYSIS requires an absolute config-file path for ba-pixai and absolute module/config-file paths for external adapters.",
    );
  const galleryPaths = [
    input.GALLERY_DL_PYTHON,
    input.GALLERY_DL_X_CONFIG,
    input.GALLERY_DL_PIXIV_CONFIG,
  ];
  if (
    galleryPaths.some(Boolean) &&
    (!galleryPaths[0] ||
      !galleryPaths.slice(1).some(Boolean) ||
      galleryPaths.some((path) => path && !isAbsolute(path)))
  ) {
    throw new Error(
      "gallery-dl requires an absolute Python path and platform config path.",
    );
  }
  const keyPrefix = input.R2_KEY_PREFIX?.trim() ?? "";
  if (
    keyPrefix &&
    (!/^(?:[a-zA-Z0-9_-]+\/)+$/.test(keyPrefix) || keyPrefix.length > 200)
  )
    throw new Error(
      "R2_KEY_PREFIX must contain safe directory segments and end with /.",
    );
  const integer = (name: string, fallback: number, minimum = 0) => {
    const value = input[name] ?? String(fallback);
    if (!/^\d+$/.test(value) || Number(value) < minimum) {
      throw new Error(`${name} must be an integer of at least ${minimum}.`);
    }
    return Number(value);
  };
  const appOrigin =
    input.APP_ORIGIN ??
    (nodeEnv === "production" ? "" : "http://localhost:5173");
  try {
    const origin = new URL(appOrigin);
    if (
      origin.origin !== appOrigin ||
      !["http:", "https:"].includes(origin.protocol) ||
      (nodeEnv === "production" && origin.protocol !== "https:")
    )
      throw new Error();
  } catch {
    throw new Error(
      "APP_ORIGIN must be an exact HTTP(S) origin; production requires HTTPS.",
    );
  }
  if (
    integer("TYPESET_BATCH_MAX_WORKS", 20, 1) > 20 ||
    integer("TYPESET_BATCH_MAX_MIB", 512, 1) > 1024
  ) {
    throw new Error(
      "Typeset batch limits must be at most 20 works and 1024 MiB.",
    );
  }
  const r2Names = [
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET",
  ] as const;
  const r2Values = r2Names.map((name) => input[name]?.trim() ?? "");
  const configured = r2Values.filter(Boolean).length;
  if (configured > 0 && configured < r2Names.length) {
    throw new Error("R2 configuration must provide all R2_* variables.");
  }
  if (nodeEnv === "production" && configured === 0) {
    throw new Error("Production requires complete R2 configuration.");
  }
  if (
    configured === r2Names.length &&
    (!/^[a-f0-9]{32}$/i.test(r2Values[0]) ||
      !/^[A-Za-z0-9._-]{3,255}$/.test(r2Values[3]))
  ) {
    throw new Error("R2_ACCOUNT_ID or R2_BUCKET is invalid.");
  }
  const requestedStorageDriver = input.OBJECT_STORAGE_DRIVER?.trim();
  if (
    requestedStorageDriver &&
    !["memory", "local", "r2"].includes(requestedStorageDriver)
  ) {
    throw new Error("OBJECT_STORAGE_DRIVER must be memory, local or r2.");
  }
  const objectStorageDriver = (requestedStorageDriver ??
    (nodeEnv === "test"
      ? "memory"
      : nodeEnv === "production" || configured === r2Names.length
        ? "r2"
        : "local")) as Environment["objectStorageDriver"];
  if (nodeEnv === "production" && objectStorageDriver !== "r2") {
    throw new Error("Production requires OBJECT_STORAGE_DRIVER=r2.");
  }
  if (objectStorageDriver === "r2" && configured !== r2Names.length) {
    throw new Error("R2 storage requires complete R2 configuration.");
  }
  if (objectStorageDriver === "memory" && nodeEnv !== "test") {
    throw new Error("Memory object storage is only available in tests.");
  }
  const configuredLocalPath =
    input.LOCAL_STORAGE_PATH?.trim() || ".comiku-data/objects";
  const localStoragePath = isAbsolute(configuredLocalPath)
    ? resolve(configuredLocalPath)
    : resolve(workspaceRoot, configuredLocalPath);
  try {
    const parsed = new URL(databaseUrl ?? "");
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.pathname.length <= 1
    ) {
      throw new Error();
    }
  } catch {
    // Never include the URL: it may contain credentials.
    throw new Error(
      "DATABASE_URL must be a PostgreSQL URL with a database name.",
    );
  }
  if (
    input.SOURCE_SCHEDULE_ENABLED &&
    !["true", "false"].includes(input.SOURCE_SCHEDULE_ENABLED)
  )
    throw new Error("SOURCE_SCHEDULE_ENABLED must be true or false.");
  return {
    ...(adapter === "example"
      ? { imageAnalysis: { adapter: "example" as const } }
      : adapter === "ba-pixai"
        ? {
            imageAnalysis: {
              adapter: "ba-pixai" as const,
              configFile: configFile!,
            },
          }
        : adapter === "external"
          ? {
              imageAnalysis: {
                adapter: "external" as const,
                modulePath: modulePath!,
                configFile: configFile!,
              },
            }
          : {}),
    ...(galleryPaths[0]
      ? {
          galleryDl: {
            python: galleryPaths[0],
            ...(galleryPaths[1] ? { xConfigPath: galleryPaths[1] } : {}),
            ...(galleryPaths[2] ? { pixivConfigPath: galleryPaths[2] } : {}),
          },
        }
      : {}),
    ...(input.TRUSTED_PROXY_CIDRS?.trim()
      ? { trustedProxyCidrs: parseTrustedProxies(input.TRUSTED_PROXY_CIDRS) }
      : {}),
    sourceScheduleEnabled: input.SOURCE_SCHEDULE_ENABLED === "true",
    sourceScheduleMinutes: integer("SOURCE_SCHEDULE_MINUTES", 60, 5),
    nodeEnv: nodeEnv as Environment["nodeEnv"],
    host,
    port: Number(port),
    databaseUrl: databaseUrl!,
    appOrigin,
    xOfficialDailyBudget: integer("X_OFFICIAL_DAILY_BUDGET", 0),
    xOfficialMonthlyBudget: integer("X_OFFICIAL_MONTHLY_BUDGET", 0),
    sourceOverlapMinutes: integer("SOURCE_OVERLAP_MINUTES", 10, 1),
    sourceFailureThreshold: integer("SOURCE_FAILURE_THRESHOLD", 3, 1),
    sourceCooldownMinutes: integer("SOURCE_COOLDOWN_MINUTES", 360, 1),
    typesetBatchMaxBytes:
      integer("TYPESET_BATCH_MAX_MIB", 512, 1) * 1024 * 1024,
    typesetBatchMaxWorks: integer("TYPESET_BATCH_MAX_WORKS", 20, 1),
    objectStorageDriver,
    ...(objectStorageDriver === "local" ? { localStoragePath } : {}),
    ...(configured === r2Names.length
      ? {
          r2: {
            accountId: r2Values[0],
            accessKeyId: r2Values[1],
            secretAccessKey: r2Values[2],
            bucket: r2Values[3],
            keyPrefix,
          },
        }
      : {}),
  };
}

export function loadEnvironment(): Environment {
  loadRootEnvironment();
  return parseEnvironment(process.env);
}
