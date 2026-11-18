// ISO week helpers (dates are read as UTC).

const DAY = 24 * 60 * 60 * 1000;

export function dayOfYear(date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const current = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.round((current - start) / DAY) + 1;
}

// The Thursday of the week of a date decides both the week-year and, counted from January 1st of that year, the week.
function thursdayOf(date) {
  const day = date.getUTCDay() || 7;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 4 - day));
}

export function isoWeek(date) {
  const thursday = thursdayOf(date);
  return Math.ceil(dayOfYear(thursday) / 7);
}

export function isoWeekYear(date) {
  return thursdayOf(date).getUTCFullYear();
}
