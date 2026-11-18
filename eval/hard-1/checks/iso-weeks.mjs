import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Hidden check of the task "iso-weeks". It lives outside the workspace and runs with the workspace as the working folder.
const load = async (file) => {
  try {
    return await import(pathToFileURL(path.resolve('src', file)).href);
  } catch (err) {
    console.error(`cannot load src/${file}: ${err.message}`);
    process.exit(1);
  }
};
const { isoWeek, isoWeekYear } = await load('dates.js');
const { weeksInYear } = await load('calendar.js');
const { weeklyTotals } = await load('report.js');
for (const [name, fn] of [['isoWeek', isoWeek], ['isoWeekYear', isoWeekYear], ['weeksInYear', weeksInYear], ['weeklyTotals', weeklyTotals]]) {
  if (typeof fn !== 'function') {
    console.error(`${name} must be an exported function`);
    process.exit(1);
  }
}

let failed = 0;
const fail = (msg) => {
  failed++;
  if (failed <= 40) console.error(msg);
};

// the standard, computed independently: the Thursday of the week decides the week-year and the week
function expected(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return { year, week };
}

// known anchors from the README
const anchors = [
  ['2026-12-31', 2026, 53],
  ['2027-01-01', 2026, 53],
  ['2024-12-30', 2025, 1],
  ['2021-01-03', 2020, 53],
  ['2021-01-04', 2021, 1],
  ['2020-12-31', 2020, 53],
  ['2019-12-29', 2019, 52],
  ['2019-12-30', 2020, 1],
  ['2015-12-31', 2015, 53],
  ['2016-01-03', 2015, 53],
  ['2016-01-04', 2016, 1],
  ['2012-01-01', 2011, 52],
  ['2023-01-01', 2022, 52],
  ['2023-01-02', 2023, 1],
  ['2024-02-29', 2024, 9],
];
for (const [text, year, week] of anchors) {
  const d = new Date(`${text}T00:00:00Z`);
  if (isoWeekYear(d) !== year || isoWeek(d) !== week) fail(`${text}: got ${isoWeekYear(d)}-W${isoWeek(d)}, expected ${year}-W${week}`);
}

// every day from 2000 to 2040
for (let t = Date.UTC(2000, 0, 1); t < Date.UTC(2041, 0, 1); t += 86400000) {
  const d = new Date(t);
  const e = expected(d);
  const gotYear = isoWeekYear(d);
  const gotWeek = isoWeek(d);
  if (gotYear !== e.year || gotWeek !== e.week) fail(`${d.toISOString().slice(0, 10)}: got ${gotYear}-W${gotWeek}, expected ${e.year}-W${e.week}`);
}

// the weeks in a year: 53 or 52, by the standard (the week number of December 28th is the last week of the year)
for (let year = 1970; year <= 2100; year++) {
  const want = expected(new Date(Date.UTC(year, 11, 28))).week;
  if (weeksInYear(year) !== want) fail(`weeksInYear(${year}) = ${weeksInYear(year)}, expected ${want}`);
}
for (const year of [2004, 2009, 2015, 2020, 2026, 2032]) {
  if (weeksInYear(year) !== 53) fail(`weeksInYear(${year}) must be 53`);
}
for (const year of [2019, 2021, 2022, 2023, 2024, 2025, 2027]) {
  if (weeksInYear(year) !== 52) fail(`weeksInYear(${year}) must be 52`);
}

// the report
const sameTotals = (actual, want) => JSON.stringify(actual) === JSON.stringify(want);
{
  const entries = [
    { date: '2026-12-28', amount: 10 },
    { date: '2026-12-31', amount: 5 },
    { date: '2027-01-01', amount: 1 },
    { date: '2027-01-03', amount: 2 },
    { date: '2027-01-04', amount: 100 },
    { date: '2024-12-29', amount: 7 },
    { date: '2024-12-30', amount: 3 },
    { date: '2025-01-05', amount: 4 },
  ];
  const got = weeklyTotals(entries);
  const want = [
    { week: '2024-W52', total: 7 },
    { week: '2025-W01', total: 7 },
    { week: '2026-W53', total: 18 },
    { week: '2027-W01', total: 100 },
  ];
  if (!sameTotals(got, want)) fail(`weeklyTotals: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  if (!sameTotals(weeklyTotals([]), [])) fail('weeklyTotals([]) must be []');
  const single = weeklyTotals([{ date: '2021-01-03', amount: 2.5 }, { date: '2021-01-01', amount: 0.5 }]);
  if (!sameTotals(single, [{ week: '2020-W53', total: 3 }])) fail(`weeklyTotals around 2021-01-01: got ${JSON.stringify(single)}`);
  const sorted = weeklyTotals([{ date: '2022-03-01', amount: 1 }, { date: '2021-12-01', amount: 1 }, { date: '2022-01-10', amount: 1 }]).map((x) => x.week);
  if (JSON.stringify(sorted) !== JSON.stringify(['2021-W48', '2022-W02', '2022-W09'])) fail(`weeks must be sorted oldest first: ${JSON.stringify(sorted)}`);
}

// every day of 2014 to 2027 through the report: the label must follow the standard
{
  const entries = [];
  for (let t = Date.UTC(2014, 0, 1); t < Date.UTC(2028, 0, 1); t += 86400000) entries.push({ date: new Date(t).toISOString().slice(0, 10), amount: 1 });
  const got = weeklyTotals(entries);
  const want = new Map();
  for (const e of entries) {
    const x = expected(new Date(`${e.date}T00:00:00Z`));
    const label = `${x.year}-W${String(x.week).padStart(2, '0')}`;
    want.set(label, (want.get(label) ?? 0) + 1);
  }
  const wantList = [...want.entries()].map(([week, total]) => ({ week, total })).sort((a, b) => a.week.localeCompare(b.week));
  if (!sameTotals(got, wantList)) {
    const bad = wantList.find((w, i) => JSON.stringify(w) !== JSON.stringify(got[i]));
    fail(`the weekly totals of 2014 to 2027 differ from the standard, first at ${JSON.stringify(bad)} (got ${JSON.stringify(got[wantList.indexOf(bad)])})`);
  }
}

process.exit(failed === 0 ? 0 : 1);
