import assert from "node:assert/strict";
import test from "node:test";
import * as diagnostics from "../src/source-ingestion/source-diagnostics.js";
import {
  SourceResponseError,
  requestSourceJson,
} from "../src/source-ingestion/source-response.js";

test("private details cannot escape through enumeration or ordinary errors", () => {
  const error = new SourceResponseError("authentication", {
    reason: "auth_failed",
    scope: "credential",
    diagnostic: { message: "private fixture" },
  });
  assert.equal(JSON.stringify(error).includes("private fixture"), false);
  assert.equal(Object.keys(error).includes("details"), false);
  assert.equal(error.message.includes("private fixture"), false);
  assert.equal(diagnostics.sourceDiagnostic(error).reason, "auth_failed");
  assert.equal(diagnostics.sourceDiagnostic(error).failureScope, "credential");
  const unknown = {
    get message() {
      throw Error("do not read");
    },
    toJSON() {
      throw Error("do not serialize");
    },
  };
  assert.equal(diagnostics.sourceDiagnostic(unknown).reason, "unknown_failure");
  assert.equal(diagnostics.sourceDiagnostic(unknown).failureScope, "unknown");
});

test("allowlisted diagnostics redact before byte budgets including encoded secrets and boundary fragments", () => {
  const secret = 'fixture-secret/"value';
  const value = diagnostics.sanitizeSourceDiagnostic(
    {
      stage: "enumeration",
      http_endpoint:
        "https://user:pass@example.invalid/path?signature=private#fragment",
      message: [
        secret,
        encodeURIComponent(secret),
        JSON.stringify(secret),
        "fixture-secret",
        "Authorization: Bearer hidden",
        "https://user:pass@example.invalid/path?signature=private#fragment",
        '{"access_token":"hidden-json"}',
      ].join("\n"),
      traceback: "x".repeat(16380) + secret,
      response_excerpt: { nested: secret },
      http_response_headers: JSON.stringify({
        "content-type": "text/html",
        "set-cookie": "hidden-cookie",
        location: "hidden-location",
      }),
      payload: "forbidden",
    },
    [secret],
  );
  const text = JSON.stringify(value);
  assert.equal(value.stage, "enumeration");
  assert.equal(value.http_endpoint, "https://example.invalid/path");
  assert.equal(value.message, "[diagnostic omitted]");
  for (const forbidden of [
    secret,
    encodeURIComponent(secret),
    "fixture-secret",
    "Bearer hidden",
    "hidden-json",
    "hidden-cookie",
    "hidden-location",
    "user:pass",
    "signature=",
    "#fragment",
    "forbidden",
  ])
    assert.equal(text.includes(forbidden), false, forbidden);
  assert.equal(Object.keys(value).length <= 32, true);
  for (const field of Object.values(value))
    assert.ok(Buffer.byteLength(field) <= 16384);
  assert.ok(Buffer.byteLength(text) <= 65536);
});

test("sensitive JSON values containing escaped quotes cannot leak their suffix", () => {
  const result = diagnostics.sanitizeSourceDiagnostic({
    message: '{"access_token":"first\\"private-suffix","safe":"context"}',
  });
  assert.equal(JSON.stringify(result).includes("private-suffix"), false);
});

test("encoded URL delimiters cannot split a private query into a surviving suffix", () => {
  for (const message of [
    "https://example.invalid/path?q=first%0Aprivatesuffix",
    "https://example.invalid/path?q=first%22privatesuffix",
    "https://example.invalid/path?q=first\\u000aprivatesuffix",
  ]) {
    const result = diagnostics.sanitizeSourceDiagnostic({ message });
    assert.equal(JSON.stringify(result).includes("privatesuffix"), false);
  }
});

test("fully encoded URL and JSON delimiters cannot survive the final diagnostic boundary", () => {
  for (const delimiter of ["%0A", "%0D", "%22", "%27"]) {
    for (const message of [
      `https%3A%2F%2Fexample.invalid%2Fpath%3Fq%3Dfirst${delimiter}privatesuffix`,
      `https:\\u002f\\u002fexample.invalid/path?q=first\\u00${delimiter.slice(1).toLowerCase()}privatesuffix`,
      `{"access_token":"first\\u00${delimiter.slice(1).toLowerCase()}privatesuffix"}`,
      encodeURIComponent(
        `{"access_token":"first${decodeURIComponent(delimiter)}privatesuffix"}`,
      ),
      `{"access_token":"first${decodeURIComponent(delimiter)}privatesuffix"}`,
    ]) {
      const sanitized = diagnostics.sanitizeSourceDiagnostic({
        stage: "enumeration",
        message,
      });
      assert.equal(
        JSON.stringify(sanitized).includes("privatesuffix"),
        false,
        message,
      );
      const error = new SourceResponseError("authentication", {
        reason: "auth_failed",
        scope: "credential",
        diagnostic: { stage: "enumeration", message },
      });
      assert.equal(
        JSON.stringify(diagnostics.sourceDiagnostic(error)).includes(
          "privatesuffix",
        ),
        false,
        message,
      );
      assert.equal(
        (
          diagnostics.sourceDiagnostic(error).diagnostic as Record<
            string,
            string
          >
        ).stage,
        "enumeration",
      );
    }
  }
});

