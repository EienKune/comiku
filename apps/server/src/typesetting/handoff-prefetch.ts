import type { Readable } from "node:stream";
import { finished } from "node:stream/promises";

type OpenImage = { contentType: string; body: Readable };
type OpenResult = { value: OpenImage } | { error: unknown };

// Keep just the current and next GET open. Unconsumed bodies remain paused,
// preserving stream backpressure instead of buffering another whole image.
export async function* prefetchHandoffImages<T>(
  images: readonly T[],
  open: (image: T, signal: AbortSignal) => Promise<OpenImage>,
  signal?: AbortSignal,
): AsyncGenerator<OpenImage> {
  const controller = new AbortController();
  const bodies = new Map<Readable, Promise<void>>();
  const pending = new Set<Promise<OpenResult>>();
  const queue: Promise<OpenResult>[] = [];
  let next = 0;
  let stopped = false;
  function stop(error?: unknown) {
    if (stopped) return;
    stopped = true;
    controller.abort(error);
    for (const body of bodies.keys())
      body.destroy(error instanceof Error ? error : undefined);
  }
  const cancel = () => stop(signal?.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  function start() {
    const image = images[next++];
    const task: Promise<OpenResult> = Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return open(image, controller.signal);
      })
      .then((value): OpenResult => {
        // Observe errors immediately, including bodies not yet yielded to ZIP.
        const completion = finished(value.body, { cleanup: true }).catch(
          () => undefined,
        );
        bodies.set(value.body, completion);
        value.body.once("error", stop);
        if (stopped) value.body.destroy();
        controller.signal.throwIfAborted();
        return { value };
      })
      .catch((error): OpenResult => {
        stop(error);
        return { error };
      });
    pending.add(task);
    void task.then(() => pending.delete(task));
    queue.push(task);
  }
  try {
    while (next < images.length && queue.length < 2) start();
    while (queue.length) {
      const result = await queue.shift()!;
      if ("error" in result) throw result.error;
      controller.signal.throwIfAborted();
      yield result.value;
      // The archive consumes a page completely before requesting the next one.
      // Also close on early consumers, rather than leaking a paused GET.
      result.value.body.destroy();
      await bodies.get(result.value.body);
      bodies.delete(result.value.body);
      controller.signal.throwIfAborted();
      if (next < images.length) start();
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    stop();
    // A late open can still return a body after cancellation. Its continuation
    // registers and destroys that body before this final completion barrier.
    await Promise.all(pending);
    await Promise.all(bodies.values());
  }
}
