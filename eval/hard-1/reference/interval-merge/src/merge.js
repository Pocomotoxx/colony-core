// Merges closed intervals [start, end].
export function mergeIntervals(list, options = {}) {
  const touching = options.touching ?? true;
  if (!Array.isArray(list)) throw new TypeError('list must be an array');
  for (const item of list) {
    if (!Array.isArray(item) || item.length !== 2) throw new TypeError('an interval must be an array of two numbers');
    for (const v of item) {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError('interval bounds must be finite numbers');
    }
    if (item[0] > item[1]) throw new RangeError('start is greater than end');
  }
  const sorted = list.map(([s, e]) => [s, e]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && (touching ? start <= last[1] : start < last[1])) {
      last[1] = Math.max(last[1], end);
    } else {
      out.push([start, end]);
    }
  }
  return out;
}