test("UTF8 and JSON escaping are included in total diagnostic budget", () => {
  const input = Object.fromEntries(
    "stage guard exception_type runtime_version message traceback field http_status http_method http_endpoint http_response_bytes http_response_excerpt response_excerpt upstream_logs exitCode signal killed timeout duration stderr"
      .split(" ")
      .map((key) => [key, '汉\\"'.repeat(20000)]),
  );
  const result = diagnostics.sanitizeSourceDiagnostic(input);
  assert.ok(Object.keys(result).length > 1);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 65536);
  for (const field of Object.values(result))
    assert.ok(Buffer.byteLength(field) <= 16384);
});

test("malformed percent UTF8 cannot split a private encoded URL suffix", () => {
  for (const bytes of [
    "%FF",
    "%C3",
    "%E0%A4",
    "%F0%9F",
    "%E2%28%A1",
    "%ED%A0%80",
    "%25FF",
  ]) {
    const message = `https%3A%2F%2Fexample.invalid%2Fpath%3Fq%3Dfirst${bytes}privatesuffix`;
    const input = { stage: "enumeration", message };
    assert.deepEqual(diagnostics.sanitizeSourceDiagnostic(input), {
      stage: "enumeration",
      message: "[diagnostic omitted]",
    });
    const error = new SourceResponseError("authentication", {
      reason: "auth_failed",
      scope: "credential",
      diagnostic: input,
    });
    assert.deepEqual(diagnostics.sourceDiagnostic(error).diagnostic, {
      stage: "enumeration",
      message: "[diagnostic omitted]",
    });
  }
});

test("independent opaque response IDs survive while credential canaries are suppressed", () => {
  assert.equal(
    JSON.stringify(
      diagnostics.sanitizeSourceDiagnostic(
        { message: '{"access_token":"unknown-private-value"}' },
        ["fixture-secret-token"],
      ),
    ).includes("unknown-private-value"),
    false,
  );
  const result = diagnostics.sanitizeSourceDiagnostic(
    {
      http_response_headers: {
        "cf-ray": "cf-a7d3b9e2",
        "x-request-id": "req-9c5e7a1b",
        "set-cookie": "fixture-secret-token",
      },
    },
    ["fixture-secret-token", "fixture-csrf-value"],
  );
  assert.deepEqual(JSON.parse(result.http_response_headers), {
    "cf-ray": "cf-a7d3b9e2",
    "x-request-id": "req-9c5e7a1b",
  });
});

test("hostile oversized inputs are dropped and unrecognized reason cannot bypass sanitization", () => {
  assert.equal(
    diagnostics.sanitizeSourceDiagnostic({
      http_response_headers: { server: "x".repeat(262145) },
    }).http_response_headers,
    "{}",
  );
  assert.deepEqual(
    diagnostics.sanitizeSourceDiagnostic({ message: "private".repeat(50000) }),
    {},
  );
  assert.deepEqual(
    diagnostics.sanitizeSourceDiagnostic({ message: "safe" }, [
      "x".repeat(2048),
    ]),
    {},
  );
  assert.deepEqual(
    diagnostics.sanitizeSourceDiagnostic(
      { message: "safe" },
      Array(129).fill("secret"),
    ),
    {},
  );
  const error = new SourceResponseError("invalid_response", {
    reason: "a_valid_looking_secret",
    scope: "protocol",
  });
  assert.equal(diagnostics.sourceDiagnostic(error).reason, "unknown_failure");
});

test("source API 403 is source access while 401 and 429 describe the credential boundary", async () => {
  for (const [status, scope] of [
    [401, "credential"],
    [403, "source"],
    [429, "credential"],
    [503, "transport"],
  ] as const) {
    await assert.rejects(
      requestSourceJson(async () => new Response("private-body", { status })),
      (error: unknown) => {
        assert.equal(diagnostics.sourceDiagnostic(error).failureScope, scope);
        assert.equal(
          diagnostics.sourceDiagnostic(error).reason,
          `request_http_${status}`,
        );
        assert.equal(
          JSON.stringify(diagnostics.sourceDiagnostic(error)).includes(
            "private-body",
          ),
          false,
        );
        return true;
      },
    );
  }
});
