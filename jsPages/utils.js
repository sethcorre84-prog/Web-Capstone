// utils.js
// Small text helpers every admin page used to define for itself.
// Dates live in datetime-prefs.js (toPortalDate and the formatters).

// Escapes a value for use inside HTML text or a quoted attribute.
// null/undefined become '', anything else is converted with String().
export const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

// Any value -> trimmed string ('' for null/undefined).
export const normalizeText = (value) => String(value ?? '').trim();

// Hazard report lists in ID order, newest first: RES-2026-0003, 0002, 0001 ...
// (or AR-, A-, R-, HR-), by year then number, descending. report-ids.js
// keeps the numbers gap-free, so every list ends at 0001. Reports without an
// ID of that form (older data) go after the numbered ones, newest first by
// getDate(report).
export function sortByReportId(reports, getDate = () => null) {
  const keyOf = (report) => {
    const match = /^[A-Z]+-(\d{4})-(\d+)$/.exec(report.reportId || '');
    if (match) return [0, Number(match[1]), Number(match[2])];
    const date = getDate(report);
    return [1, date && !Number.isNaN(date.getTime()) ? date.getTime() : 0, 0];
  };
  return reports
    .map((report) => ({ report, key: keyOf(report) }))
    .sort((a, b) => a.key[0] - b.key[0] || b.key[1] - a.key[1] || b.key[2] - a.key[2])
    .map(({ report }) => report);
}
