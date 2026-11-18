# SlidingWindowLimiter

`src/limiter.js` exports the class `SlidingWindowLimiter`, a sliding-window rate limiter that keeps a log of request times per key.

`new SlidingWindowLimiter({ limit, windowMs, now })`

- `limit`: how many requests one key may make inside the window (a positive integer).
- `windowMs`: the length of the window in milliseconds (a positive, finite number).
- `now`: a function that returns the current time in milliseconds, default `Date.now`. It never goes backwards.
- A `limit` that is not a positive integer, or a `windowMs` that is not a positive finite number, throws a `RangeError` from the constructor.

`allow(key)` returns `{ allowed, remaining, retryAfterMs }`. A `key` that is not a non-empty string throws a `TypeError`.

- The window at time `t` is the half-open interval `(t - windowMs, t]`. A request that was allowed at time `s` counts while `s > t - windowMs`; at exactly `t = s + windowMs` it no longer counts.
- A request is allowed when fewer than `limit` allowed requests of this key are inside the window. Only an ALLOWED request is recorded: a denied request is not logged and does not extend the block.
- `remaining` is how many more requests of this key would be allowed right now, after this call (so `0` when the call was denied, and `limit - 1` after the first allowed call).
- `retryAfterMs` is `0` when the call was allowed. When it was denied, it is the number of milliseconds until the oldest request that counts leaves the window, so that a request made then would be allowed (at least `1`).
- Keys are independent of each other.

`size()` returns the number of keys that currently have at least one request inside the window. A key whose requests have all left the window is forgotten, so memory does not grow with keys that were seen once; the cleanup happens when `allow` or `size` is called (no timers).
