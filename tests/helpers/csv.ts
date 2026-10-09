// Read CSV exports the way a spreadsheet would, so tests can assert which
// value lands under which header instead of grepping for substrings.
import assert from 'node:assert/strict';

/** Minimal RFC 4180 reader: quoted commas, doubled quotes, embedded newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  row.push(field);
  rows.push(row);
  return rows;
}

/**
 * Rows of a titled table section (a one-cell title row, then a header row),
 * each keyed by its header cell. Fails if any row is wider or narrower than
 * the header.
 */
export function csvSection(text: string, title: string): Array<Record<string, string>> {
  const rows = parseCsv(text);
  const start = rows.findIndex(r => r.length === 1 && r[0] === title);
  assert.ok(start >= 0, `missing section ${title}`);
  const header = rows[start + 1];
  const out: Array<Record<string, string>> = [];
  for (const r of rows.slice(start + 2)) {
    if (r.length === 1 && r[0] === '') break;
    assert.equal(r.length, header.length, `${title}: row width differs from header`);
    out.push(Object.fromEntries(header.map((h, i) => [h, r[i]])));
  }
  return out;
}
