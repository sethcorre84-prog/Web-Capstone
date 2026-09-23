// datetime-prefs.js
// The admin's Date & Time preference (Settings > General Settings > Date & Time)
// and the formatters every page uses to show record dates with it.
//
// The preference is stored in localStorage, like the rest of Settings, so it is
// read synchronously and the first render already uses it. It is per browser.
//
// Pages keep their own "no date" fallbacks ('—', 'N/A', ...): these formatters
// return '' for anything that is not a real date, so check before calling or
// use `|| fallback`.

const STORAGE_KEY = 'peakpath-datetime';

export const TIME_ZONES = [
  { value: 'Asia/Manila', label: '(UTC+08:00) Philippine Time' },
  { value: 'UTC', label: '(UTC+00:00) Coordinated Universal Time' },
  { value: 'America/New_York', label: 'US Eastern Time (UTC−05:00 / −04:00)' }
];

// Labels are an example date, so the choice is obvious at a glance.
export const DATE_FORMATS = [
  { value: 'MMM D, YYYY', label: 'Sep 21, 2026' },
  { value: 'MM/DD/YYYY', label: '09/21/2026' },
  { value: 'DD/MM/YYYY', label: '21/09/2026' },
  { value: 'YYYY-MM-DD', label: '2026-09-21' }
];

// 'MMM D, YYYY' in Manila is what every page showed before this setting
// existed, so an admin who never opens it sees no change.
const DEFAULTS = { timeZone: 'Asia/Manila', dateFormat: 'MMM D, YYYY' };

const isKnown = (list, value) => list.some((item) => item.value === value);

function readPrefs() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return {
      timeZone: isKnown(TIME_ZONES, stored.timeZone) ? stored.timeZone : DEFAULTS.timeZone,
      dateFormat: isKnown(DATE_FORMATS, stored.dateFormat) ? stored.dateFormat : DEFAULTS.dateFormat
    };
  } catch {
    // Blocked or corrupt storage: fall back rather than break every date.
    return { ...DEFAULTS };
  }
}

// Tables format hundreds of dates per render, so the preference and the Intl
// formatters built from it are cached, and rebuilt only when it changes.
let prefs = readPrefs();
let formatters = buildFormatters(prefs);

function buildFormatters({ timeZone }) {
  return {
    medium: new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', year: 'numeric' }),
    numeric: new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }),
    time: new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' })
  };
}

function applyPrefs(next) {
  prefs = next;
  formatters = buildFormatters(prefs);
}

// Another tab saved new settings: pick them up so the next render uses them.
window.addEventListener('storage', (event) => {
  if (event.key === STORAGE_KEY) applyPrefs(readPrefs());
});

export function getDateTimePrefs() {
  return { ...prefs };
}

export function saveDateTimePrefs(next) {
  const merged = {
    timeZone: isKnown(TIME_ZONES, next?.timeZone) ? next.timeZone : prefs.timeZone,
    dateFormat: isKnown(DATE_FORMATS, next?.dateFormat) ? next.dateFormat : prefs.dateFormat
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  applyPrefs(merged);
  return { ...merged };
}

// The chosen IANA zone, for pages that build their own Intl options (clocks).
export function portalTimeZone() {
  return prefs.timeZone;
}

// Firestore Timestamp, {seconds}, Date, ISO string or epoch ms -> Date | null.
export function toPortalDate(value) {
  if (value === null || value === undefined || value === '') return null;
  let date;
  if (typeof value.toDate === 'function') date = value.toDate();
  else if (value instanceof Date) date = value;
  else if (typeof value === 'object' && typeof value.seconds === 'number') date = new Date(value.seconds * 1000);
  else date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateWith(date, dateFormat, fmts) {
  if (dateFormat === 'MMM D, YYYY') return fmts.medium.format(date);

  // Build numeric formats from parts: locale patterns (en-GB etc.) would also
  // change separators and month names, not just the order.
  const parts = {};
  fmts.numeric.formatToParts(date).forEach(({ type, value }) => { parts[type] = value; });
  const { year, month, day } = parts;
  if (dateFormat === 'DD/MM/YYYY') return `${day}/${month}/${year}`;
  if (dateFormat === 'YYYY-MM-DD') return `${year}-${month}-${day}`;
  return `${month}/${day}/${year}`;
}

export function formatPortalDate(value) {
  const date = toPortalDate(value);
  return date ? formatDateWith(date, prefs.dateFormat, formatters) : '';
}

// Formats with a candidate preference instead of the saved one, so the
// Settings dialog can preview a choice before it is saved.
export function previewDateTime(value, candidate) {
  const date = toPortalDate(value);
  if (!date) return '';
  const fmts = buildFormatters(candidate);
  return `${formatDateWith(date, candidate.dateFormat, fmts)} ${fmts.time.format(date)}`;
}

export function formatPortalTime(value) {
  const date = toPortalDate(value);
  return date ? formatters.time.format(date) : '';
}

export function formatPortalDateTime(value) {
  const date = toPortalDate(value);
  return date ? `${formatPortalDate(date)} ${formatPortalTime(date)}` : '';
}
