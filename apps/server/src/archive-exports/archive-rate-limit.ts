import { setTimeout } from "node:timers/promises";

/** A small quantum avoids bursts and observes cached setting changes within 100ms. */
export class ArchiveRateLimiter {
  constructor(
    private readonly getRateMiB: () => number,
    private readonly signal: AbortSignal,
    private readonly now = () => performance.now(),
    private readonly sleep = (ms: number) =>
      setTimeout(ms, undefined, { signal }),
  ) {}

  async consume(bytes: number): Promise<void> {
    let remaining = bytes;
    while (remaining > 0.000001) {
      this.signal.throwIfAborted();
      const rate = this.getRateMiB();
      if (!Number.isFinite(rate) || rate < 0 || rate > 1024)
        throw new Error("Invalid archive bandwidth limit");
      if (rate === 0) return;
      const before = this.now();
      const wait = Math.min(100, (remaining / (rate * 1024 ** 2)) * 1000);
      await this.sleep(wait);
      // Charge elapsed time at the rate sampled before sleeping. No accumulated idle credit.
      remaining -= (Math.max(0, this.now() - before) * rate * 1024 ** 2) / 1000;
    }
  }
}
