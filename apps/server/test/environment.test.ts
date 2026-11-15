import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEnvironment } from "../src/config/environment.js";

const databaseUrl = "postgresql://test:secret@127.0.0.1:5432/comiku_test";

test("archive export is opt-in and bounds buffers, capacity and time independently", () => {
  const defaults = parseEnvironment({
    DATABASE_URL: databaseUrl,
  }).archiveExports;
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.partSizeBytes, 16 * 2 ** 20);
  assert.equal(defaults.uploadConcurrency, 1);
  assert.equal(defaults.packageTargetBytes, 2 ** 31);
  assert.equal(defaults.maxActiveRuns, 1);
  assert.equal(defaults.retentionDays, 7);
  assert.equal(
    parseEnvironment({
      DATABASE_URL: databaseUrl,
      ARCHIVE_EXPORT_ENABLED: "true",
    }).archiveExports.enabled,
    true,
  );
  for (const [key, value] of [
    ["ARCHIVE_EXPORT_ENABLED", "1"],
    ["ARCHIVE_EXPORT_PART_BYTES", "1048576"],
    ["ARCHIVE_EXPORT_PART_BYTES", "67108864"],
    ["ARCHIVE_EXPORT_UPLOAD_CONCURRENCY", "3"],
    ["ARCHIVE_EXPORT_MAX_ENTRIES", "0"],
    ["ARCHIVE_EXPORT_PACKAGE_BYTES", "Infinity"],
    ["ARCHIVE_EXPORT_MAX_RUN_BYTES", "9007199254740993"],
    ["ARCHIVE_EXPORT_RETENTION_DAYS", "0"],
    ["ARCHIVE_EXPORT_DEADLINE_HOURS", "1000"],
  ]) {
    assert.throws(
      () => parseEnvironment({ DATABASE_URL: databaseUrl, [key!]: value }),
      /ARCHIVE_EXPORT_/,
    );
  }
  assert.throws(
    () =>
      parseEnvironment({
        DATABASE_URL: databaseUrl,
        ARCHIVE_EXPORT_CACHE_BYTES: String(2 ** 30),
      }),
    /must not exceed/,
  );
});

test("birthday integration is explicitly opt-in", () => {
  assert.equal(
    parseEnvironment({ DATABASE_URL: databaseUrl }).birthdays,
    undefined,
  );
  assert.deepEqual(
    parseEnvironment({ DATABASE_URL: databaseUrl, BIRTHDAYS_ENABLED: "true" })
      .birthdays,
    { enabled: true },
  );
  assert.deepEqual(
    parseEnvironment({ DATABASE_URL: databaseUrl, BIRTHDAYS_ENABLED: "false" })
      .birthdays,
    { enabled: false },
  );
  for (const value of ["", "1", "TRUE", "false "]) {
    assert.throws(
      () =>
        parseEnvironment({
          DATABASE_URL: databaseUrl,
          BIRTHDAYS_ENABLED: value,
        }),
      /BIRTHDAYS_ENABLED/,
    );
  }
});

test("online source credentials are opt-in with a literal absolute state directory", () => {
  const configured = parseEnvironment({
    DATABASE_URL: databaseUrl,
    SOURCE_CREDENTIALS_STATE_DIRECTORY: process.cwd(),
  });
  assert.equal(configured.sourceCredentialsStateDirectory, process.cwd());
  assert.equal(
    parseEnvironment({ DATABASE_URL: databaseUrl })
      .sourceCredentialsStateDirectory,
    undefined,
  );
  for (const value of [
    "relative/private",
    "https://example.invalid",
    "bad\0path",
  ]) {
    assert.throws(
      () =>
        parseEnvironment({
          DATABASE_URL: databaseUrl,
          SOURCE_CREDENTIALS_STATE_DIRECTORY: value,
        }),
      /SOURCE_CREDENTIALS_STATE_DIRECTORY/,
    );
  }
});

