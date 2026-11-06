import assert from "node:assert/strict";
import test from "node:test";
import { HttpMediaDownloader } from "../src/source-ingestion/media-downloader.js";
import { createHash } from "node:crypto";
import { sourceDiagnostic } from "../src/source-ingestion/source-diagnostics.js";

test("CDN 403 retains media scope and a query-free endpoint", async () => {
  await assert.rejects(
    new HttpMediaDownloader(
      async () => new Response(null, { status: 403 }),
    ).download("https://fixture.invalid/image?signature=secret#private", [
      "fixture.invalid",
    ]),
    (error: unknown) => {
      const detail = sourceDiagnostic(error);
      assert.equal(detail.failureScope, "media");
      assert.equal(detail.reason, "media_http_403");
      assert.equal(JSON.stringify(detail).includes("signature"), false);
      return true;
    },
  );
});

test("unknown-length responses stop and cancel as soon as the actual size limit is crossed", async () => {
  let produced = 0;
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        if (produced === 64) controller.close();
        else {
          produced++;
          controller.enqueue(new Uint8Array(1024 * 1024));
        }
      },
      cancel() {
        cancelled = true;
      },
    }),
    { headers: { "Content-Type": "image/png" } },
  );
  const downloader = new HttpMediaDownloader(async () => response);
  await assert.rejects(
    downloader.download("https://fixture.invalid/image", ["fixture.invalid"]),
    (e: unknown) => {
      assert.equal(sourceDiagnostic(e).reason, "media_size_limit");
      assert.equal(
        (sourceDiagnostic(e).diagnostic as Record<string, string>)
          .observed_bytes,
        String(51 * 1024 * 1024),
      );
      return true;
    },
  );
  assert.ok(produced < 54, `Consumed ${produced} MiB before rejecting`);
  assert.equal(cancelled, true);
  assert.equal(response.body?.locked, false);
});

test("rejected status, type and declared-size responses release their bodies", async () => {
  for (const options of [
    { status: 503, headers: { "Content-Type": "image/png" } },
    { headers: { "Content-Type": "text/plain" } },
    {
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(51 * 1024 * 1024),
      },
    },
  ]) {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      options,
    );
    await assert.rejects(
      new HttpMediaDownloader(async () => response).download(
        "https://fixture.invalid/image",
        ["fixture.invalid"],
      ),
    );
    assert.equal(cancelled, true);
    assert.equal(response.body?.locked, false);
  }
});

test("an image exactly at the limit keeps its content and checksum", async () => {
  const body = new Uint8Array(50 * 1024 * 1024);
  body[0] = 42;
  body[body.length - 1] = 43;
  const response = new Response(body, {
    headers: { "Content-Type": "image/png" },
  });
  const result = await new HttpMediaDownloader(async () => response).download(
    "https://fixture.invalid/image",
    ["fixture.invalid"],
  );
  assert.equal(Buffer.compare(result.body, body), 0);
  assert.equal(
    result.checksum,
    createHash("sha256").update(body).digest("hex"),
  );
  assert.equal(response.body?.locked, false);
});

test("a failed response stream does not leave its reader locked", async () => {
  let reads = 0;
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        if (reads++) controller.error(new Error("fixture stream failed"));
        else controller.enqueue(new Uint8Array([1, 2, 3]));
      },
    }),
    { headers: { "Content-Type": "image/png" } },
  );
  await assert.rejects(
    new HttpMediaDownloader(async () => response).download(
      "https://fixture.invalid/image",
      ["fixture.invalid"],
    ),
    /fixture stream failed/,
  );
  assert.equal(response.body?.locked, false);
});
test("Pixiv original downloads supply its fixed Referer without forwarding session credentials", async () => {
  const downloader = new HttpMediaDownloader(async (url, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(
      headers.get("Referer"),
      new URL(String(url)).hostname === "i.pximg.net"
        ? "https://www.pixiv.net/"
        : null,
    );
    assert.equal(headers.get("Cookie"), null);
    assert.equal(headers.get("Authorization"), null);
    return new Response("image fixture", {
      headers: { "Content-Type": "image/png" },
    });
  });
  await downloader.download("https://i.pximg.net/img-original/fixture.png", [
    "i.pximg.net",
  ]);
  await downloader.download("https://pbs.twimg.com/media/fixture.png", [
    "pbs.twimg.com",
  ]);
});

test("declared oversize reports a bounded policy reason and byte limits without consuming the body", async () => {
  let pulled = 0,
    cancelled = false;
  const response = new Response(
    new ReadableStream({
      pull() {
        pulled++;
      },
      cancel() {
        cancelled = true;
      },
    }),
    {
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(51 * 1024 * 1024),
      },
    },
  );
  await assert.rejects(
    new HttpMediaDownloader(async () => response).download(
      "https://fixture.invalid/private?token=SECRET",
      ["fixture.invalid"],
    ),
    (error: unknown) => {
      const detail = sourceDiagnostic(error);
      assert.equal(detail.reason, "media_size_limit");
      assert.equal(detail.failureScope, "media");
      assert.equal(
        (detail.diagnostic as Record<string, string>).limit_bytes,
        String(50 * 1024 * 1024),
      );
      assert.equal(
        (detail.diagnostic as Record<string, string>).declared_bytes,
        String(51 * 1024 * 1024),
      );
      assert.ok(!JSON.stringify(detail).includes("SECRET"));
      return true;
    },
  );
  assert.ok(pulled <= 1);
  assert.equal(cancelled, true);
});

test("unsupported and empty bodies retain policy reasons rather than a network error", async () => {
  for (const [response, reason] of [
    [
      new Response("text", { headers: { "Content-Type": "text/plain" } }),
      "media_type_unsupported",
    ],
    [
      new Response(new Uint8Array(), {
        headers: { "Content-Type": "image/png" },
      }),
      "media_empty",
    ],
  ] as const) {
    await assert.rejects(
      new HttpMediaDownloader(async () => response).download(
        "https://fixture.invalid/image",
        ["fixture.invalid"],
      ),
      (e: unknown) => {
        assert.equal(sourceDiagnostic(e).reason, reason);
        return true;
      },
    );
  }
});
