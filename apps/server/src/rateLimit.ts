import { HttpError } from "./errors";

/** In-memory token buckets keyed by user + bucket name. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();

  /** Throws 429 RATE_LIMITED when `key` exceeds `perSec` requests per second (burst = perSec). */
  hit(key: string, perSec: number, burst = Math.max(1, perSec)): void {
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: burst, at: now };
    b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * perSec);
    b.at = now;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      throw new HttpError(429, "RATE_LIMITED", "Slow down: too many requests");
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    if (this.buckets.size > 10_000) this.sweep(now);
  }

  private sweep(now: number): void {
    for (const [k, b] of this.buckets) if (now - b.at > 120_000) this.buckets.delete(k);
  }
}