test("validates configuration and uses explicit development defaults", () => {
  assert.deepEqual(parseEnvironment({ DATABASE_URL: databaseUrl }), {
    archiveExports: {
      enabled: false,
      packageTargetBytes: 2 ** 31,
      maxEntriesPerPackage: 20_000,
      partSizeBytes: 16 * 2 ** 20,
      uploadConcurrency: 1,
      maxRunBytes: 2 ** 40,
      maxCacheBytes: 2 ** 41,
      maxActiveRuns: 1,
      deadlineHours: 72,
      retentionDays: 7,
    },
    nodeEnv: "development",
    host: "127.0.0.1",
    port: 3000,
    databaseUrl,
    appOrigin: "http://localhost:5173",
    authSessionIdleSeconds: 1800,
    authSessionAbsoluteSeconds: 28800,
    xOfficialDailyBudget: 0,
    xOfficialMonthlyBudget: 0,
    sourceOverlapMinutes: 10,
    sourceScheduleEnabled: false,
    sourceScheduleMinutes: 60,
    sourceFailureThreshold: 3,
    sourceCooldownMinutes: 360,
    sourceMediaMaxBytes: 50 * 1024 * 1024,
    typesetBatchMaxBytes: 512 * 1024 * 1024,
    typesetBatchMaxWorks: 20,
    objectStorageDriver: "local",
    localStoragePath: expectLocalStoragePath(),
  });
  assert.equal(
    parseEnvironment({ DATABASE_URL: databaseUrl, PORT: "8080" }).port,
    8080,
  );
});

function expectLocalStoragePath() {
  const value = parseEnvironment({
    DATABASE_URL: databaseUrl,
  }).localStoragePath;
  assert.match(value ?? "", /[\\/][.]comiku-data[\\/]objects$/);
  return value;
}

test("rejects malformed ports instead of accepting a numeric prefix", () => {
  for (const port of ["", "3000junk", "0", "65536", "1.2", "-1", " 3000"]) {
    assert.throws(
      () => parseEnvironment({ DATABASE_URL: databaseUrl, PORT: port }),
      /PORT/,
    );
  }
});

test("rejects invalid environment and host", () => {
  assert.throws(
    () => parseEnvironment({ DATABASE_URL: databaseUrl, NODE_ENV: "prod" }),
    /NODE_ENV/,
  );
  assert.throws(
    () => parseEnvironment({ DATABASE_URL: databaseUrl, HOST: " " }),
    /HOST/,
  );
});

test("requires a PostgreSQL database URL without leaking credentials", () => {
  for (const url of [
    undefined,
    "",
    "mysql://user:secret@localhost/db",
    "postgresql://localhost",
    "secret",
  ]) {
    assert.throws(
      () => parseEnvironment({ DATABASE_URL: url }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /DATABASE_URL/);
        assert.ok(!error.message.includes("secret"));
        return true;
      },
    );
  }
});

test("R2 is all-or-none and mandatory in production", () => {
  assert.throws(
    () => parseEnvironment({ DATABASE_URL: databaseUrl, R2_BUCKET: "comiku" }),
    /all R2_/,
  );
  assert.throws(
    () =>
      parseEnvironment({
        NODE_ENV: "production",
        DATABASE_URL: databaseUrl,
        APP_ORIGIN: "https://comiku.test",
      }),
    /R2/,
  );
  const parsed = parseEnvironment({
    NODE_ENV: "production",
    DATABASE_URL: databaseUrl,
    APP_ORIGIN: "https://comiku.test",
    R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    R2_ACCESS_KEY_ID: "fixture-access-key",
    R2_SECRET_ACCESS_KEY: "fixture-secret-key",
    R2_BUCKET: "comiku-private",
    R2_KEY_PREFIX: " source-test/nested/ ",
  });
  assert.equal(parsed.r2?.bucket, "comiku-private");
  assert.equal(parsed.r2?.keyPrefix, "source-test/nested/");
  assert.equal(parsed.objectStorageDriver, "r2");
  for (const prefix of ["../", "/absolute/", "no-trailing-slash", "a//b/"])
    assert.throws(
      () =>
        parseEnvironment({ DATABASE_URL: databaseUrl, R2_KEY_PREFIX: prefix }),
      /R2_KEY_PREFIX/,
    );
});

test("local storage is development-only and explicit drivers are validated", () => {
  assert.equal(
    parseEnvironment({
      DATABASE_URL: databaseUrl,
      OBJECT_STORAGE_DRIVER: "local",
      LOCAL_STORAGE_PATH: ".comiku-data/custom",
    }).objectStorageDriver,
    "local",
  );
  assert.throws(
    () =>
      parseEnvironment({
        DATABASE_URL: databaseUrl,
        OBJECT_STORAGE_DRIVER: "memory",
      }),
    /only available in tests/,
  );
  assert.throws(
    () =>
      parseEnvironment({
        DATABASE_URL: databaseUrl,
        OBJECT_STORAGE_DRIVER: "other",
      }),
    /OBJECT_STORAGE_DRIVER/,
  );
});

