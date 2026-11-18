import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Hidden check of the task "money-split". It lives outside the workspace and runs with the workspace as the working folder.
let splitCents;
try {
  ({ splitCents } = await import(pathToFileURL(path.resolve('src', 'split.js')).href));
} catch (err) {
  console.error(`cannot load src/split.js: ${err.message}`);
  process.exit(1);
}
if (typeof splitCents !== 'function') {
  console.error('src/split.js must export a function splitCents');
  process.exit(1);
}

let failed = 0;
const fail = (msg) => {
  failed++;
  if (failed <= 40) console.error(msg);
};
const show = (v) => JSON.stringify(v);

const table = [
  [100, [1, 1, 1], [34, 33, 33]],
  [100, [0.1, 0.2, 0.7], [10, 20, 70]],
  [30, [0.1, 0.2, 0.3], [5, 10, 15]],
  [3, [0.1, 0.1, 0.1], [1, 1, 1]],
  [7, [0.7, 0.7, 0.7], [3, 2, 2]],
  [1, Array(10).fill(0.1), [1, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
  [10, [1, 2, 3], [2, 3, 5]],
  [1, [1, 1], [1, 0]],
  [1, [0.5, 0.5], [1, 0]],
  [0, [1, 2], [0, 0]],
  [0, [1], [0]],
  [7, [0, 1, 0], [0, 7, 0]],
  [7, [1, 0, 1], [4, 0, 3]],
  [5, [1, 1, 1, 1], [2, 1, 1, 1]],
  [2, [1, 1, 1], [1, 1, 0]],
  [100, [33.33, 33.33, 33.34], [33, 33, 34]],
  [1000, [0.333333, 0.333333, 0.333334], [333, 333, 334]],
  [-100, [1, 1, 1], [-34, -33, -33]],
  [-7, [1, 0, 1], [-4, 0, -3]],
  [-1, [1, 1], [-1, 0]],
  [9007199254740991, [1, 1], [4503599627370496, 4503599627370495]],
  [5, [3], [5]],
  [99, [1, 1], [50, 49]],
  [1, [0, 0, 1, 0], [0, 0, 1, 0]],
];
for (const [total, weights, expected] of table) {
  let actual;
  try {
    actual = splitCents(total, weights);
  } catch (err) {
    actual = `threw ${err.name}: ${err.message}`;
  }
  if (show(actual) !== show(expected)) fail(`splitCents(${total}, ${show(weights)}) = ${show(actual)}, expected ${show(expected)}`);
}

// there is never a -0
for (const [total, weights] of [[0, [1, 1]], [-3, [1, 0, 2]], [-1, [0, 1]]]) {
  const out = splitCents(total, weights);
  if (out.some((v) => Object.is(v, -0))) fail(`splitCents(${total}, ${show(weights)}) holds a -0: ${show(out)}`);
}

// an independent computation with exact integers, for many generated cases
function reference(total, weights) {
  const w = weights.map((x) => BigInt(Math.round(x * 1e6)));
  const sum = w.reduce((a, b) => a + b, 0n);
  const abs = BigInt(Math.abs(total));
  const parts = w.map((x, index) => ({ index, whole: (abs * x) / sum, rest: (abs * x) % sum }));
  let left = abs - parts.reduce((a, p) => a + p.whole, 0n);
  const order = [...parts].sort((a, b) => (b.rest > a.rest ? 1 : b.rest < a.rest ? -1 : a.index - b.index));
  for (const p of order) {
    if (left === 0n) break;
    p.whole += 1n;
    left -= 1n;
  }
  return parts.map((p) => (total < 0 && p.whole !== 0n ? -Number(p.whole) : Number(p.whole)));
}
let seed = 20261118;
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
for (let n = 0; n < 400; n++) {
  const parties = 1 + Math.floor(rand() * 8);
  const weights = Array.from({ length: parties }, () => {
    const kind = rand();
    if (kind < 0.2) return 0;
    if (kind < 0.6) return Math.floor(rand() * 1000);
    return Math.floor(rand() * 5_000_000) / 1_000_000;
  });
  if (weights.every((x) => x === 0)) weights[0] = 1;
  const big = rand() < 0.15;
  let total = big ? Math.floor(rand() * 9007199254740991) : Math.floor(rand() * 100000);
  if (rand() < 0.3) total = -total;
  const expected = reference(total, weights);
  let actual;
  try {
    actual = splitCents(total, weights);
  } catch (err) {
    actual = `threw ${err.name}: ${err.message}`;
  }
  if (show(actual) !== show(expected)) fail(`splitCents(${total}, ${show(weights)}) = ${show(actual)}, expected ${show(expected)}`);
  else if (actual.reduce((a, b) => a + b, 0) !== total && !big) fail(`the shares of splitCents(${total}, ${show(weights)}) do not add up`);
}

const wrong = [
  [[1.5, [1, 1]], 'TypeError'],
  [['5', [1, 1]], 'TypeError'],
  [[Number.NaN, [1]], 'TypeError'],
  [[Infinity, [1]], 'TypeError'],
  [[10, []], 'TypeError'],
  [[10, 'ab'], 'TypeError'],
  [[10, null], 'TypeError'],
  [[10, [Number.NaN]], 'TypeError'],
  [[10, [Infinity, 1]], 'TypeError'],
  [[10, ['1', 1]], 'TypeError'],
  [[10, [1, null]], 'TypeError'],
  [[10, [-1, 2]], 'RangeError'],
  [[10, [0, 0]], 'RangeError'],
  [[10, [0]], 'RangeError'],
];
for (const [args, name] of wrong) {
  try {
    const out = splitCents(...args);
    fail(`splitCents(${args.map(show).join(', ')}) must throw ${name}, returned ${show(out)}`);
  } catch (err) {
    if (err?.name !== name) fail(`splitCents(${args.map(show).join(', ')}) threw ${err?.name}, expected ${name}`);
  }
}

process.exit(failed === 0 ? 0 : 1);
