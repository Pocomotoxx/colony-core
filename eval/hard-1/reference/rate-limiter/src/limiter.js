// A sliding-window rate limiter.
export class SlidingWindowLimiter {
  #limit;
  #windowMs;
  #now;
  #events = new Map();

  constructor({ limit, windowMs, now = Date.now } = {}) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer');
    if (typeof windowMs !== 'number' || !Number.isFinite(windowMs) || windowMs <= 0) throw new RangeError('windowMs must be a positive finite number');
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  #prune(t) {
    for (const [key, times] of this.#events) {
      while (times.length > 0 && times[0] <= t - this.#windowMs) times.shift();
      if (times.length === 0) this.#events.delete(key);
    }
  }

  allow(key) {
    if (typeof key !== 'string' || key === '') throw new TypeError('key must be a non-empty string');
    const t = this.#now();
    this.#prune(t);
    const times = this.#events.get(key) ?? [];
    if (times.length >= this.#limit) {
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(1, times[0] + this.#windowMs - t) };
    }
    times.push(t);
    this.#events.set(key, times);
    return { allowed: true, remaining: this.#limit - times.length, retryAfterMs: 0 };
  }

  size() {
    this.#prune(this.#now());
    return this.#events.size;
  }
}
