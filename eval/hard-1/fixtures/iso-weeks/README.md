# ISO weeks

Three modules in `src/` work with ISO 8601 week dates. Weekly reports are wrong around the turn of the year; the other modules disagree with the standard, too.

The rules of ISO 8601 week dates:

- A week starts on Monday and ends on Sunday.
- Week 1 of a year is the week that contains the first Thursday of that year (equivalently: the week with January 4th).
- So the first days of January can belong to the last week (52 or 53) of the PREVIOUS year, and the last days of December can belong to week 1 of the NEXT year. The year a date belongs to in this system is its ISO week-year, which can differ from its calendar year.
- A year has 53 weeks if January 1st is a Thursday, or if it is a leap year and January 1st is a Wednesday. All other years have 52 weeks.

Examples: `2026-12-31` is in `2026-W53`; `2027-01-01` is also in `2026-W53`; `2024-12-30` is in `2025-W01`; `2021-01-03` is in `2020-W53`.

Dates are treated as UTC. A `Date` is read with its UTC getters (`getUTCFullYear`, `getUTCMonth`, `getUTCDate`, `getUTCDay`); text dates are `YYYY-MM-DD` and mean midnight UTC of that day.

The modules:

- `src/dates.js`: `isoWeek(date)` returns the ISO week number (1 to 53) of a `Date`; `isoWeekYear(date)` returns its ISO week-year.
- `src/calendar.js`: `weeksInYear(year)` returns 52 or 53.
- `src/report.js`: `weeklyTotals(entries)` takes `[{ date: 'YYYY-MM-DD', amount: number }]` and returns `[{ week: '2026-W53', total: number }]`, one object per ISO week that has entries, sorted by week (oldest first). The week label is the ISO week-year, `-W`, and the week number with two digits. A `total` is the sum of the `amount`s of that week.

All three must follow the standard. Fix the code in `src/` so that they do.
