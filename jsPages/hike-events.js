// hike-events.js
// Every hike the portal knows about, one list per hiker, with a date, a
// trail and a result. Dashboard (Total Hikers Visitors, Visitors per Trail),
// Analytics (7 / 30 / 90 days) and User Management (Hiker Analytics) all
// count from this one list, so the three pages always agree -- app hikers
// and the imported dummy session data alike.
//
// Where each hike comes from, most exact first:
//   hikeSessions/{id}    one record per finished hike from the updated app:
//                        exact start time, trail, minutes, result.
//   hikeStarts.{month}   Start Hike in the app: how many hikes per month and
//                        on which trail (no day: dated within that month).
//   lifetime totals      users/{uid}: hikeCount / completedHikes /
//                        partialHikes / hikeTotalMinutes (the app's counters,
//                        or the imported dummy session totals). Hikes these
//                        count that no record above covers have no date of
//                        their own; they are placed on the hiker's LAST
//                        hike (lastHikeAt / lastHikeStartedAt), the only date
//                        the data gives. These are marked `estimated`.
// Results: per-hike records are exact; every other hike takes its result
// from the hiker's totals (completed, partial, and the rest ended early
// before a station), so all of a hiker's completed and partial hikes are
// counted. Minutes: the hiker's total time spread over their completed and
// partial hikes.

/* Any stored date -> Date (null when there is none). The same as
   datetime-prefs.js toPortalDate, kept here so this module has no imports:
   it also runs in Cloud Functions (functions/shared, copied at deploy). */