test("retired credentials are ignored while generic source policy stays bounded", () => {
  const configured = parseEnvironment({
    DATABASE_URL: databaseUrl,
    X_WEB_BEARER_TOKEN: "bearer",
    X_WEB_AUTH_TOKEN: "auth",
    X_WEB_CSRF_TOKEN: "csrf",
    X_WEB_USER_MEDIA_QUERY_ID: "query",
    X_WEB_FEATURES_JSON: "invalid retired input",
    X_BEARER_TOKEN: "retired synthetic bearer",
    X_OFFICIAL_DAILY_BUDGET: "10",
    X_OFFICIAL_MONTHLY_BUDGET: "100",
    SOURCE_OVERLAP_MINUTES: "15",
    SOURCE_FAILURE_THRESHOLD: "4",
    SOURCE_COOLDOWN_MINUTES: "120",
  });
  assert.equal("xWebSession" in configured, false);
  assert.equal("xBearerToken" in configured, false);
  assert.equal(configured.xOfficialDailyBudget, 10);
  assert.equal(configured.sourceFailureThreshold, 4);
  assert.throws(
    () =>
      parseEnvironment({
        DATABASE_URL: databaseUrl,
        SOURCE_OVERLAP_MINUTES: "0",
      }),
    /SOURCE_OVERLAP_MINUTES/,
  );
});

test("typeset batch safety caps remain bounded and configurable", () => {
  assert.equal(
    parseEnvironment({
      DATABASE_URL: databaseUrl,
      TYPESET_BATCH_MAX_MIB: "128",
      TYPESET_BATCH_MAX_WORKS: "5",
    }).typesetBatchMaxBytes,
    128 * 1024 * 1024,
  );
  for (const fields of [
    { TYPESET_BATCH_MAX_MIB: "0" },
    { TYPESET_BATCH_MAX_MIB: "1025" },
    { TYPESET_BATCH_MAX_WORKS: "21" },
  ])
    assert.throws(() =>
      parseEnvironment({ DATABASE_URL: databaseUrl, ...fields }),
    );
});

test("source media size configuration is bounded independently of manual uploads", () => {
  assert.equal(
    parseEnvironment({ DATABASE_URL: databaseUrl, SOURCE_MEDIA_MAX_MIB: "100" })
      .sourceMediaMaxBytes,
    100 * 1024 * 1024,
  );
  for (const value of ["0", "101", "1.5", "no", "Infinity"])
    assert.throws(
      () =>
        parseEnvironment({
          DATABASE_URL: databaseUrl,
          SOURCE_MEDIA_MAX_MIB: value,
        }),
      /SOURCE_MEDIA_MAX_MIB/,
    );
});

test("session lifetimes accept long internal sessions and reject unsafe deadlines", () => {
  const env = parseEnvironment({
    DATABASE_URL: databaseUrl,
    AUTH_SESSION_IDLE_SECONDS: "604800",
    AUTH_SESSION_ABSOLUTE_SECONDS: "2592000",
  }) as unknown as {
    authSessionIdleSeconds: number;
    authSessionAbsoluteSeconds: number;
  };
  assert.equal(env.authSessionIdleSeconds, 604800);
  assert.equal(env.authSessionAbsoluteSeconds, 2592000);
  for (const value of [
    "0",
    "-1",
    "1.5",
    "NaN",
    "Infinity",
    "9007199254740993",
    "8640000000000000",
  ])
    for (const key of [
      "AUTH_SESSION_IDLE_SECONDS",
      "AUTH_SESSION_ABSOLUTE_SECONDS",
    ])
      assert.throws(
        () => parseEnvironment({ DATABASE_URL: databaseUrl, [key]: value }),
        /AUTH_SESSION/,
      );
  assert.throws(
    () =>
      parseEnvironment({
        DATABASE_URL: databaseUrl,
        AUTH_SESSION_IDLE_SECONDS: "100",
        AUTH_SESSION_ABSOLUTE_SECONDS: "99",
      }),
    /AUTH_SESSION/,
  );
});
