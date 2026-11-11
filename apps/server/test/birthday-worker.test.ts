import assert from "node:assert/strict";
import test from "node:test";
import { runBirthdayWorker } from "../src/birthdays/birthday-worker.js";

function fixture() {
  const controller = new AbortController();
  let now = 1;
  let queued = 0;
  const events: string[] = [];
  const calls = {
    reminders: 0,
    primary: 0,
    supplement: 0,
    cleanup: 0,
    claims: 0,
  };
  const dependencies = {
    birthdays: {
      async schedule() {
        calls.primary++;
        return { queued: false };
      },
      async scheduleSupplement() {
        calls.supplement++;
        queued++;
        events.push("schedule");
        return { queued: true };
      },
      async cleanupCatalogs() {
        calls.cleanup++;
      },
    },
    reminders: {
      async maintain() {
        calls.reminders++;
      },
    },
    jobs: {
      async runNext(lane: string, signal: AbortSignal, scope?: string) {
        assert.equal(lane, "network");
        assert.equal(scope, "birthdays");
        assert.equal(signal, controller.signal);
        assert.ok(queued-- > 0, "schedule the next checkpoint before claiming");
        calls.claims++;
        events.push("claim");
        now += 6000;
        return calls.claims <= 2;
      },
    },
    notificationsEnabled: true,
  };
  const clock = {
    now: () => now,
    async wait(ms: number, signal: AbortSignal) {
      assert.equal(ms, 60_000);
      assert.equal(signal, controller.signal);
      events.push("wait");
      controller.abort();
    },
  };
  return {
    controller,
    dependencies,
    clock,
    events,
    calls,
    advance(ms: number) {
      now += ms;
    },
    run: () => runBirthdayWorker(dependencies, controller.signal, clock),
  };
}

test("due batches drain without idle sleeps; empty queues sleep and maintenance stays bounded", async () => {
  const f = fixture();
  await f.run();
  assert.deepEqual(f.events, [
    "schedule",
    "claim",
    "schedule",
    "claim",
    "schedule",
    "claim",
    "wait",
  ]);
  assert.deepEqual(f.calls, {
    reminders: 1,
    primary: 1,
    supplement: 3,
    cleanup: 1,
    claims: 3,
  });
});

test("busy batches check reminders and primary scheduling again only after their own minute", async (t) => {
  const f = fixture();
  const original = f.dependencies.jobs.runNext;
  t.mock.method(
    f.dependencies.jobs,
    "runNext",
    async (...args: Parameters<typeof original>) => {
      f.advance(35_000);
      return original(...args);
    },
  );
  await f.run();
  assert.equal(f.calls.claims, 3);
  assert.equal(f.calls.reminders, 2);
  assert.equal(f.calls.primary, 2);
  assert.equal(f.calls.cleanup, 1);
  assert.equal(f.events.filter((event) => event === "wait").length, 1);
});

test("failed maintenance does not block other sources or repeat for every busy batch", async (t) => {
  const f = fixture();
  t.mock.method(console, "error", () => {});
  for (const [object, method] of [
    [f.dependencies.reminders, "maintain"],
    [f.dependencies.birthdays, "schedule"],
    [f.dependencies.birthdays, "cleanupCatalogs"],
  ] as const) {
    const original = object[
      method as keyof typeof object
    ] as () => Promise<unknown>;
    t.mock.method(object, method as keyof typeof object, async () => {
      await original();
      throw new Error("synthetic maintenance failure");
    });
  }
  await f.run();
  assert.deepEqual(f.calls, {
    reminders: 1,
    primary: 1,
    supplement: 3,
    cleanup: 1,
    claims: 3,
  });
});

test("a queue error backs off rather than hot-looping; disabled notifications do no reminder work", async (t) => {
  const f = fixture();
  f.dependencies.notificationsEnabled = false;
  t.mock.method(console, "error", () => {});
  t.mock.method(f.dependencies.jobs, "runNext", async () => {
    f.calls.claims++;
    throw new Error("synthetic database failure");
  });
  await f.run();
  assert.equal(f.calls.claims, 1);
  assert.equal(f.calls.reminders, 0);
  assert.equal(f.events.at(-1), "wait");
});

test("abort before or during scheduling never claims a new task or starts an idle wait", async (t) => {
  const stopped = fixture();
  stopped.controller.abort();
  await stopped.run();
  assert.deepEqual(stopped.events, []);
  const f = fixture();
  t.mock.method(f.dependencies.birthdays, "scheduleSupplement", async () => {
    f.controller.abort();
    return { queued: false };
  });
  await f.run();
  assert.equal(f.calls.claims, 0);
  assert.deepEqual(f.events, []);
});