const toPortalDate = (value) => {
  if (value === null || value === undefined || value === '') return null;
  let date;
  if (typeof value.toDate === 'function') date = value.toDate();
  else if (value instanceof Date) date = value;
  else if (typeof value === 'object' && typeof value.seconds === 'number') date = new Date(value.seconds * 1000);
  else if (typeof value === 'object' && typeof value._seconds === 'number') date = new Date(value._seconds * 1000);
  else date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

// Hiker accounts only: guides (and admins / rangers) also tap Start Hike
// when leading a group, but they are not visitors.
export const isHikerAccount = (user) => !/admin|manager|guide|ranger/i.test(String(user?.role || user?.Role || ''));

const text = (value) => String(value ?? '').trim();
const number = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const whole = (value) => Math.floor(number(value) || 0);
const MONTH_KEY = /^m(\d{4})_(0[1-9]|1[0-2])$/;
// "Completed" / "Partial" / "Ended early" (imported text) -> a status.
const resultOf = (value) => {
  const result = text(value).toLowerCase();
  if (/complet/.test(result)) return 'completed';
  if (/partial/.test(result)) return 'partial';
  if (/ended|early/.test(result)) return 'ended';
  return null;
};
/* On the Makiling Traverse (MakTrav), the side a hike started from: the
   app saves it on each per-hike record (startSide); for the imported
   session data it is the hiker's traverseStartSide. 'Sipit' or
   'Mariang Makiling' (MMT); '' when not recorded. */
const sideOf = (value) => {
  const side = text(value).toLowerCase();
  if (side.includes('sipit')) return 'Sipit';
  if (side.includes('mariang') || side.includes('mmt')) return 'Mariang Makiling';
  return '';
};
const SAME_HIKE_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// The hikeStarts month key ("m2026_11") of a date in a time zone.
export const monthKeyOf = (date, timeZone = 'Asia/Manila') => {
  const [year, month] = date.toLocaleDateString('en-CA', { timeZone }).split('-');
  return `m${year}_${month}`;
};

// The first moment of a month key in Philippine time (hikeStarts months are
// Philippine months), for hikes known only by their month.
const monthStart = (key) => {
  const [, year, month] = MONTH_KEY.exec(key);
  return new Date(`${year}-${month}-01T00:00:00+08:00`);
};

/* ---------------------------------------------------------------------
   Trails that still exist
   A hike saved its trail's document id, or (imported sessions, older
   starts) its name; both are matched here, the name without case. A trail
   deleted in Trail Management resolves to null, so its visits disappear
   everywhere at once.
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

/* ---------------------------------------------------------------------
   One hiker's hikes
   [{ uid, date, trails: [key], minutes, status: 'completed' | 'partial' |
   'ended', source, estimated }]
   --------------------------------------------------------------------- */
function hikerHikes(user, sessions, timeZone, resolve = null) {
  const uid = text(user.id);
  const hikes = [];

  // 1. Per-hike records: exact.
  sessions.forEach((session) => {
    const date = toPortalDate(session.startedAt) || toPortalDate(session.endedAt);
    if (!date) return;
    const trail = text(session.trailID) || text(session.trailName);
    hikes.push({
      uid, date, trails: trail ? [trail] : [], minutes: number(session.minutes),
      status: ['completed', 'partial'].includes(session.status) ? session.status : 'ended',
      source: 'session', estimated: false, fixedResult: true, precision: 'time',
      startSide: sideOf(session.startSide)
    });
  });

  // 2. Start Hike months: the starts no record covers, dated in their month
  //    (on the last hike's day when that is the same month).
  const lastDate = [toPortalDate(user.lastHikeAt), toPortalDate(user.lastHikeStartedAt)]
    .filter(Boolean).sort((a, b) => b - a)[0] || null;
  const lastMonth = lastDate ? monthKeyOf(lastDate, timeZone) : null;
  Object.entries(user.hikeStarts || {}).forEach(([key, entry]) => {
    if (!MONTH_KEY.test(key)) return;
    const started = whole(entry?.count);
    const recordedHere = hikes.filter((hike) => hike.source === 'session' && monthKeyOf(hike.date, timeZone) === key);
    let extra = started - recordedHere.length;
    if (extra <= 0) return;
    const date = key === lastMonth ? lastDate : monthStart(key);
    // In the last hike's month only one start is that hike; the others are
    // known by their month alone (counted on that date for the windows).
    let dayLeft = key === lastMonth && !hikes.some((h) => h.source === 'session' && Math.abs(h.date.getTime() - lastDate.getTime()) <= SAME_HIKE_MS);
    const nextPrecision = () => { if (dayLeft) { dayLeft = false; return 'day'; } return 'month'; };
    // Trails for the extra starts: the month's trail counts, less the ones
    // the records already account for.
    const left = {};
    Object.entries(entry?.trails || {}).forEach(([trail, n]) => { left[trail] = whole(n); });
    recordedHere.forEach((hike) => hike.trails.forEach((trail) => { if (left[trail]) left[trail] -= 1; }));
    Object.entries(left).forEach(([trail, n]) => {
      for (let i = 0; i < n && extra > 0; i += 1, extra -= 1) {
        hikes.push({ uid, date, trails: [trail], minutes: null, status: null, source: 'start', estimated: false, precision: nextPrecision() });
      }
    });
    for (; extra > 0; extra -= 1) {
      hikes.push({ uid, date, trails: [], minutes: null, status: null, source: 'start', estimated: false, precision: nextPrecision() });
    }
  });

  // 3. Lifetime totals: hikes no record above covers, on the last hike.
  //    Imported data that gives the first hike (firstHikeAt, with its trail
  //    and result) dates that one exactly; the last hike takes its own trail
  //    and result when given (lastHikeTrail / lastHikeResult).
  const completed = whole(user.completedHikes);
  const partial = whole(user.partialHikes);
  const lifetime = Math.max(whole(user.hikeCount), whole(user.totalHikes), completed + partial, hikes.length);
  let remainder = lifetime - hikes.length;
  const firstGiven = toPortalDate(user.firstHikeAt);
  if (remainder > 0 && firstGiven && !hikes.some((hike) => hike.date <= firstGiven)) {
    const status = resultOf(user.firstHikeResult);
    hikes.push({ uid, date: firstGiven, trails: [text(user.firstHikeTrail)].filter(Boolean), minutes: null,
      status, fixedResult: Boolean(status), source: 'total', estimated: false, precision: 'day' });
    remainder -= 1;
  }
  if (remainder > 0 && lastDate) {
    const listed = Array.isArray(user.hikedTrails) ? [...new Set(user.hikedTrails.map(text).filter(Boolean))] : [];
    const trails = listed.length ? listed : [text(user.lastHikeStartTrail)].filter(Boolean);
    // The latest hike itself is dated; the ones before it are assumed --
    // all of them when a record above already is that latest hike.
    const lastCovered = hikes.some((hike) => Math.abs(hike.date.getTime() - lastDate.getTime()) < 60 * 1000);
    for (let i = 0; i < remainder; i += 1) {
      const isLast = !lastCovered && i === remainder - 1;
      const lastStatus = isLast ? resultOf(user.lastHikeResult) : null;
      hikes.push({ uid, date: lastDate, trails: isLast && text(user.lastHikeTrail) ? [text(user.lastHikeTrail)] : trails,
        minutes: null, status: lastStatus, fixedResult: Boolean(lastStatus), source: 'total', estimated: !isLast, precision: 'day' });
    }
  }

  // Every hike without its own record: the hiker's traverse side, if any.
  const profileSide = sideOf(user.traverseStartSide);
  hikes.forEach((hike) => { if (hike.startSide === undefined) hike.startSide = profileSide; });

  // Hikes on trails deleted in Trail Management leave BEFORE results are
  // handed out, so the hiker's completed and partial hikes all land on
  // hikes that are still counted. (A hike with no trail at all stays.)
  if (resolve) {
    const kept = hikes.filter((hike) => !hike.trails.length || hike.trails.some((trail) => resolve(trail)));
    hikes.length = 0;
    hikes.push(...kept);
  }

  // The app stamps the time of the last completed and the last partial
  // hike: the latest hike at that time had that result.
  if (lastDate) {
    const near = (value) => { const at = toPortalDate(value); return at && Math.abs(at.getTime() - lastDate.getTime()) <= SAME_HIKE_MS; };
    let stamped = near(user.lastCompletedHikeAt) ? 'completed' : near(user.lastPartialHike?.at) ? 'partial' : null;
    /* The app stamps every completed and every partial hike. So for an app
       hiker whose last hike was ended (lastHikeAt at or after its start)
       and carries neither stamp, it ended early. Not for imported data,
       which has no such stamps. */
    const ended = toPortalDate(user.lastHikeAt);
    const started = toPortalDate(user.lastHikeStartedAt);
    // Only when the totals have room for an ended-early hike and the
    // profile shows the app version that stamps results (older versions
    // did not, e.g. a completed hike with no lastCompletedHikeAt).
    const stampsResults = Boolean(user.lastCompletedHikeAt || user.lastPartialHike);
    if (!stamped && !user.sessionDataSource && user.hikeStarts && stampsResults && lifetime > completed + partial
      && ended && (!started || ended >= started)) stamped = 'ended';
    const latest = hikes.filter((h) => !h.estimated && !h.fixedResult && h.precision !== 'month'
      && Math.abs(h.date.getTime() - lastDate.getTime()) <= SAME_HIKE_MS)[0];
    if (stamped && latest) { latest.status = stamped; latest.fixedResult = true; }
  }

  // Results for every hike without its own: the hiker's completed and
  // partial totals, less those the records already show; latest hikes first.
  let completedLeft = Math.max(0, completed - hikes.filter((h) => h.status === 'completed').length);
  let partialLeft = Math.max(0, partial - hikes.filter((h) => h.status === 'partial').length);
  const open = hikes.filter((h) => !h.fixedResult);
  // A result from the totals is certain only when every such hike must
  // have had it (all completed, all partial, or none of either).
  const uniform = completedLeft === open.length || partialLeft === open.length || (completedLeft === 0 && partialLeft === 0);
  hikes.forEach((hike) => { hike.resultKnown = Boolean(hike.fixedResult) || uniform; });
  [...open].sort((a, b) => b.date - a.date).forEach((hike) => {
    if (completedLeft > 0) { hike.status = 'completed'; completedLeft -= 1; }
    else if (partialLeft > 0) { hike.status = 'partial'; partialLeft -= 1; }
    else hike.status = 'ended';
  });

  // Minutes: the hiker's total time not already in records, spread over
  // their completed and partial hikes.
  const recordedMinutes = hikes.reduce((sum, hike) => sum + (hike.source === 'session' ? hike.minutes || 0 : 0), 0);
  const totalMinutes = number(user.hikeTotalMinutes);
  // (All their non-record hikes when none was completed or partial, so a
  // hiker whose hikes all ended early still keeps their recorded time.)
  const untimed = hikes.filter((h) => h.source !== 'session');
  const withResult = untimed.filter((h) => h.status === 'completed' || h.status === 'partial');
  const timed = withResult.length ? withResult : untimed;
  if (totalMinutes !== null && timed.length) {
    const each = Math.max(0, totalMinutes - recordedMinutes) / timed.length;
    timed.forEach((hike) => { hike.minutes = each; });
  }
  hikes.forEach((hike) => { delete hike.fixedResult; });
  return hikes;
}

/* Every hike of the given hiker accounts (users carry their document id as
   `id`), sessions being the hikeSessions documents. */
export function datedHikes(users = [], sessions = [], timeZone = 'Asia/Manila', trails = undefined) {
  // With trails: hikes on deleted trails are left out (see hikerHikes).
  const resolve = trails === undefined ? null : trailResolver(trails);
  const byUid = new Map();
  sessions.forEach((session) => {
    const uid = text(session.uid);
    if (!uid) return;
    if (!byUid.has(uid)) byUid.set(uid, []);
    byUid.get(uid).push(session);
  });
  return users.flatMap((user) => hikerHikes(user, byUid.get(text(user.id)) || [], timeZone, resolve));
}

// Hikes in the last `days` days (today included), like Analytics' windows.
export const hikesWithinDays = (hikes, days, now = Date.now()) => hikes.filter((hike) => {
  const age = (now - hike.date.getTime()) / DAY_MS;
  return age >= 0 && age < days;
});

/* Hikes on trails that still exist, each with its trails as current trail
   ids (trailIds). A hike naming only deleted trails is dropped; one with no
   trail recorded at all is kept. */
export function datedHikesOnTrails(users = [], sessions = [], trails = [], timeZone = 'Asia/Manila') {
  const resolve = trailResolver(trails);
  return datedHikes(users, sessions, timeZone, trails)
    .map((hike) => ({ ...hike, trailIds: [...new Set(hike.trails.map(resolve).filter(Boolean))] }))
    .filter((hike) => !hike.trails.length || hike.trailIds.length);
}

/* ---------------------------------------------------------------------
   Hikes per hiker per month, on current trails
   The monthly view of the same list, for the Dashboard and User
   Management. Returns Map uid -> {
     months: { m2026_11: { count, completed, partial, trails: { trailId:
       hikers' hikes there }, sides: { 'Sipit' | 'Mariang Makiling' | '':
       { count, completed, partial } } } },
     dated      every hike counted (all of them have a date now),
     estimated  hikes placed on the last hike for want of their own date,
     completed, partial   lifetime results
   }. Hikers with no hike on a current trail are not in the map.
   --------------------------------------------------------------------- */
export function monthlyVisits({ users = [], sessions = [], trails = [], timeZone = 'Asia/Manila', trailId = '' } = {}) {
  const visits = new Map();
  datedHikesOnTrails(users, sessions, trails, timeZone).forEach((hike) => {
    // A hike with no trail at all cannot be a trail visit.
    if (!hike.trailIds.length) return;
    // One trail only (User Management's trail filter): its hikes alone.
    if (trailId && !hike.trailIds.includes(trailId)) return;
    const visit = visits.get(hike.uid) || { months: {}, dated: 0, estimated: 0, completed: 0, partial: 0, firstDate: null, firstEstimated: false };
    // Whether the earliest hike's date is real or assumed decides whether
    // the hiker's first month is known (User Management's first-timers).
    if (!visit.firstDate || hike.date < visit.firstDate || (hike.date.getTime() === visit.firstDate.getTime() && hike.estimated)) {
      visit.firstDate = hike.date;
      visit.firstEstimated = hike.estimated;
    }
    const key = monthKeyOf(hike.date, timeZone);
    const month = visit.months[key] || (visit.months[key] = { count: 0, completed: 0, partial: 0, trails: {}, sides: {} });
    month.count += 1;
    if (hike.status === 'completed') { month.completed += 1; visit.completed += 1; }
    if (hike.status === 'partial') { month.partial += 1; visit.partial += 1; }
    // Where the hike started (MakTrav): per side, for each result.
    const side = month.sides[hike.startSide || ''] || (month.sides[hike.startSide || ''] = { count: 0, completed: 0, partial: 0 });
    side.count += 1;
    if (hike.status === 'completed') side.completed += 1;
    if (hike.status === 'partial') side.partial += 1;
    hike.trailIds.forEach((id) => { month.trails[id] = (month.trails[id] || 0) + 1; });
    visit.dated += 1;
    if (hike.estimated) visit.estimated += 1;
    visits.set(hike.uid, visit);
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

/* ---------------------------------------------------------------------
   A hiker's first and last hike, for User Details
   { first, last }, each null or { date, precision: 'time' | 'day' |
   'month', trails: [names], status, minutes }. From the same hikes the
   analytics count; nothing is guessed: a first hike whose date the data
   does not give is null (imported totals without a first-hike date), and
   minutes are only given for a hike timed on its own.
   --------------------------------------------------------------------- */
export function firstAndLastHike(user, sessions = [], trails = null, timeZone = 'Asia/Manila') {
  const mine = sessions.filter((session) => text(session.uid) === text(user.id));
  // Same-date ties: a hike known only by its month counts as the earlier.
  const RANK = { month: 0, day: 1, time: 2 };
  const hikes = hikerHikes(user, mine, timeZone, trails === null ? null : trailResolver(trails))
    .sort((a, b) => a.date - b.date || (RANK[a.precision] ?? 1) - (RANK[b.precision] ?? 1));
  if (!hikes.length) return { first: null, last: null };
  const resolve = trailResolver(trails);
  const nameOf = new Map((Array.isArray(trails) ? trails : []).map((trail) => [text(trail.id), text(trail.Trail || trail.name || trail.trailName)]));
  const trailNames = (list) => [...new Set(list.map((value) => {
    const id = resolve(value);
    return id ? (nameOf.get(id) || text(value)) : null;
  }).filter(Boolean))];
  const single = hikes.length === 1;
  const describe = (hike, group) => ({
    date: hike.date,
    precision: hike.precision || 'day',
    trails: trailNames(group.flatMap((h) => h.trails)),
    // Only a result the data makes certain; otherwise none is shown.
    status: hike.resultKnown ? hike.status : null,
    minutes: hike.source === 'session' ? hike.minutes : single ? number(user.hikeTotalMinutes) : null
  });
  // Last: the latest hike that really has its date (not an assumed one,
  // not one known only by its month), else the latest of all.
  const real = hikes.filter((h) => !h.estimated);
  const precise = real.filter((h) => h.precision !== 'month');
  const last = (precise.length ? precise : real.length ? real : hikes).slice(-1)[0];
  // First: unknown while hikes with an assumed date exist and no real hike
  // is earlier than them (they happened before the last, date unknown).
  const assumed = hikes.filter((h) => h.estimated);
  const earliestAssumed = assumed.length ? Math.min(...assumed.map((h) => h.date.getTime())) : Infinity;
  const firstHike = real.find((h) => h.date.getTime() < earliestAssumed) || (assumed.length ? null : hikes[0]);
  if (!firstHike) return { first: null, last: describe(last, [last]) };
  // The first month's hikes, when the first is only known by its month.
  const firstGroup = firstHike.precision === 'month'
    ? hikes.filter((h) => h.precision === 'month' && monthKeyOf(h.date, timeZone) === monthKeyOf(firstHike.date, timeZone))
    : [firstHike];
  return {
    first: firstHike.estimated ? null : describe(firstHike, firstGroup),
    last: describe(last, [last])
  };
}
