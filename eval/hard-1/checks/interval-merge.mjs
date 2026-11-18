import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Hidden check of the task "interval-merge". It lives outside the workspace and runs with the workspace as the working folder.
let mergeIntervals;
try {
  ({ mergeIntervals } = await import(pathToFileURL(path.resolve('src', 'merge.js')).href));
} catch (err) {
  console.error(`cannot load src/merge.js: ${err.message}`);
  process.exit(1);
}
if (typeof mergeIntervals !== 'function') {
  console.error('src/merge.js must export a function mergeIntervals');
  process.exit(1);
}

let failed = 0;
const fail = (msg) => {
  failed++;
  console.error(msg);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const cases = [
  [[], undefined, []],
  [[[1, 2]], undefined, [[1, 2]]],
  [[[5, 6], [1, 2]], undefined, [[1, 2], [5, 6]]],
  [[[1, 3], [2, 6], [8, 10], [15, 18]], undefined, [[1, 6], [8, 10], [15, 18]]],
  [[[1, 3], [3, 5]], undefined, [[1, 5]]],
  [[[1, 3], [3, 5]], { touching: false }, [[1, 3], [3, 5]]],
  [[[1, 4], [3, 5]], { touching: false }, [[1, 5]]],
  [[[1, 10], [2, 3]], undefined, [[1, 10]]],
  [[[1, 10], [2, 3], [4, 5]], undefined, [[1, 10]]],
  [[[2, 3], [1, 10]], undefined, [[1, 10]]],
  [[[1, 4], [0, 4]], undefined, [[0, 4]]],
  [[[1, 4], [1, 2]], undefined, [[1, 4]]],
  [[[2, 2], [2, 2]], undefined, [[2, 2]]],
  // (left out on purpose: [[2,2],[2,2]] and [[1,5],[5,5],[5,9]] with touching:false. The README says both "an interval
  // inside another disappears" and "merge only when they overlap by more than a single point": a point on the end of
  // another interval fits both rules, so the README does not decide it. A weaker model read it the first way.)
  [[[1, 3], [2, 2]], { touching: false }, [[1, 3]]],
  [[[1, 2], [3, 4]], undefined, [[1, 2], [3, 4]]],
  [[[-5, -1], [-3, 2], [4, 4]], undefined, [[-5, 2], [4, 4]]],
  [[[0.5, 1.5], [1.5, 2.5]], undefined, [[0.5, 2.5]]],
  [[[1, 5], [2, 3], [4, 8], [9, 9], [8, 9]], undefined, [[1, 9]]],
  [[[1, 6], [2, 3], [5, 9]], { touching: false }, [[1, 9]]],
];
for (const [input, options, expected] of cases) {
  let actual;
  try {
    actual = mergeIntervals(JSON.parse(JSON.stringify(input)), options);
  } catch (err) {
    actual = `threw ${err.name}`;
  }
  if (!same(actual, expected)) fail(`mergeIntervals(${JSON.stringify(input)}, ${JSON.stringify(options)}) = ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

// the input is never changed, also when it is frozen; the result holds new arrays
{
  const inner = [[3, 4], [1, 2], [2, 3]].map((i) => Object.freeze(i));
  const input = Object.freeze(inner);
  let out;
  try {
    out = mergeIntervals(input);
  } catch (err) {
    fail(`a frozen input must work: threw ${err.name}: ${err.message}`);
  }
  if (out && !same(out, [[1, 4]])) fail(`frozen input gave ${JSON.stringify(out)}`);
  if (out && out[0] === inner[1]) fail('the result must hold new interval arrays, not the input ones');
  const plain = [[5, 6], [1, 2]];
  const copy = JSON.stringify(plain);
  mergeIntervals(plain);
  if (JSON.stringify(plain) !== copy) fail('the input list was changed');
  const single = [[1, 2]];
  const result = mergeIntervals(single);
  if (result[0] === single[0]) fail('a single interval must come back as a copy');
}

// validation: the whole input first, with the right error class
const bad = [
  [[[2, 1]], 'RangeError'],
  [[[1, 2], [5, 4]], 'RangeError'],
  [[[1, 2], [Number.NaN, 3]], 'TypeError'],
  [[[1, Infinity]], 'TypeError'],
  [[[1, '2']], 'TypeError'],
  [[[1]], 'TypeError'],
  [[[1, 2, 3]], 'TypeError'],
  [[5], 'TypeError'],
  [[null], 'TypeError'],
  [[[1, 2], 'ab'], 'TypeError'],
];
for (const [input, name] of bad) {
  try {
    const out = mergeIntervals(input);
    fail(`mergeIntervals(${JSON.stringify(input)}) must throw ${name}, returned ${JSON.stringify(out)}`);
  } catch (err) {
    if (err?.name !== name) fail(`mergeIntervals(${JSON.stringify(input)}) threw ${err?.name}, expected ${name}`);
  }
}
if (typeof mergeIntervals !== 'function') fail('not a function');

process.exit(failed === 0 ? 0 : 1);
