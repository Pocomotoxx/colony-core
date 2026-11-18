// ISO week helpers (dates are read as UTC).

const DAY = 24 * 60 * 60 * 1000;

export function dayOfYear(date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const current = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.round((current - start) / DAY) + 1;
}

// Week number: weeks counted from January 1st, a week starts on Monday.
export function isoWeek(date) {
  const jan1Weekday = new Date(Date.UTC(date.getUTCFullYear(), 0, 1)).getUTCDay();
  return Math.ceil((dayOfYear(date) + jan1Weekday) / 7);
}

export function isoWeekYear(date) {
  return date.getUTCFullYear();
}
