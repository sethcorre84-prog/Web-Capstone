// GENERATED from jsPages/hike-summary.js by tool/copy-shared-to-functions.mjs
// at every functions deploy. Do not edit: change jsPages/hike-summary.js instead.

// hike-summary.js
// The hikeSummaries/{uid} document for one hiker: first and last hike, the
// totals and the hikes per month, as the portal counts them. One builder for
// the Cloud Function that keeps the collection up to date (functions/index.js
// updateHikeSummary*, which use a copy of this file made at deploy) and for
// tool/write-hike-summaries.mjs, so both always write the same thing.
//
// Pure: no Firestore, no browser. Dates are returned as Date objects; the
// caller adds generatedAt when it writes.

import { firstAndLastHike, isHikerAccount, monthlyVisits, datedHikes } from './hike-events.mjs';
import { hikeHistory } from './hike-history.mjs';

const RESULT = { completed: 'Completed', partial: 'Partial', ended: 'Ended early' };
const PRECISION = { time: 'exact time', day: 'exact day', month: 'month only' };

/* user      the users/{uid} document's data with its id as `id`
   sessions  hikeSessions documents (any; only this hiker's are used)
   trails    every trails document, with `id` (deleted trails drop out)
   Returns the document's fields, or null when the account is not a hiker
   or has no hike: no summary is kept for it. */
export function buildHikeSummary(user, { sessions = [], trails = [], timeZone = 'Asia/Manila' } = {}) {
  if (!user || !isHikerAccount(user)) return null;
  const mine = sessions.filter((session) => String(session.uid || '').trim() === String(user.id));
  const visit = monthlyVisits({ users: [user], sessions: mine, trails, timeZone }).get(String(user.id));
  const total = hikeHistory(user).total;
  if (!visit && !total) return null;

  const monthName = (date) => date.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone });
  const dayName = (date) => date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone });
  const describe = (hike) => !hike
    ? { precision: 'not recorded', date: null, day: null, month: null, trails: [], result: null, minutes: null }
    : {
      precision: PRECISION[hike.precision] || 'exact day',
      // A month-only hike keeps no day: only its month is stored.
      date: hike.precision === 'month' ? null : hike.date,
      // The same date as text, in Philippine time (Firestore shows UTC).
      day: hike.precision === 'month' ? null : dayName(hike.date),
      month: monthName(hike.date),
      trails: hike.trails,
      result: RESULT[hike.status] || null,
      minutes: Number.isFinite(hike.minutes) ? Math.round(hike.minutes * 100) / 100 : null
    };

  const { first, last } = firstAndLastHike(user, mine, trails, timeZone);
  const hikes = datedHikes([user], mine, timeZone, trails);
  const completed = Math.floor(Number(user.completedHikes) || 0);
  const partial = Math.floor(Number(user.partialHikes) || 0);
  const lifetime = Math.max(total, completed + partial);
  const estimated = visit ? visit.estimated : 0;
  const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

  return {
    uid: String(user.id),
    fullName: user.fullName || user.username || '',
    username: user.username || '',
    accountType: user.sessionDataSource ? 'Imported dummy data' : 'App user',
    totals: {
      hikes: lifetime,
      completed,
      partial,
      endedEarly: Math.max(0, lifetime - completed - partial),
      km: round(user.hikeTotalKm),
      minutes: round(user.hikeTotalMinutes)
    },
    firstHike: describe(first),
    lastHike: describe(last),
    hikesByMonth: Object.fromEntries(Object.entries(visit?.months || {}).sort().map(([key, month]) => [
      key.replace(/^m(\d{4})_(\d{2})$/, '$1-$2'),
      { hikes: month.count, completed: month.completed, partial: month.partial }
    ])),
    hikesWithAssumedDate: estimated,
    dateNote: estimated
      ? `${estimated} of ${lifetime} hikes have no date of their own and are counted on the last hike's date.`
      : 'Every hike counted has its own date or month.',
    sources: [
      hikes.some((h) => h.source === 'session') && 'hikeSessions (one record per hike, exact)',
      hikes.some((h) => h.source === 'start') && 'hikeStarts (Start Hike per month and trail)',
      hikes.some((h) => h.source === 'total') && (user.sessionDataSource ? 'imported dummy session totals (PDF)' : 'profile totals'),
      (user.lastCompletedHikeAt || user.lastPartialHike) && 'last completed / partial hike times'
    ].filter(Boolean)
  };
}

/* The fields that decide whether a stored summary is out of date (all but
   when it was generated), as one comparable string. Dates may come back
   from Firestore as Timestamps; both sides are turned into ISO text. */
export function summaryFingerprint(summary) {
  if (!summary) return '';
  // `id` is only there when a caller added the document id to its data.
  const { generatedAt, generatedBy, id, ...rest } = summary;
  return JSON.stringify(rest, (key, value) => {
    if (value && typeof value.toDate === 'function') return value.toDate().toISOString();
    if (value && typeof value === 'object' && typeof value._seconds === 'number') return new Date(value._seconds * 1000 + Math.round((value._nanoseconds || 0) / 1e6)).toISOString();
    if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      return Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]]));
    }
    return value;
  });
}
