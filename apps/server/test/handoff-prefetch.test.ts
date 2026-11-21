import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { unzipSync } from "fflate";
import { createTypesetHandoffArchive } from "../src/typesetting/handoff-package.js";
import { prefetchHandoffImages } from "../src/typesetting/handoff-prefetch.js";

test("handoff prefetch keeps archive order and opens at most current plus next page", async () => {
  let active = 0;
  let peak = 0;
  const opened: number[] = [];
  const archive = await createTypesetHandoffArchive(
    prefetchHandoffImages([0, 1, 2, 3], async (index) => {
      active++;
      peak = Math.max(peak, active);
      opened.push(index);
      await delay(index === 0 ? 25 : 1);
      const body = Readable.from(
        (async function* () {
          await delay(5);
          yield Buffer.from([index]);
        })(),
      );
      body.once("close", () => active--);
      return { contentType: "image/png", body };
    }),
    12,
  );
  try {
    const contents = unzipSync(await readFile(archive.path));
    assert.deepEqual(Object.keys(contents), [
      "12-001.png",
      "12-002.png",
      "12-003.png",
      "12-004.png",
    ]);
    assert.deepEqual(
      Object.values(contents).map((body) => [...body]),
      [[0], [1], [2], [3]],
    );
    assert.deepEqual(opened, [0, 1, 2, 3]);
    assert.equal(peak, 2);
    assert.equal(active, 0);
  } finally {
    await archive.cleanup();
  }
});

test("cancel closes open bodies and waits for an in-flight open to settle", async () => {
  const controller = new AbortController();
  const bodies: Readable[] = [];
  let lateOpenSettled = false;
  const iterator = prefetchHandoffImages(
    [0, 1, 2],
    async (index) => {
      if (index === 1) await delay(30);
      const body = new Readable({ read() {} });
      bodies.push(body);
      if (index === 1) lateOpenSettled = true;
      return { contentType: "image/png", body };
    },
    controller.signal,
  );
  const first = await iterator.next();
  assert.equal(first.done, false);
  controller.abort(new Error("cancel handoff"));
  await assert.rejects(iterator.next(), /cancel handoff/);
  assert.equal(lateOpenSettled, true);
  assert.equal(bodies.length, 2);
  assert.ok(bodies.every((body) => body.closed));
});

test("a prefetched opening failure interrupts the current body and settles cleanup", async () => {
  const body = new Readable({ read() {} });
  const archive = createTypesetHandoffArchive(
    prefetchHandoffImages([0, 1, 2], async (index) => {
      if (index === 1) {
        await delay(10);
        throw new Error("next R2 GET failed");
      }
      return { contentType: "image/png", body };
    }),
    12,
  );
  await assert.rejects(archive, /next R2 GET failed/);
  assert.equal(body.closed, true);
});

test("a prefetched body error is observed before consumption and closes both bodies", async () => {
  const bodies: Readable[] = [];
  const archive = createTypesetHandoffArchive(
    prefetchHandoffImages([0, 1], async (index) => {
      const body = new Readable({ read() {} });
      bodies.push(body);
      if (index === 1)
        setImmediate(() => body.destroy(new Error("prefetched read failed")));
      return { contentType: "image/png", body };
    }),
    12,
  );
  await assert.rejects(archive, /prefetched read failed/);
  assert.ok(bodies.every((body) => body.closed));
});

test("an archive consumer failure closes the unused prefetched stream", async () => {
  const bodies: Readable[] = [];
  const iterator = prefetchHandoffImages([0, 1, 2], async () => {
    const body = new Readable({ read() {} });
    bodies.push(body);
    return { contentType: "image/png", body };
  });
  await iterator.next();
  await iterator.return(undefined);
  assert.equal(bodies.length, 2);
  assert.ok(bodies.every((body) => body.closed));
});

test("current-page read failure closes a late prefetched body before rejecting", async () => {
  const bodies: Readable[] = [];
  let lateSettled = false;
  const archive = createTypesetHandoffArchive(
    prefetchHandoffImages([0, 1], async (index) => {
      if (index === 1) await delay(25);
      const body =
        index === 0
          ? Readable.from(
              (async function* () {
                yield Buffer.from([0]);
                throw new Error("current page failed");
              })(),
            )
          : new Readable({ read() {} });
      bodies.push(body);
      if (index === 1) lateSettled = true;
      return { contentType: "image/png", body };
    }),
    12,
  );
  await assert.rejects(archive, /current page failed/);
  assert.equal(lateSettled, true);
  assert.ok(bodies.every((body) => body.closed));
});

test("pre-cancelled generation never opens an object", async () => {
  let opened = 0;
  const iterator = prefetchHandoffImages(
    [0, 1],
    async () => {
      opened++;
      return { contentType: "image/png", body: Readable.from([]) };
    },
    AbortSignal.abort(new Error("already cancelled")),
  );
  await assert.rejects(iterator.next(), /already cancelled/);
  assert.equal(opened, 0);
});

test("prefetch leaves the next image paused without reading its full body", async () => {
  const produced = [0, 0];
  const iterator = prefetchHandoffImages([0, 1], async (index) => ({
    contentType: "image/png",
    body: Readable.from(
      (async function* () {
        for (let chunk = 0; chunk < 100; chunk++) {
          produced[index]++;
          yield Buffer.alloc(64 * 1024);
        }
      })(),
    ),
  }));
  await iterator.next();
  await delay(10);
  assert.deepEqual(produced, [0, 0]);
  await iterator.return(undefined);
});
