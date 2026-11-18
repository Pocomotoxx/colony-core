# mergeIntervals

`mergeIntervals(list, options)` in `src/merge.js` merges closed intervals `[start, end]` of numbers.

- It returns a NEW array of NEW `[start, end]` arrays, sorted by start. The input list and its intervals are never changed.
- Two intervals merge when they overlap or touch: `[1, 3]` and `[3, 5]` become `[1, 5]`. With `{ touching: false }` they merge only when they overlap by more than a single point: `[1, 3]` and `[3, 5]` stay apart, `[1, 4]` and `[3, 5]` become `[1, 5]`.
- An interval inside another one disappears into it: `[1, 10]` and `[2, 3]` give `[1, 10]`.
- `[]` gives `[]`. A single interval comes back as a copy.
- An interval with `start > end` throws a `RangeError`. A value that is not a finite number, or an interval that is not an array of exactly two items, throws a `TypeError`. (`start === end` is fine: a point.)
- The whole input is checked before anything else happens: if one interval is invalid, nothing is returned.
