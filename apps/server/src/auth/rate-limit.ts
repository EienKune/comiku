import { HttpException, Injectable } from "@nestjs/common";
import { tokenHash } from "../users/password.js";

@Injectable()
export class RateLimit {
  private readonly buckets = new Map<string, { count: number; end: number }>();
  check(key: string, limit = 30, windowMs = 15 * 60 * 1000) {
    const now = Date.now();
    for (const [id, value] of this.buckets)
      if (value.end <= now) this.buckets.delete(id);
    const id = tokenHash(key);
    const value = this.buckets.get(id) ?? { count: 0, end: now + windowMs };
    if (
      value.count >= limit ||
      (!this.buckets.has(id) && this.buckets.size >= 5000)
    ) {
      throw new HttpException("操作过于频繁，请稍后重试", 429);
    }
    value.count += 1;
    this.buckets.set(id, value);
  }
}
