// Parses CSV text into rows of strings.
export function parseCsv(text, options = {}) {
  const delimiter = options.delimiter ?? ',';
  if (typeof delimiter !== 'string' || delimiter.length !== 1 || delimiter === '"' || delimiter === '\n' || delimiter === '\r') {
    throw new TypeError('delimiter must be exactly one character that is not a quote or a line break');
  }
  let s = String(text);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);

  const rows = [];
  let row = [];
  let field = '';
  let fieldStart = true;
  let line = 1;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < s.length) {
    const c = s[i];
    if (fieldStart && c === '"') {
      const openedAt = line;
      i++;
      let closed = false;
      while (i < s.length) {
        const d = s[i];
        if (d === '"') {
          if (s[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          closed = true;
          i++;
          break;
        }
        if (d === '\r' && s[i + 1] === '\n') {
          field += '\r\n';
          i += 2;
          line++;
          continue;
        }
        if (d === '\n' || d === '\r') line++;
        field += d;
        i++;
      }
      if (!closed) throw new SyntaxError(`line ${openedAt}: a quote is never closed`);
      fieldStart = false;
      if (i < s.length && s[i] !== delimiter && s[i] !== '\n' && s[i] !== '\r') {
        throw new SyntaxError(`line ${line}: unexpected character after a closing quote`);
      }
      continue;
    }
    if (c === delimiter) {
      endField();
      fieldStart = true;
      i++;
      continue;
    }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      endRow();
      fieldStart = true;
      i++;
      line++;
      continue;
    }
    field += c;
    fieldStart = false;
    i++;
  }
  if (!(fieldStart && row.length === 0 && field === '')) endRow();
  return rows;
}
