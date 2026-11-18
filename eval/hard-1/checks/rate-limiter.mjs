import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Hidden check of the task "rate-limiter". It lives outside the workspace and runs with the workspace as the working folder.
let SlidingWindowLimiter;
try {
  ({ SlidingWindowLimiter } = await import(pathToFileURL(path.resolve('src', 'limiter.js')).href));
} catch (err) {
  console.error(`cannot load src/limiter.js: ${err.message}`);
  process.exit(1);
}
if (typeof SlidingWindowLimiter !== 'function') {
  console.error('src/limiter.js must export the class SlidingWindowLimiter');
  process.exit(1);
}

let failed = 0;
const fail = (msg) => {
  failed++;
  if (failed <= 40) console.error(msg);
};
const show = (v) => JSON.stringify(v);

function make(limit, windowMs) {
  const clock = { t: 1000 };
  const limiter = new SlidingWindowLimiter({ limit, windowMs, now: () => clock.t });
  return { clock, limiter };
}
function expectCall(label, actual, expected) {
  if (show(actual) !== show(expected)) fail(`${label}: got ${show(actual)}, expected ${show(expected)}`);
}

// basic counting and remaining
{
  const { limiter } = make(3, 1000);
  expectCall('first', limiter.allow('a'), { allowed: true, remaining: 2, retryAfterMs: 0 });
  expectCall('second', limiter.allow('a'), { allowed: true, remaining: 1, retryAfterMs: 0 });
  expectCall('third', limiter.allow('a'), { allowed: true, remaining: 0, retryAfterMs: 0 });
  expectCall('fourth is denied', limiter.allow('a'), { allowed: false, remaining: 0, retryAfterMs: 1000 });
}

// the window is half-open: an event at exactly t - windowMs no longer counts
{
  const { clock, limiter } = make(2, 1000);
  limiter.allow('a'); // t = 1000
  clock.t = 1400;
  limiter.allow('a'); // t = 1400
  clock.t = 1999;
  expectCall('t=1999 still full', limiter.allow('a'), { allowed: false, remaining: 0, retryAfterMs: 1 });
  clock.t = 2000;
  expectCall('t=2000 the first has left', limiter.allow('a'), { allowed: true, remaining: 0, retryAfterMs: 0 });
}

// a denied request is not recorded and does not extend the block; retryAfterMs follows the oldest counted event
{
  const { clock, limiter } = make(2, 1000);
  limiter.allow('a'); // 1000
  clock.t = 1100;
  limiter.allow('a'); // 1100
  clock.t = 1200;
  expectCall('denied at 1200', limiter.allow('a'), { allowed: false, remaining: 0, retryAfterMs: 800 });
  clock.t = 1500;
  expectCall('denied at 1500', limiter.allow('a'), { allowed: false, remaining: 0, retryAfterMs: 500 });
  clock.t = 2000;
  expectCall('allowed at 2000 (the denied ones were not logged)', limiter.allow('a'), { allowed: true, remaining: 0, retryAfterMs: 0 });
  clock.t = 2050;
  expectCall('denied at 2050, oldest is now 1100', limiter.allow('a'), { allowed: false, remaining: 0, retryAfterMs: 50 });
  clock.t = 2100;
  expectCall('allowed at 2100', limiter.allow('a'), { allowed: true, remaining: 0, retryAfterMs: 0 });
}

// remaining after the window slides
{
  const { clock, limiter } = make(3, 1000);
  limiter.allow('a'); // 1000
  clock.t = 1300;
  limiter.allow('a'); // 1300
  clock.t = 1600;
  limiter.allow('a'); // 1600
  clock.t = 2000;
  expectCall('one left the window', limiter.allow('a'), { allowed: true, remaining: 0, retryAfterMs: 0 });
  clock.t = 2300;
  expectCall('another left', limiter.allow('a'), { allowed: true, remaining: 0, retryAfterMs: 0 });
}

// keys are independent
{
  const { limiter } = make(1, 1000);
  expectCall('a first', limiter.allow('a'), { allowed: true, remaining: 0, retryAfterMs: 0 });
  expectCall('b first', limiter.allow('b'), { allowed: true, remaining: 0, retryAfterMs: 0 });
  expectCall('a again', limiter.allow('a'), { allowed: false, remaining: 0, retryAfterMs: 1000 });
}

// size() and the cleanup of forgotten keys, without timers
{
  const { clock, limiter } = make(2, 1000);
  for (const key of ['a', 'b', 'c']) limiter.allow(key);
  if (limiter.size() !== 3) fail(`size() = ${limiter.size()}, expected 3`);
  clock.t = 1999;
  if (limiter.size() !== 3) fail(`size() at 1999 = ${limiter.size()}, expected 3`);
  clock.t = 2000;
  if (limiter.size() !== 0) fail(`size() at 2000 = ${limiter.size()}, expected 0: keys whose events have left the window are forgotten`);
  limiter.allow('d');
  if (limiter.size() !== 1) fail(`size() after one new key = ${limiter.size()}, expected 1`);
  // many keys seen once must not pile up
  for (let i = 0; i < 1000; i++) {
    clock.t += 10;
    limiter.allow(`k${i}`);
  }
  if (limiter.size() > 101) fail(`1000 keys seen once, 10 ms apart, window 1000 ms: size() = ${limiter.size()}, expected at most 101`);
}

// a denied key with no counted events is not kept
{
  const { clock, limiter } = make(1, 100);
  limiter.allow('a');
  clock.t += 100;
  limiter.allow('b');
  if (limiter.size() !== 1) fail(`size() = ${limiter.size()}, expected 1 (only b is inside the window)`);
}

// a fractional window and a large limit
{
  const { clock, limiter } = make(100, 0.5);
  clock.t = 10;
  for (let i = 0; i < 100; i++) limiter.allow('a');
  expectCall('101st', limiter.allow('a'), { allowed: false, remaining: 0, retryAfterMs: 1 });
  clock.t = 10.5;
  expectCall('after 0.5 ms', limiter.allow('a'), { allowed: true, remaining: 99, retryAfterMs: 0 });
}

// the default clock
{
  const limiter = new SlidingWindowLimiter({ limit: 1, windowMs: 60_000 });
  if (limiter.allow('x').allowed !== true || limiter.allow('x').allowed !== false) fail('the default clock (Date.now) does not work');
}

// validation
for (const options of [{ limit: 0, windowMs: 1000 }, { limit: -1, windowMs: 1000 }, { limit: 1.5, windowMs: 1000 }, { limit: '2', windowMs: 1000 }, { limit: 1, windowMs: 0 }, { limit: 1, windowMs: -5 }, { limit: 1, windowMs: Infinity }, { limit: 1, windowMs: Number.NaN }, { limit: 1, windowMs: '1000' }, { windowMs: 1000 }]) {
  try {
    new SlidingWindowLimiter(options);
    fail(`the options ${show(options)} must throw a RangeError`);
  } catch (err) {
    if (err?.name !== 'RangeError') fail(`the options ${show(options)} threw ${err?.name}, expected RangeError`);
  }
}
{
  const { limiter } = make(1, 1000);
  for (const key of ['', undefined, null, 5, {}]) {
    try {
      limiter.allow(key);
      fail(`allow(${show(key)}) must throw a TypeError`);
    } catch (err) {
      if (err?.name !== 'TypeError') fail(`allow(${show(key)}) threw ${err?.name}, expected TypeError`);
    }
  }
}

process.exit(failed === 0 ? 0 : 1);
