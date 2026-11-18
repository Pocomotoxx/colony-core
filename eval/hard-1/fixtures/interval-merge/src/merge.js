// Merges closed intervals [start, end].
export function mergeIntervals(list, options = {}) {
  const touching = options.touching ?? true;
  list.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [start, end] of list) {
    const last = out[out.length - 1];
    if (last && (touching ? start <= last[1] : start < last[1])) {
      last[1] = end;
    } else {
      out.push([start, end]);
    }
  }
  return out;
}
