// Calendar helpers.

const isLeap = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

export function weeksInYear(year) {
  const jan1 = new Date(Date.UTC(year, 0, 1)).getUTCDay();
  return jan1 === 4 || (isLeap(year) && jan1 === 3) ? 53 : 52;
}
