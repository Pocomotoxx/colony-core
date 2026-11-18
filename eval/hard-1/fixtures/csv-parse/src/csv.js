// Parses CSV text into rows of strings.
export function parseCsv(text, options = {}) {
  const delimiter = options.delimiter ?? ',';
  return text.split('\n').map((line) => line.split(delimiter));
}
