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

// Every time is shown in Philippine Time; the admin only picks how the hour
// is written.
const TIME_ZONE = 'Asia/Manila';

export const TIME_FORMATS = [
  { value: '12h', label: 'Philippine Time (12-hour) — 3:45 PM' },
  { value: '24h', label: 'Military Time (24-hour) — 15:45' }
];

// Labels are an example date, so the choice is obvious at a glance.
export const DATE_FORMATS = [
  { value: 'MMM D, YYYY', label: 'Sep 21, 2026' },
  { value: 'MM/DD/YYYY', label: '09/21/2026' },
  { value: 'DD/MM/YYYY', label: '21/09/2026' },
  { value: 'YYYY-MM-DD', label: '2026-09-21' }
];

// 12-hour 'MMM D, YYYY' in Manila is what every page showed before this
// setting existed, so an admin who never opens it sees no change.
const DEFAULTS = { timeZone: TIME_ZONE, timeFormat: '12h', dateFormat: 'MMM D, YYYY' };

const isKnown = (list, value) => list.some((item) => item.value === value);

function readPrefs() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    // A zone saved before this was fixed to Manila is simply ignored.
    return {
      timeZone: TIME_ZONE,
      timeFormat: isKnown(TIME_FORMATS, stored.timeFormat) ? stored.timeFormat : DEFAULTS.timeFormat,
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

// A function declaration, not a const: buildFormatters() runs while the
// module is still loading, before a const below it would exist.
function hourCycleFor(timeFormat) {
  return timeFormat === '24h' ? 'h23' : 'h12';
}

function buildFormatters({ timeZone, timeFormat }) {
  const military = timeFormat === '24h';
  return {
    medium: new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', year: 'numeric' }),
    numeric: new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }),
    // Military time is always two-digit hours: 09:05, 15:45.
    time: new Intl.DateTimeFormat('en-US', { timeZone, hour: military ? '2-digit' : 'numeric', minute: '2-digit', hourCycle: hourCycleFor(timeFormat) })
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
    timeZone: TIME_ZONE,
    timeFormat: isKnown(TIME_FORMATS, next?.timeFormat) ? next.timeFormat : prefs.timeFormat,
    dateFormat: isKnown(DATE_FORMATS, next?.dateFormat) ? next.dateFormat : prefs.dateFormat
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  applyPrefs(merged);
  return { ...merged };
}

// The portal's IANA zone, for pages that build their own Intl options (clocks).
export function portalTimeZone() {
  return prefs.timeZone;
}

// 'h12' or 'h23' for those same clocks, so they follow Philippine / Military Time.
export function portalHourCycle() {
  return hourCycleFor(prefs.timeFormat);
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
