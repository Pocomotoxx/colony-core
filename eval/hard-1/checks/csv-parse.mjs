import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Hidden check of the task "csv-parse". It lives outside the workspace and runs with the workspace as the working folder.
let parseCsv;
try {
  ({ parseCsv } = await import(pathToFileURL(path.resolve('src', 'csv.js')).href));
} catch (err) {
  console.error(`cannot load src/csv.js: ${err.message}`);
  process.exit(1);
}
if (typeof parseCsv !== 'function') {
  console.error('src/csv.js must export a function parseCsv');
  process.exit(1);
}

let failed = 0;
const fail = (msg) => {
  failed++;
  console.error(msg);
};
const show = (v) => JSON.stringify(v);
const BOM = String.fromCharCode(0xfeff);

const rowsCases = [
  ['', undefined, []],
  ['a', undefined, [['a']]],
  ['a,b,c', undefined, [['a', 'b', 'c']]],
  ['a,b\nc,d', undefined, [['a', 'b'], ['c', 'd']]],
  ['a,b\nc,d\n', undefined, [['a', 'b'], ['c', 'd']]],
  ['a,b\r\nc,d\r\n', undefined, [['a', 'b'], ['c', 'd']]],
  ['a\rb', undefined, [['a'], ['b']]],
  ['a\n\nb', undefined, [['a'], [''], ['b']]],
  ['\n', undefined, [['']]],
  ['a,b\n\n', undefined, [['a', 'b'], ['']]],
  ['a,\n', undefined, [['a', '']]],
  [',a', undefined, [['', 'a']]],
  [',', undefined, [['', '']]],
  ['"a,b",c', undefined, [['a,b', 'c']]],
  ['"a""b"', undefined, [['a"b']]],
  ['""', undefined, [['']]],
  ['""\n', undefined, [['']]],
  ['"",""', undefined, [['', '']]],
  ['"line1\nline2",x', undefined, [['line1\nline2', 'x']]],
  ['"a\r\nb"', undefined, [['a\r\nb']]],
  ['ab"c,d', undefined, [['ab"c', 'd']]],
  ['  "x",y', undefined, [['  "x"', 'y']]],
  ['a,"b"', undefined, [['a', 'b']]],
  ['"a"\n"b"', undefined, [['a'], ['b']]],
  ['a;b;c', { delimiter: ';' }, [['a', 'b', 'c']]],
  ['"a;b";c', { delimiter: ';' }, [['a;b', 'c']]],
  ['a,b;c', { delimiter: ';' }, [['a,b', 'c']]],
  [`${BOM}a,b`, undefined, [['a', 'b']]],
  [' a , b ', undefined, [[' a ', ' b ']]],
  ['a,b\nc', undefined, [['a', 'b'], ['c']]],
  ['x\ty\n1\t2', { delimiter: '\t' }, [['x', 'y'], ['1', '2']]],
];
for (const [text, options, expected] of rowsCases) {
  let actual;
  try {
    actual = parseCsv(text, options);
  } catch (err) {
    actual = `threw ${err.name}: ${err.message}`;
  }
  if (show(actual) !== show(expected)) fail(`parseCsv(${show(text)}, ${show(options)}) = ${show(actual)}, expected ${show(expected)}`);
}

const syntaxCases = [
  ['"a" ,b', 1],
  ['a\n"b"x', 2],
  ['"abc', 1],
  ['a\n"b\nc', 2],
  ['"a\nb"x', 2],
  ['x\r\n"a', 2],
  ['"a\rb"z', 2],
  ['a\n\n"b', 3],
];
for (const [text, line] of syntaxCases) {
  try {
    const out = parseCsv(text);
    fail(`parseCsv(${show(text)}) must throw SyntaxError, returned ${show(out)}`);
  } catch (err) {
    if (err?.name !== 'SyntaxError') fail(`parseCsv(${show(text)}) threw ${err?.name}, expected SyntaxError`);
    else if (!String(err.message).startsWith(`line ${line}:`)) fail(`parseCsv(${show(text)}): the message "${err.message}" must start with "line ${line}:"`);
  }
}

// (null is left out on purpose: whether it means "not given" is not said in the README)
for (const delimiter of [',,', '"', '\n', '\r', '', 5]) {
  try {
    parseCsv('a,b', { delimiter });
    fail(`delimiter ${show(delimiter)} must throw TypeError`);
  } catch (err) {
    if (err?.name !== 'TypeError') fail(`delimiter ${show(delimiter)} threw ${err?.name}, expected TypeError`);
  }
}

{
  const big = 'a,"b c",d\n'.repeat(5000);
  const started = Date.now();
  const out = parseCsv(big);
  if (out.length !== 5000 || show(out[4999]) !== show(['a', 'b c', 'd'])) fail('a long text was not parsed correctly');
  if (Date.now() - started > 3000) fail('parsing 5000 rows took longer than 3 seconds');
}

process.exit(failed === 0 ? 0 : 1);
