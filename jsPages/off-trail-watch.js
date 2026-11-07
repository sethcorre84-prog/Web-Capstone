// off-trail-watch.js
// The off-trail alarm on every portal page (started from notification.js,
// with the SOS alarm): a hiker on a hike who strays from every trail is
// announced with the SOS alarm's tone and pop-up wherever the admin is in
// the portal, not only on a page with the map.
//
// The same check as the maps (hiker-layer.js): farther than OFF_TRAIL_M from
// every trail line (plus the phone's stated accuracy, up to MAX_ACCURACY_M)
// for OFF_TRAIL_POLLS polls in a row. The lines are the same too, as plain
// points, with no map: the trail lines (settings/map, map-data.js), the
// routes saved on trails, and the jump-off roads that lead onto them.
//
// One alarm per stray, kept in the same place as the maps' (the
// "peakpath:off-trail-announced" list), so another page or tab that already
// announced it stays quiet. A page whose own map announces strays
// (Emergency Monitoring, the Dashboard) sets window.peakpathOffTrailOnPage,
// and this stands down there.

import { db } from './firebase-config.js';
import { announceAlert } from './sos-alarm.js';
import { loadMapData } from './map-data.js';
import { JUMP_OFFS, MAKILING_BOUNDS, validRoute } from './makiling-area.js';
import { toPortalDate as toDate } from './datetime-prefs.js';
import { Timestamp, collection, getDocs, onSnapshot, query, where } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const OFF_TRAIL_M = 50;
const MAX_ACCURACY_M = 40;
const OFF_TRAIL_POLLS = 2;
const POLL_MS = 15 * 1000;
const HIKER_EXPIRY_MS = 12 * 60 * 60 * 1000;
const ANNOUNCED_KEY = 'peakpath:off-trail-announced';

const readAnnounced = () => {
  try { return new Set(JSON.parse(localStorage.getItem(ANNOUNCED_KEY) || '[]')); } catch { return new Set(); }
};
const saveAnnounced = (keys) => {
  try { localStorage.setItem(ANNOUNCED_KEY, JSON.stringify([...keys])); } catch { /* may then repeat on another page */ }
};

// "About 70 m off the trail", as the maps and the app say it.
const offTrailLabel = (metres) => `About ${Math.round(metres / 10) * 10} m off the trail`;

/* Shortest distance in metres from a point to a line of [lat, lng] points,
   on a flat local projection (plenty accurate over a mountain). */
const distanceToLine = ([lat, lng], points) => {
  const ky = 111320;
  const kx = ky * Math.cos(lat * Math.PI / 180);
  let best = Infinity;
  for (let i = 1; i < points.length; i += 1) {
    const ax = (points[i - 1][1] - lng) * kx;
    const ay = (points[i - 1][0] - lat) * ky;
    const dx = (points[i][1] - lng) * kx - ax;
    const dy = (points[i][0] - lat) * ky - ay;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / lengthSq)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
};

const coordinatesOf = (position) => {
  const lat = Number(position?.latitude ?? position?.lat);
  const lng = Number(position?.longitude ?? position?.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null;
};

/* Every line a hiker may be on: { name, points }. The file's lines (with
   Peak 2 and the like left out), the jump-off roads, and the saved routes,
   which stay current through a listener on trails. */
let fileLines = [];
let routeLines = [];
const loadLines = async () => {
  try {
    const data = await loadMapData(JUMP_OFFS);
    const jumpOffs = Array.isArray(data.jumpOffs) ? data.jumpOffs : JUMP_OFFS;
    fileLines = [
      ...(data.trails?.features || [])
        .filter((feature) => feature?.geometry?.type === 'LineString')
        .map((feature) => ({
          name: feature.properties?.name || 'the trail',
          points: feature.geometry.coordinates.map(([lng, lat]) => [Number(lat), Number(lng)])
        })),
      ...jumpOffs
        .filter((spot) => Array.isArray(spot.approach) && spot.approach.length)
        .map((spot) => ({
          name: spot.name || 'the jump-off road',
          points: [spot.latLng, ...spot.approach].filter(Array.isArray)
        }))
    ].filter((line) => line.points.length >= 2);
  } catch (error) {
    console.warn('Off-trail alarm could not load the trail lines:', error.message);
  }
};
const watchRoutes = () => onSnapshot(collection(db, 'trails'), (snapshot) => {
  routeLines = snapshot.docs
    .map((snap) => snap.data() || {})
    .filter((trail) => validRoute(trail.route))
    .map((trail) => ({
      name: trail.Trail || 'Trail',
      points: trail.route.map((p) => [Number(p.lat), Number(p.lng)])
        .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng))
    }));
}, (error) => console.warn('Off-trail alarm could not read the saved routes:', error.message));

