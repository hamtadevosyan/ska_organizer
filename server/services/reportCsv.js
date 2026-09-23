// Quote every field and neutralize formula-like prefixes, including full-width
// characters and prefixes hidden by whitespace/control characters. Escaping is
// applied to metadata (e.g. room names) as well as table cells.
function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s\p{Cc}\p{Cf}]*[=+\-@]/u.test(text.normalize('NFKC')) || /^[\p{Cc}\p{Cf}]/u.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
function reportCsv(report) {
  const metadata = [
    ['Report', report.title], ['From', report.filters.from], ['To', report.filters.to],
    ...(report.kind === 'attendance' ? [['Room', report.filters.roomName]] : []),
    ['Facility time zone', report.timeZone], ['Generated', report.generatedLabel],
    ...report.summary.map(({ label, value }) => [label, value]),
    ...report.notes.map((note) => ['Note', note]),
  ];
  const rows = [...metadata, [], report.columns.map(({ label }) => label),
    ...report.rows.map((row) => report.columns.map(({ key }) => row[key]))];
  // UTF-8 BOM helps spreadsheet applications recognize non-English names.
  return '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
module.exports = { reportCsv };
