// Shares an amount of cents between parties in proportion to their weights.
export function splitCents(totalCents, weights) {
  if (!Number.isInteger(totalCents)) throw new TypeError('totalCents must be an integer');
  if (!Array.isArray(weights) || weights.length === 0) throw new TypeError('weights must be a non-empty array');
  const SCALE = 1_000_000;
  const w = weights.map((x) => {
    if (typeof x !== 'number' || !Number.isFinite(x)) throw new TypeError('a weight must be a finite number');
    if (x < 0) throw new RangeError('a weight must not be negative');
    return BigInt(Math.round(x * SCALE));
  });
  const sum = w.reduce((a, b) => a + b, 0n);
  if (sum === 0n) throw new RangeError('at least one weight must be positive');

  const negative = totalCents < 0;
  const total = BigInt(Math.abs(totalCents));
  const shares = w.map((x) => (total * x) / sum);
  const remainders = w.map((x, index) => ({ index, r: (total * x) % sum }));
  let left = total - shares.reduce((a, b) => a + b, 0n);
  remainders.sort((a, b) => (a.r === b.r ? a.index - b.index : a.r > b.r ? -1 : 1));
  for (const { index } of remainders) {
    if (left === 0n) break;
    shares[index] += 1n;
    left -= 1n;
  }
  return shares.map((s) => (negative && s !== 0n ? -Number(s) : Number(s)));
}
