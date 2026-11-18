import { isoWeek, isoWeekYear } from './dates.js';

const pad = (n) => String(n).padStart(2, '0');

// Sums the amounts of entries per ISO week.
export function weeklyTotals(entries) {
  const totals = new Map();
  for (const entry of entries) {
    const date = new Date(`${entry.date}T00:00:00Z`);
    const label = `${isoWeekYear(date)}-W${pad(isoWeek(date))}`;
    totals.set(label, (totals.get(label) ?? 0) + entry.amount);
  }
  return [...totals.entries()]
    .map(([week, total]) => ({ week, total }))
    .sort((a, b) => a.week.localeCompare(b.week));
}