// The nearest line to a position: { distance, name }, or null with no lines.
const nearestLine = (coordinates) => {
  let best = null;
  [...fileLines, ...routeLines].forEach((line) => {
    const distance = distanceToLine(coordinates, line.points);
    if (!best || distance < best.distance) best = { distance, name: line.name };
  });
  return best;
};

const streaks = new Map(); // uid -> polls in a row off every trail
let polling = false;

const poll = async () => {
  // This page's own map announces strays (hiker-layer.js): leave it to that.
  if (window.peakpathOffTrailOnPage || polling || document.hidden) return;
  if (!fileLines.length && !routeLines.length) return;
  polling = true;
  try {
    const cutoff = Timestamp.fromMillis(Date.now() - HIKER_EXPIRY_MS);
    const snapshot = await getDocs(query(collection(db, 'locations'), where('updatedAt', '>', cutoff)));
    const offNow = new Map(); // key -> { data, nearest }
    const seen = new Set();
    const strayKeys = new Set(); // every hiker off the trail now, confirmed or not
    snapshot.docs.forEach((snap) => {
      const data = { id: snap.id, ...snap.data() };
      const coordinates = coordinatesOf(data.position);
      if (!data.hike?.trail || !coordinates || !MAKILING_BOUNDS.contains(coordinates)) return;
      const nearest = nearestLine(coordinates);
      if (!nearest) return;
      const accuracy = Math.min(MAX_ACCURACY_M, Math.max(0, Number(data.accuracy) || 0));
      if (nearest.distance <= OFF_TRAIL_M + accuracy) return;
      seen.add(data.id);
      // The same key as the maps: one alarm per stray, per hike.
      const key = `${data.id}:${toDate(data.hike?.startedAt)?.getTime() || ''}`;
      strayKeys.add(key);
      const streak = (streaks.get(data.id) || 0) + 1;
      streaks.set(data.id, streak);
      if (streak >= OFF_TRAIL_POLLS) offNow.set(key, { data, nearest });
    });
    [...streaks.keys()].forEach((uid) => { if (!seen.has(uid)) streaks.delete(uid); });

    // Read fresh, so a stray another page or tab already announced stays quiet.
    const announced = readAnnounced();
    offNow.forEach(({ data, nearest }, key) => {
      if (announced.has(key)) return;
      announceAlert({
        title: 'Off-trail alert',
        name: data.name || 'Hiker',
        place: `${offTrailLabel(nearest.distance)} (${nearest.name})`,
        created: toDate(data.fixAt) || toDate(data.updatedAt),
        href: 'emergency.html',
        icon: 'fa-person-walking-dashed-line-arrow-right'
      });
    });
    // Only the strays still going are kept (announced here or elsewhere), so
    // one back on the trail who strays again is announced again.
    saveAnnounced(new Set([...offNow.keys(), ...[...announced].filter((key) => strayKeys.has(key))]));
  } catch (error) {
    console.warn('Off-trail alarm could not check the hikers:', error.message);
  } finally {
    polling = false;
  }
};

let started = false;
export const watchOffTrailAlarm = () => {
  if (started) return;
  started = true;
  loadLines().then(poll);
  watchRoutes();
  setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
};
