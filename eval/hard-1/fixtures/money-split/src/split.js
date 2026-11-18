// Shares an amount of cents between parties in proportion to their weights.
export function splitCents(totalCents, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => Math.round((totalCents * w) / sum));
}
