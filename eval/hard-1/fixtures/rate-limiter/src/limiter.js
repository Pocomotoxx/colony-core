// A sliding-window rate limiter.
export class SlidingWindowLimiter {
  constructor({ limit, windowMs, now = Date.now }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.events = {};
  }

  allow(key) {
    const t = this.now();
    const times = (this.events[key] ??= []).filter((x) => t - x <= this.windowMs);
    times.push(t);
    this.events[key] = times;
    const allowed = times.length <= this.limit;
    return { allowed, remaining: Math.max(0, this.limit - times.length), retryAfterMs: allowed ? 0 : this.windowMs };
  }

  size() {
    return Object.keys(this.events).length;
  }
}
