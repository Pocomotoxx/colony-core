# splitCents

`splitCents(totalCents, weights)` in `src/split.js` shares an amount of money between parties in proportion to their weights.

- `totalCents` is an integer number of cents (it may be negative or zero). `weights` is a non-empty array of numbers, one per party. A weight is a decimal number with at most 6 decimal places (`0.1`, `2`, `0.333333`), never negative; a weight of `0` is allowed.
- It returns an array of integers, one share per party, in the same order as `weights`. The shares always add up to exactly `totalCents`, with no cent lost or invented.
- The shares follow the largest remainder method, computed EXACTLY (no floating-point drift decides who gets a cent): every party first gets the whole cents of its exact proportional share, and the cents that are left go one each to the parties with the largest fractional remainders. When remainders are equal, the party with the lower index comes first. A party with weight `0` always gets `0`.
- A negative `totalCents` is split the same way as its absolute value, with every share negated: `splitCents(-100, [1, 1, 1])` is `[-34, -33, -33]`. There is never a `-0` in the result.
- Amounts up to `Number.MAX_SAFE_INTEGER` cents must work.
- A `totalCents` that is not an integer, a `weights` that is not a non-empty array, or a weight that is not a finite number throws a `TypeError`. A negative weight, or weights that are all zero, throws a `RangeError`.

Examples: `splitCents(100, [1, 1, 1])` is `[34, 33, 33]`, `splitCents(100, [0.1, 0.2, 0.7])` is `[10, 20, 70]`, `splitCents(10, [1, 2, 3])` is `[2, 3, 5]`.
