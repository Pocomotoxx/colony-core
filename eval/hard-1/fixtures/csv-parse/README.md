# parseCsv

`parseCsv(text, options)` in `src/csv.js` parses CSV text into an array of rows. A row is an array of strings.

- `options.delimiter` is exactly one character, default `,`. Anything else (also a quote or a line break character) throws a `TypeError`.
- A field may be wrapped in double quotes. Inside quotes the delimiter and line breaks are ordinary characters, and `""` stands for one quote character. The quotes themselves are not part of the value.
- A quote that is not at the very start of a field is an ordinary character: `ab"c` is the field `ab"c`, and `  "x"` (spaces first) is the field `  "x"` with its quotes.
- A row ends with `\n`, `\r\n` or a lone `\r`. A line break at the very end of the text does not start another row. An empty text gives `[]`.
- A blank line gives a row with one empty field: `[""]`. So `"a\n\nb"` gives `[["a"], [""], ["b"]]`.
- A field that is only `""` is an empty string, and the row it is in exists: the text `""` gives `[[""]]`.
- A leading byte order mark (U+FEFF) is removed. Fields are never trimmed.
- Rows may have different numbers of fields; nothing is padded or checked.
- Two problems throw a `SyntaxError`. The message starts with `line N:` where N counts from 1 and counts every line break, also the ones inside quotes:
  - a quote that is never closed: N is the line where that quote was opened;
  - something other than the delimiter, a line break or the end of the text right after a closing quote: N is the line of that character.
