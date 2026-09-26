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
