// hike-events.js
// Dated hikes, for every count the portal makes "for a period" (Analytics'
// 7 / 30 / 90 days, the Dashboard's Visitors per Trail). Shared so the two
// pages always agree.
//
// Where the dates come from:
//   hikeSessions/{id}   one record per finished hike, written by the app
//                       (HikeSessionService._recordSession): when it started,
//                       on which trail, how long, completed or partial.
//                       Exact; exists for hikes ended after that app update.
//   users/{uid}         before that, only totals and the date of the
//                       hiker's LAST hike (lastHikeAt; the imported session
//                       data has the same), or of their last Start Hike
//                       (lastHikeStartedAt) when that is later, e.g. a hike
//                       never ended. A hiker with no session records
//                       therefore contributes one dated hike: their last,
//                       on lastHikeStartTrail if the app saved it, else on
//                       the trails listed in hikedTrails.
// Hikes without any date (older hikes of the same hikers) cannot be placed
// in a period and are left out of period counts.

import { toPortalDate } from './datetime-prefs.js';

// Hiker accounts only: guides (and admins / rangers) also tap Start Hike
// when leading a group, but they are not visitors. The same rule as User
// Management's Hiker Analytics and the Analytics page.
export const isHikerAccount = (user) => !/admin|manager|guide|ranger/i.test(String(user?.role || user?.Role || ''));

const text = (value) => String(value ?? '').trim();
const number = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/* Session records as dated hikes: { uid, date, trails: [key], minutes,
   status, source: 'session' }. The trail key is the trail's document id
   when the app had one, else its name -- the same key hikeStarts uses. */
export function sessionHikes(sessions = []) {
  return sessions.map((session) => {
    const date = toPortalDate(session.startedAt) || toPortalDate(session.endedAt);
    const trail = text(session.trailID) || text(session.trailName);
    return date && text(session.uid) ? {
      uid: text(session.uid),
      date,
      trails: trail ? [trail] : [],
      minutes: number(session.minutes),
      status: ['completed', 'partial'].includes(session.status) ? session.status : 'ended',
      source: 'session'
    } : null;
  }).filter(Boolean);
}

/* Every dated hike of the given hiker accounts (users carry their document
   id as `id`). Session records first; a hiker with none falls back to
   their last hike. */
export function datedHikes(users = [], sessions = []) {
  const hikerIds = new Set(users.map((user) => text(user.id)));
  const fromSessions = sessionHikes(sessions).filter((hike) => hikerIds.has(hike.uid));
  const withSessions = new Set(fromSessions.map((hike) => hike.uid));
  const fromLastHike = users
    .filter((user) => !withSessions.has(text(user.id)))
    .map((user) => {
      /* The later of the last hike's end (lastHikeAt) and the last Start
         Hike (lastHikeStartedAt): a hike started but never ended still
         happened, and has only the start date. */
      const date = [toPortalDate(user.lastHikeAt), toPortalDate(user.lastHikeStartedAt)]
        .filter(Boolean)
        .sort((a, b) => b - a)[0];
      if (!date) return null;
      const last = text(user.lastHikeStartTrail);
      const listed = Array.isArray(user.hikedTrails)
        ? [...new Set(user.hikedTrails.map(text).filter(Boolean))]
        : [];
      // Their average hike length, as the best estimate for this one.
      const sessionsTimed = (number(user.completedHikes) || 0) + (number(user.partialHikes) || 0);
      const total = number(user.hikeTotalMinutes);
      return {
        uid: text(user.id),
        date,
        trails: last ? [last] : listed,
        minutes: total !== null && sessionsTimed ? total / sessionsTimed : null,
        status: null,
        source: 'last-hike'
      };
    })
    .filter(Boolean);
  return [...fromSessions, ...fromLastHike];
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Hikes in the last `days` days (today included), like Analytics' windows.
export const hikesWithinDays = (hikes, days, now = Date.now()) => hikes.filter((hike) => {
  const age = (now - hike.date.getTime()) / DAY_MS;
  return age >= 0 && age < days;
});
