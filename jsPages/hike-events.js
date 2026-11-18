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

/* ---------------------------------------------------------------------
   Trails that still exist
   Every count on the website keeps only visits to trails that are in
   Trail Management now. A hike saved its trail's document id, or (imported
   sessions, older starts) its name; both are matched here, the name without
   case. A trail deleted in Trail Management resolves to null, so its visits
   disappear everywhere at once -- Dashboard, Analytics and User Management.
   --------------------------------------------------------------------- */
export function trailResolver(trails = []) {
  // Trails not loaded (or unreadable): keep every trail as saved rather
  // than dropping all visits; the next render, with trails, filters them.
  if (!Array.isArray(trails)) return (value) => text(value) || null;
  const idFor = new Map();
  trails.forEach((trail) => {
    const id = text(trail.id);
    if (!id) return;
    idFor.set(id, id);
    [trail.Trail, trail.name, trail.trailName].forEach((name) => {
      const key = text(name).toLowerCase();
      if (key && !idFor.has(`name:${key}`)) idFor.set(`name:${key}`, id);
    });
  });
  return (value) => {
    const key = text(value);
    if (!key) return null;
    return idFor.get(key) || idFor.get(`name:${key.toLowerCase()}`) || null;
  };
}

// The hikeStarts month key ("m2026_11") of a date in a time zone.
export const monthKeyOf = (date, timeZone) => {
  const [year, month] = date.toLocaleDateString('en-CA', { timeZone }).split('-');
  return `m${year}_${month}`;
};

const MONTH_KEY = /^m\d{4}_(0[1-9]|1[0-2])$/;

/* ---------------------------------------------------------------------
   Hikes per hiker per month, on current trails
   The ONE monthly count, shared by the Dashboard (Total Hikers Visitors,
   Visitors per Trail) and User Management (Hiker Analytics):
     - Start Hike in the app: hikeStarts.{month} = { count, trails }.
     - Per-hike records (hikeSessions): a hike from the updated app is in
       both, so per month and per trail the larger of the two is taken,
       never their sum.
     - Imported session data (sessionDataSource): no monthly record, only
       the last hike's date and the trails hiked (by name). One hike in that
       month, on each listed trail, unless the app already recorded that
       month for the hiker.
   Then only trails that still exist are kept; a month's hike count never
   exceeds the hikes on those trails (an imported hike listed on two trails
   stays one hike). Returns Map uid -> { months: { m2026_11: { count,
   trails: { trailId: n } } }, dated }  -- hikers with nothing left are not
   in the map. `users` are hiker accounts' documents with their `id`.
   --------------------------------------------------------------------- */
export function monthlyVisits({ users = [], sessions = [], trails = [], timeZone = 'Asia/Manila' } = {}) {
  const resolve = trailResolver(trails);
  const recordedByUid = new Map();
  sessions.forEach((session) => {
    const uid = text(session.uid);
    const date = toPortalDate(session.startedAt) || toPortalDate(session.endedAt);
    if (!uid || !date) return;
    const month = monthKeyOf(date, timeZone);
    const trailKey = text(session.trailID) || text(session.trailName);
    const months = recordedByUid.get(uid) || {};
    const slot = months[month] || (months[month] = { count: 0, trails: {} });
    slot.count += 1;
    if (trailKey) slot.trails[trailKey] = (slot.trails[trailKey] || 0) + 1;
    recordedByUid.set(uid, months);
  });

  const visits = new Map();
  users.forEach((user) => {
    const uid = text(user.id);
    if (!uid) return;
    const starts = user.hikeStarts || {};
    const recorded = recordedByUid.get(uid) || {};
    const lastImported = user.sessionDataSource ? toPortalDate(user.lastHikeAt) : null;
    const importedMonth = lastImported ? monthKeyOf(lastImported, timeZone) : null;
    const importedTrails = Array.isArray(user.hikedTrails) ? [...new Set(user.hikedTrails.map(text).filter(Boolean))] : [];
    const keys = new Set([
      ...Object.keys(starts).filter((key) => MONTH_KEY.test(key) && Number(starts[key]?.count) > 0),
      ...Object.keys(recorded),
      ...(importedMonth ? [importedMonth] : [])
    ]);

    const months = {};
    let dated = 0;
    keys.forEach((key) => {
      const entry = starts[key];
      const started = Number(entry?.count) || 0;
      const fromRecords = recorded[key];
      let count;
      const raw = {};
      if (started > 0 || fromRecords) {
        count = Math.max(started, fromRecords?.count || 0);
        [entry?.trails || {}, fromRecords?.trails || {}].forEach((source) => {
          Object.entries(source).forEach(([trailKey, hikes]) => {
            raw[trailKey] = Math.max(raw[trailKey] || 0, Number(hikes) || 0);
          });
        });
      } else if (key === importedMonth) {
        count = 1;
        importedTrails.forEach((name) => { raw[name] = 1; });
      } else {
        return;
      }
      const kept = {};
      Object.entries(raw).forEach(([trailKey, hikes]) => {
        const id = resolve(trailKey);
        if (id && hikes > 0) kept[id] = (kept[id] || 0) + hikes;
      });
      const onTrails = Object.values(kept).reduce((sum, n) => sum + n, 0);
      const monthCount = Math.min(count, onTrails);
      if (monthCount <= 0) return;
      months[key] = { count: monthCount, trails: kept };
      dated += monthCount;
    });
    if (dated > 0) visits.set(uid, { months, dated });
  });
  return visits;
}

/* Per hiker, their visits summed over the given months: [{ uid, count,
   trails: { trailId: n } }]. Hikers with none are left out. */
export function visitsOver(visits, monthKeys) {
  const result = [];
  visits.forEach(({ months }, uid) => {
    let count = 0;
    const trails = {};
    monthKeys.forEach((key) => {
      const month = months[key];
      if (!month) return;
      count += month.count;
      Object.entries(month.trails).forEach(([id, n]) => { trails[id] = (trails[id] || 0) + n; });
    });
    if (count > 0) result.push({ uid, count, trails });
  });
  return result;
}

/* Dated hikes (datedHikes) on trails that still exist, with each hike's
   trails turned into current trail ids. A hike naming only deleted trails
   is dropped; one with no trail recorded at all is kept. */
export function datedHikesOnTrails(users = [], sessions = [], trails = []) {
  const resolve = trailResolver(trails);
  return datedHikes(users, sessions)
    .map((hike) => ({ ...hike, trailIds: [...new Set(hike.trails.map(resolve).filter(Boolean))] }))
    .filter((hike) => !hike.trails.length || hike.trailIds.length);
}
