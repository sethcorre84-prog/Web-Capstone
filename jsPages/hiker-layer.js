// hiker-layer.js
// Live hiker pins from the PeakPath app, for the GeoMap and the Emergency
// map: everyone signed in to the app on Mount Makiling (locations/{uid},
// written by the app's LiveLocationService). Green while online, grey once
// silent ("last seen") and blue while on a hike (the app's Start Hike).
//
// How far a hiking hiker is from the trail, as the app warns them
// (OffTrailService): GETTING FAR (amber) past GETTING_FAR_M, OFF TRAIL (red)
// past OFF_TRAIL_M for two polls in a row. Both pins carry the distance
// ("About 50 m off the trail"). Off trail is flagged with a dashed line back
// to the nearest trail, listed in an alert box on the map, and announced
// with the SOS alarm's tone and pop-up (sos-alarm.js) once per stray. (A hiker
// far off the route is shown this way; there is no separate Lost / Missing
// pin.)
//
//   addHikerLayer({ map, db, bounds, layer, onCaption, trailLines }) -> the Leaflet layer
//     layer      optional layer group to draw into (e.g. one already in a
//                layers control); a new one is added to the map otherwise
//     bounds     the Mount Makiling bounds (createMakilingMap); hikers outside
//                them are counted, not drawn
//     onCaption  called with a one-line summary ("3 hikers online · ...")
//     trailLines the promise createMakilingMap returns; without it no hiker
//                is checked for being off trail
//     announceOffTrail  sound the alarm and pop up when a hiker strays
//     emergencyStatuses  true (Emergency Monitoring): On a hike, Getting far
//                and Off trail, with the off-trail alert box and alarm. false
//                (GeoMap): only Online now and Last seen, and no alarms --
//                watching for those is Emergency Monitoring's job.
//
// A hiker on a hike whose signal is lost (silent for 2 minutes) keeps their
// last pin, and the map also draws, on both maps:
//   - the path they walked (the app's breadcrumb, locations/{uid}.track),
//     grey and dashed. The app keeps adding to it with no signal, so once
//     signal returns, the whole stretch they walked offline appears;
//   - where they have probably got to since: an amber stretch of their
//     trail, from their last position onwards at their recent pace
//     (trackTimes), from half to 1.3 times that pace, with an "≈" ring at
//     the likeliest spot. It is an estimate, labelled as one, for where to
//     look first, never a live position. Not drawn when the hiker was
//     already off the trail (there is nothing to follow).

import { escapeHtml } from './utils.js';
import { announceAlert } from './sos-alarm.js';
import { toPortalDate as toDate } from './datetime-prefs.js';
import { Timestamp, collection, getDocs, onSnapshot, query, where } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const CSS = `
.hiker-marker {
    background: none;
    border: none;
}
.hiker-pin {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    border: 2px solid #fff;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
    color: #fff;
    font-size: 12px;
}
.hiker-pin.online {
    background: #2f8f4e;
}
.hiker-pin.offline {
    background: #8a948c;
}
/* On a hike right now (the app's Start Hike): blue, as hikers are in
   the app; grey with a blue ring once its signal is lost. */
.hiker-pin.online.on-hike {
    background: #1a73e8;
}
.hiker-pin.online.on-hike::after {
    border-color: #1a73e8;
}
.hiker-pin.offline.on-hike {
    box-shadow: 0 0 0 2px #1a73e8, 0 1px 4px rgba(0, 0, 0, 0.35);
}
.hiker-pin.online::after {
    content: "";
    position: absolute;
    inset: -5px;
    border-radius: 50%;
    border: 2px solid #2f8f4e;
    animation: hikerPulse 2s ease-out infinite;
}
/* Getting far from the trail: amber, a slower pulse (the app's amber glow). */
.hiker-pin.getting-far {
    background: #e0962a;
    width: 28px;
    height: 28px;
    font-size: 12px;
    box-shadow: 0 0 0 3px rgba(224, 150, 42, .35), 0 1px 5px rgba(0, 0, 0, .45);
}
.hiker-pin.getting-far::after {
    content: "";
    position: absolute;
    inset: -6px;
    border-radius: 50%;
    border: 2px solid #e0962a;
    animation: hikerPulse 2s ease-out infinite;
}
/* Signal lost: where they have probably got to (an estimate). */
.hiker-estimate-line {
    display: inline-block;
    margin: 2px 0;
    color: #8a5a10;
    font-size: 12px;
    line-height: 1.4;
}
/* How far off the trail, under the pin. */
.hiker-dist {
    position: absolute;
    top: calc(100% + 4px);
    left: 50%;
    z-index: 2;
    padding: 1px 6px;
    border-radius: 8px;
    background: #d64532;
    color: #fff;
    font: 700 10px/1.35 system-ui, sans-serif;
    white-space: nowrap;
    box-shadow: 0 1px 3px rgba(0, 0, 0, .3);
    transform: translateX(-50%);
    pointer-events: none;
}
.hiker-dist.is-far {
    background: #b9791b;
}
/* Off trail: red, with a fast pulse, above every other pin. */
.hiker-pin.off-trail {
    background: #d64532;
    width: 30px;
    height: 30px;
    font-size: 13px;
    box-shadow: 0 0 0 3px rgba(214, 69, 50, .35), 0 1px 5px rgba(0, 0, 0, .45);
}
.hiker-pin.off-trail::after {
    content: "";
    position: absolute;
    inset: -6px;
    border-radius: 50%;
    border: 2px solid #d64532;
    animation: hikerPulse 1.2s ease-out infinite;
}
.hiker-far-tag {
    display: inline-block;
    margin: 2px 0;
    padding: 1px 7px;
    border-radius: 10px;
    background: #b9791b;
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: .02em;
}
.hiker-off-tag {
    display: inline-block;
    margin: 2px 0;
    padding: 1px 7px;
    border-radius: 10px;
    background: #d64532;
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: .02em;
}
/* The alert box on the map: one row per hiker off trail; a row zooms to them. */
.hiker-alerts {
    max-width: min(300px, calc(100vw - 60px));
    border-left: 4px solid #d64532;
    border-radius: 8px;
    background: var(--card-bg, #fff);
    color: var(--text-primary, #1c231c);
    box-shadow: 0 4px 14px rgba(0, 0, 0, .25);
    font-size: 12px;
    overflow: hidden;
}
.hiker-alerts[hidden] {
    display: none;
}
.hiker-alerts-title {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 10px 5px;
    color: #d64532;
    font-weight: 700;
}
.hiker-alerts-title i {
    color: inherit;
}
.hiker-alerts button {
    display: block;
    width: 100%;
    padding: 5px 10px 6px;
    border: 0;
    border-top: 1px solid var(--border, #e4e7e1);
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
}
.hiker-alerts button:hover,
.hiker-alerts button:focus-visible {
    background: rgba(214, 69, 50, .08);
}
.hiker-alerts button small {
    display: block;
    color: var(--text-secondary, #5b6b60);
}
/* A guide (users/{uid}.role "Guide"): their office's logo -- a green disc
   reading MCME (Mariang Makiling) or CITY ENRO (Sipit) -- with a gold crown
   on a short stem above it. The disc takes the status colours (grey last
   seen, blue on a hike, amber getting far, red off trail). A guide with no trail
   yet shows the hiker figure. */
.guide-pin {
    position: relative;
    display: grid;
    place-items: center;
    box-sizing: border-box;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    border: 2px solid #fff;
    background: #2e8b47;
    color: #fff;
    box-shadow: 0 2px 5px rgba(0, 0, 0, .35);
    font-family: "Montserrat", "Arial Black", system-ui, sans-serif;
    font-weight: 900;
    line-height: 1;
    text-align: center;
}
.guide-pin.offline { background: #8a948c; }
.guide-pin.on-hike { background: #1a73e8; }
.guide-pin.getting-far {
    background: #e0962a;
    box-shadow: 0 0 0 3px rgba(224, 150, 42, .45), 0 2px 5px rgba(0, 0, 0, .35);
}
.guide-pin.off-trail {
    background: #d64532;
    box-shadow: 0 0 0 3px rgba(214, 69, 50, .45), 0 2px 5px rgba(0, 0, 0, .35);
}
.guide-text {
    font-size: 9px;
    letter-spacing: -.02em;
}
.guide-text.long {
    font-size: 7.5px;
}
.guide-pin.sm .guide-text.long { font-size: 5.5px; }
.guide-text small {
    display: block;
    margin-bottom: 1px;
    padding-left: .3em;
    font-size: 5px;
    font-weight: 800;
    letter-spacing: .3em;
}
.guide-pin > i {
    font-size: 14px;
}
.hiker-crown {
    position: absolute;
    top: -16px;
    left: 50%;
    z-index: 2;
    display: grid;
    place-items: center;
    box-sizing: border-box;
    width: 17px;
    height: 17px;
    border-radius: 50%;
    border: 2px solid #fff;
    background: #f2b705;
    box-shadow: 0 1px 3px rgba(0, 0, 0, .3);
    transform: translateX(-50%);
}
.hiker-crown::after {
    content: "";
    position: absolute;
    top: 100%;
    left: 50%;
    width: 3px;
    height: 3px;
    background: #fff;
    transform: translateX(-50%);
}
.hiker-crown i {
    color: #4a3300 !important;
    font-size: 8px !important;
    width: auto !important;
}
/* The map's size ('sm'). */
.guide-pin.sm {
    width: 30px;
    height: 30px;
    border-width: 1.5px;
    flex-shrink: 0;
}
.guide-pin.sm .guide-text { font-size: 6.5px; }
.guide-pin.sm .guide-text small { font-size: 3.6px; }
.guide-pin.sm .hiker-crown {
    top: -13px;
    width: 13px;
    height: 13px;
    border-width: 1.5px;
}
.guide-pin.sm .hiker-crown i { font-size: 6px !important; }
/* In a map legend: the size of the legend's other icons (20px on the
   GeoMap, 18px on Emergency Monitoring), with a small crown. */
.legend-row .guide-pin.sm,
.legend-item .guide-pin.sm {
    width: 20px;
    height: 20px;
    margin-top: 8px;
    border-width: 1px;
    box-shadow: 0 1px 2px rgba(0, 0, 0, .25);
}
.legend-item .guide-pin.sm {
    width: 18px;
    height: 18px;
}
.legend-row .guide-pin.sm .guide-text,
.legend-item .guide-pin.sm .guide-text { font-size: 4.6px; letter-spacing: 0; }
.legend-row .guide-pin.sm .guide-text.long,
.legend-item .guide-pin.sm .guide-text.long { font-size: 3.8px; }
.legend-row .guide-pin.sm .guide-text small,
.legend-item .guide-pin.sm .guide-text small { font-size: 2.6px; margin-bottom: 0; }
.legend-row .guide-pin.sm .hiker-crown,
.legend-item .guide-pin.sm .hiker-crown {
    top: -8px;
    width: 10px;
    height: 10px;
    border-width: 1px;
}
.legend-row .guide-pin.sm .hiker-crown::after,
.legend-item .guide-pin.sm .hiker-crown::after { height: 1px; width: 2px; }
.legend-row .guide-pin.sm .hiker-crown i,
.legend-item .guide-pin.sm .hiker-crown i { font-size: 5px !important; }
.hiker-guide-line {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: #9a6b00;
    font-weight: 700;
}
@keyframes hikerPulse {
    from {
        transform: scale(0.8);
        opacity: 0.8;
    }
    to {
        transform: scale(1.5);
        opacity: 0;
    }
}
@media (prefers-reduced-motion: reduce) {
    .hiker-pin.online::after,
    .hiker-pin.off-trail::after {
        animation: none;
        opacity: 0;
    }
}
`;

// The position fields the app writes (a GeoPoint, or latitude/longitude).
const getCoordinates = (data) => {
  const latitude = Number(data.latitude ?? data.lat ?? data.coordinates?.latitude);
  const longitude = Number(data.longitude ?? data.lng ?? data.coordinates?.longitude);
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
    ? [latitude, longitude]
    : null;
};

/* Off trail. Farther than OFF_TRAIL_M from every trail line (plus the
   phone's own stated accuracy, up to MAX_ACCURACY_M, so a weak fix under the
   canopy is not taken for a stray) for OFF_TRAIL_POLLS polls in a row. The
   OSM trail lines are themselves off by a few metres in places, which the
   margin also absorbs. Getting far: past GETTING_FAR_M but not off yet. The
   same distances as the app (OffTrailService: 30 m and 50 m). */
const OFF_TRAIL_M = 50;
const GETTING_FAR_M = 30;
// "About 50 m off the trail": rounded to 10 m, as the app says it.
export const offTrailLabel = (metres) => `About ${Math.round(metres / 10) * 10} m off the trail`;
const MAX_ACCURACY_M = 40;
const OFF_TRAIL_POLLS = 2;
const OFF_TRAIL_ANNOUNCED_KEY = 'peakpath:off-trail-announced';

/* The nearest point of a line to a position, in metres, on a flat local
   projection (plenty accurate over a mountain). */
const nearestOnLine = ([lat, lng], latLngs) => {
  const ky = 111320;
  const kx = ky * Math.cos(lat * Math.PI / 180);
  let best = { distance: Infinity, point: null };
  for (let i = 1; i < latLngs.length; i += 1) {
    const ax = (latLngs[i - 1].lng - lng) * kx;
    const ay = (latLngs[i - 1].lat - lat) * ky;
    const dx = (latLngs[i].lng - lng) * kx - ax;
    const dy = (latLngs[i].lat - lat) * ky - ay;
    const length = dx * dx + dy * dy;
    const t = length ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / length)) : 0;
    const px = ax + t * dx;
    const py = ay + t * dy;
    const distance = Math.hypot(px, py);
    if (distance < best.distance) best = { distance, point: [lat + py / ky, lng + px / kx] };
  }
  return best;
};

/* Along a line: how far along it (metres from its first point) the nearest
   spot to a position is, and how far off the line the position is. */
const alongLine = ([lat, lng], latLngs) => {
  const ky = 111320;
  const kx = ky * Math.cos(lat * Math.PI / 180);
  let best = { along: 0, offset: Infinity };
  let walked = 0;
  for (let i = 1; i < latLngs.length; i += 1) {
    const ax = (latLngs[i - 1].lng - lng) * kx;
    const ay = (latLngs[i - 1].lat - lat) * ky;
    const dx = (latLngs[i].lng - lng) * kx - ax;
    const dy = (latLngs[i].lat - lat) * ky - ay;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / lengthSq)) : 0;
    const offset = Math.hypot(ax + t * dx, ay + t * dy);
    const length = Math.sqrt(lengthSq);
    if (offset < best.offset) best = { along: walked + t * length, offset };
    walked += length;
  }
  return { ...best, total: walked };
};

// The point `metres` along a line, and the stretch of it between two distances.
const segmentLengths = (latLngs) => {
  const out = [0];
  for (let i = 1; i < latLngs.length; i += 1) {
    const a = latLngs[i - 1];
    const b = latLngs[i];
    const ky = 111320;
    const kx = ky * Math.cos(a.lat * Math.PI / 180);
    out.push(out[i - 1] + Math.hypot((b.lng - a.lng) * kx, (b.lat - a.lat) * ky));
  }
  return out;
};
const pointAlong = (latLngs, cum, metres) => {
  if (metres <= 0) return [latLngs[0].lat, latLngs[0].lng];
  for (let i = 1; i < latLngs.length; i += 1) {
    if (cum[i] >= metres) {
      const t = (metres - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
      return [latLngs[i - 1].lat + t * (latLngs[i].lat - latLngs[i - 1].lat),
        latLngs[i - 1].lng + t * (latLngs[i].lng - latLngs[i - 1].lng)];
    }
  }
  const last = latLngs[latLngs.length - 1];
  return [last.lat, last.lng];
};
const stretchAlong = (latLngs, cum, from, to) => {
  const [a, b] = from <= to ? [from, to] : [to, from];
  const points = [pointAlong(latLngs, cum, a)];
  for (let i = 0; i < latLngs.length; i += 1) {
    if (cum[i] > a && cum[i] < b) points.push([latLngs[i].lat, latLngs[i].lng]);
  }
  points.push(pointAlong(latLngs, cum, b));
  return points;
};

/* Where a hiker whose signal is lost has probably got to, along their
   trail. From the last fix, the direction they were walking (the start of
   their breadcrumb to its end) and their pace over the last half hour
   before the signal went (or an ordinary pace up a forest trail, 1.6 km/h,
   when the breadcrumb has no times), for the time since: from half to 1.3
   times that far, likeliest at that pace. Capped at 4 hours, and at the
   trail's ends. Null when there is nothing to follow: no trail line, or
   the hiker more than 150 m from it. */
const ESTIMATE_DEFAULT_MPS = 1.6 / 3.6;
const ESTIMATE_MAX_MS = 4 * 60 * 60 * 1000;
const ESTIMATE_OFF_LINE_M = 150;
const estimateAlongTrail = ({ coordinates, lastFix, track, trackTimes, latLngs }) => {
  if (!latLngs || latLngs.length < 2) return null;
  const here = alongLine(coordinates, latLngs);
  if (here.offset > ESTIMATE_OFF_LINE_M) return null;
  const points = (track || []).map((p) => [Number(p.latitude ?? p._lat), Number(p.longitude ?? p._long)])
    .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));
  const times = Array.isArray(trackTimes) && trackTimes.length === points.length ? trackTimes.map(Number) : null;

  // Which way: from where the breadcrumb starts to the last fix; with too
  // short a breadcrumb, away from the nearer end of the trail.
  let direction = here.along < here.total / 2 ? 1 : -1;
  if (points.length >= 2) {
    const first = alongLine(points[0], latLngs).along;
    if (Math.abs(here.along - first) >= 30) direction = here.along > first ? 1 : -1;
  }

  // Pace: progress along the trail over the last half hour with a fix.
  let pace = ESTIMATE_DEFAULT_MPS;
  let measured = false;
  if (times && points.length >= 2 && times[times.length - 1] > 0) {
    const end = times[times.length - 1];
    let i = points.length - 1;
    while (i > 0 && times[i - 1] > 0 && end - times[i - 1] <= 30 * 60 * 1000) i -= 1;
    const seconds = (end - times[i]) / 1000;
    if (seconds >= 5 * 60) {
      const progress = Math.abs(here.along - alongLine(points[i], latLngs).along);
      if (progress >= 50) {
        pace = Math.min(1.2, Math.max(0.15, progress / seconds));
        measured = true;
      }
    }
  }

  const elapsedMs = Math.min(ESTIMATE_MAX_MS, Math.max(0, Date.now() - lastFix.getTime()));
  const clamp = (m) => Math.min(here.total, Math.max(0, m));
  const step = (factor) => clamp(here.along + direction * pace * factor * elapsedMs / 1000);
  const cum = segmentLengths(latLngs);
  const near = step(0.5);
  const likely = step(1);
  const far = step(1.3);
  return {
    stretch: stretchAlong(latLngs, cum, near, far),
    likely: pointAlong(latLngs, cum, likely),
    nearM: Math.abs(near - here.along),
    farM: Math.abs(far - here.along),
    paceKmh: pace * 3.6,
    measured,
    atEnd: likely === 0 || likely === here.total
  };
};

const formatKm = (metres) => (metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres / 10) * 10} m`);

// The office a guide works for, from their trail (User Management's
// "Guide from what trail?"): City ENRO for Sipit, MCME for Mariang Makiling.
export const guideAgencyOf = (trailName) => {
  const name = String(trailName || '');
  if (/sipit/i.test(name)) return 'City ENRO';
  if (/mariang/i.test(name)) return 'MCME';
  return trailAcronym(name);
};

// Any other trail: its acronym, from the first letter of each word, leaving
// out "Trail", "Mt." / "Mount" and small words ("Malaboo Ridge Trail" ->
// MR). A one-word name gives its first three letters (MAL). At most 5.
const ACRONYM_SKIP = new Set(['trail', 'trails', 'mt', 'mount', 'of', 'the', 'and', 'to', 'via', 'de', 'ng']);
export const trailAcronym = (trailName) => {
  const words = String(trailName || '').split(/[^A-Za-z0-9ÑñÀ-ÿ]+/)
    .filter((word) => word && !ACRONYM_SKIP.has(word.toLowerCase()));
  if (!words.length) return '';
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words.map((word) => word[0]).join('').slice(0, 5).toUpperCase();
};

// A guide's logo: their office (MCME, or CITY over ENRO) on a disc with
// the crown above. `classes`: the status (online, offline, on-hike, getting-far,
// off-trail) and 'sm' for a legend.
export const guidePinHtml = (agency, classes = 'online') => {
  const text = agency === 'City ENRO'
    ? '<span class="guide-text"><small>CITY</small>ENRO</span>'
    : agency ? `<span class="guide-text${agency.length > 4 ? ' long' : ''}">${escapeHtml(agency)}</span>` : '<i class="fa-solid fa-person-hiking"></i>';
  return `<span class="guide-pin ${classes}">${text}<span class="hiker-crown"><i class="fa-solid fa-crown"></i></span></span>`;
};

const readAnnounced = () => {
  try { return new Set(JSON.parse(localStorage.getItem(OFF_TRAIL_ANNOUNCED_KEY) || '[]')); } catch { return new Set(); }
};
const saveAnnounced = (keys) => {
  try { localStorage.setItem(OFF_TRAIL_ANNOUNCED_KEY, JSON.stringify([...keys])); } catch { /* may then repeat on the next page */ }
};

export function addHikerLayer({ map, db, bounds, layer = null, onCaption = () => {}, trailLines = null, announceOffTrail = true, emergencyStatuses = true, onOffTrail = () => {} }) {
  // The trail lines also place a silent hiker's estimate, on both maps.
  const estimateTrailLines = trailLines;
  // Without the emergency statuses: no off-trail check (so no alarm), no
  // on-hike colour.
  if (!emergencyStatuses) {
    trailLines = null;
    announceOffTrail = false;
  }
  // This page's map announces strays itself: the portal-wide off-trail
  // alarm (off-trail-watch.js) stands down here, so nothing rings twice.
  if (announceOffTrail && trailLines) window.peakpathOffTrailOnPage = true;
  if (!document.getElementById('hiker-layer-css')) {
    const style = document.createElement('style');
    style.id = 'hiker-layer-css';
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  layer ||= L.layerGroup().addTo(map);

  /* Live hiker positions from the PeakPath app (locations/{uid}), written
     about once a second while a hiker is signed in. Polled rather than
     listened to: a live listener is billed one read per phone per second
     for as long as this page is open. The thresholds match the app's own
     teammate pins — silent for 2 minutes means the signal was lost or the
     app closed (kept as "last seen"), and after 12 hours the hike is over. */
  const HIKER_REFRESH_MS = 10 * 1000;
  const HIKER_ONLINE_MS = 2 * 60 * 1000;
  const HIKER_EXPIRY_MS = 12 * 60 * 60 * 1000;
  const hikerMarkers = new Map();
  let hikerDocs = [];
  let hikerRefreshing = false;

  const formatAgo = (date) => {
    const minutes = Math.floor((Date.now() - date.getTime()) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours} hr${hours === 1 ? '' : 's'} ago`;
  };

  /* Guides, by uid: role "Guide" on their profile, with their trail. */
  const guidesByUid = new Map();
  onSnapshot(query(collection(db, 'users'), where('role', 'in', ['Guide', 'guide', 'GUIDE'])), (snapshot) => {
    guidesByUid.clear();
    snapshot.docs.forEach((snap) => {
      const data = snap.data() || {};
      const trail = String(data.guideTrail || '').trim();
      guidesByUid.set(snap.id, { trail, agency: guideAgencyOf(trail) });
    });
    renderHikers();
  }, (error) => console.warn('Could not read the guides:', error.message));
  // The distance tag under an off-trail (red) or getting-far (amber) pin.
  const distTag = (metres, far) => (metres
    ? `<span class="hiker-dist${far ? ' is-far' : ''}">≈ ${Math.round(metres / 10) * 10} m</span>` : '');
  const hikerIcon = (online, onHike, far = null, offTrail = null, guide = null) => (guide
    ? L.divIcon({
      className: 'hiker-marker',
      html: guidePinHtml(guide.agency, `sm ${offTrail ? 'off-trail' : far ? 'getting-far' : `${online ? 'online' : 'offline'}${onHike ? ' on-hike' : ''}`}`)
        .replace(/<\/span>$/, `${distTag(offTrail?.distance || far?.distance, !offTrail)}</span>`),
      iconSize: [30, 30],
      iconAnchor: [15, 15],
      popupAnchor: [0, -30]
    })
    : offTrail ? L.divIcon({
      className: 'hiker-marker',
      html: `<span class="hiker-pin off-trail"><i class="fa-solid fa-person-walking-dashed-line-arrow-right"></i>${distTag(offTrail.distance, false)}</span>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15],
      popupAnchor: [0, -16]
    })
    : far ? L.divIcon({
      className: 'hiker-marker',
      html: `<span class="hiker-pin getting-far"><i class="fa-solid fa-person-hiking"></i>${distTag(far.distance, true)}</span>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
      popupAnchor: [0, -15]
    })
    : L.divIcon({
      className: 'hiker-marker',
      html: `<span class="hiker-pin ${online ? 'online' : 'offline'}${onHike ? ' on-hike' : ''}"><i class="fa-solid fa-person-hiking"></i></span>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13],
      popupAnchor: [0, -14]
    }));

  /* Trail lines (makiling-area.js), from the file and the routes saved on
     trails; read afresh on every check, so a newly drawn route counts. */
  let trails = null;
  Promise.resolve(trailLines).then((loaded) => { trails = loaded; }).catch(() => {});
  let estimateTrails = null;
  Promise.resolve(estimateTrailLines).then((loaded) => { estimateTrails = loaded; }).catch(() => {});

  /* The trail a hiker is on: the line named like their hike's trail, else
     the one nearest them. */
  const normalizeName = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const lineForHike = (trailName, coordinates) => {
    const lines = [...(estimateTrails?.lines?.values?.() || [])];
    if (!lines.length) return null;
    const wanted = normalizeName(trailName);
    const named = wanted && lines.find((line) => {
      const name = normalizeName(line.name);
      return name && (name.includes(wanted) || wanted.includes(name));
    });
    if (named) return named.stroke.getLatLngs().flat(Infinity);
    let best = null;
    lines.forEach((line) => {
      const latLngs = line.stroke.getLatLngs().flat(Infinity);
      const found = nearestOnLine(coordinates, latLngs);
      if (!best || found.distance < best.distance) best = { distance: found.distance, latLngs };
    });
    return best?.latLngs || null;
  };

  // The breadcrumb as [lat, lng] pairs.
  const trackPoints = (data) => (Array.isArray(data.track) ? data.track : [])
    .map((p) => [Number(p?.latitude ?? p?._lat), Number(p?.longitude ?? p?._long)])
    .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));

  const pathLines = new Map();      // uid -> the walked path (signal lost, or popup open)
  const estimateLayers = new Map(); // uid -> { stretch, ring } while signal is lost
  const openPopups = new Set();     // uids whose popup is open: their path is shown
  const nearestTrail = (coordinates) => {
    let best = null;
    trails?.lines.forEach((line) => {
      const found = nearestOnLine(coordinates, line.stroke.getLatLngs().flat(Infinity));
      if (found.point && (!best || found.distance < best.distance)) best = { ...found, name: line.name || 'the trail' };
    });
    return best;
  };

  const offTrailStreak = new Map(); // uid -> polls in a row off every trail
  const offTrailSince = new Map();  // uid -> when first flagged off trail
  const offTrailByUid = new Map();  // uid -> { distance, point, name } once flagged
  const gettingFarByUid = new Map(); // uid -> { distance, point, name } while getting far
  const offTrailLines = new Map();  // uid -> dashed line back to the trail
  const announced = readAnnounced();

  // Run once per poll, on fresh positions: who is off trail now.
  const checkOffTrail = () => {
    if (!trails?.lines.size) return;
    const now = Date.now();
    const seen = new Set();
    gettingFarByUid.clear();
    hikerDocs.forEach((data) => {
      const updatedAt = toDate(data.updatedAt);
      const coordinates = data.position ? getCoordinates(data.position) : null;
      if (!data.hike?.trail || !updatedAt || !coordinates || !bounds.contains(coordinates)
        || now - updatedAt.getTime() > HIKER_EXPIRY_MS) return;
      const nearest = nearestTrail(coordinates);
      if (!nearest) return;
      const accuracy = Math.min(MAX_ACCURACY_M, Math.max(0, Number(data.accuracy) || 0));
      if (nearest.distance <= OFF_TRAIL_M + accuracy) {
        if (nearest.distance > GETTING_FAR_M + accuracy) gettingFarByUid.set(data.id, nearest);
        return;
      }
      seen.add(data.id);
      const streak = (offTrailStreak.get(data.id) || 0) + 1;
      offTrailStreak.set(data.id, streak);
      if (streak >= OFF_TRAIL_POLLS) {
        if (!offTrailSince.has(data.id)) offTrailSince.set(data.id, new Date());
        offTrailByUid.set(data.id, nearest);
      }
    });
    [...offTrailStreak.keys()].forEach((uid) => {
      if (seen.has(uid)) return;
      offTrailStreak.delete(uid);
      offTrailByUid.delete(uid);
      offTrailSince.delete(uid);
    });

    // One alarm per stray: a hiker back on the trail who strays again is
    // announced again. Kept across pages, like the SOS alarm.
    const current = new Set();
    offTrailByUid.forEach((nearest, uid) => {
      const data = hikerDocs.find((d) => d.id === uid);
      const key = `${uid}:${toDate(data?.hike?.startedAt)?.getTime() || ''}`;
      current.add(key);
      if (!announceOffTrail || announced.has(key)) return;
      announceAlert({
        title: 'Off-trail alert',
        name: data?.name || 'Hiker',
        place: `${offTrailLabel(nearest.distance)} (${nearest.name})`,
        created: toDate(data?.updatedAt),
        href: 'emergency.html',
        icon: 'fa-person-walking-dashed-line-arrow-right'
      });
    });
    announced.clear();
    current.forEach((key) => announced.add(key));
    saveAnnounced(announced);
  };

  // The alert box on the map, listing every hiker off trail.
  const alertBox = L.DomUtil.create('div', 'hiker-alerts');
  alertBox.hidden = true;
  alertBox.setAttribute('role', 'status');
  L.DomEvent.disableClickPropagation(alertBox);
  L.DomEvent.disableScrollPropagation(alertBox);
  const alertControl = L.control({ position: 'bottomleft' });
  alertControl.onAdd = () => alertBox;
  if (emergencyStatuses) alertControl.addTo(map);
  alertBox.addEventListener('click', (event) => {
    const marker = hikerMarkers.get(event.target.closest('button')?.dataset.uid);
    if (!marker) return;
    map.flyTo(marker.getLatLng(), Math.max(map.getZoom(), 16));
    marker.openPopup();
  });
  const renderAlertBox = (rows) => {
    alertBox.hidden = !rows.length;
    if (!rows.length) return;
    alertBox.innerHTML = `<div class="hiker-alerts-title"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>${rows.length} hiker${rows.length === 1 ? '' : 's'} off trail</div>`
      + rows.map(({ uid, name, nearest, online }) => `<button type="button" data-uid="${escapeHtml(uid)}">
          <strong>${escapeHtml(name)}</strong>
          <small>${escapeHtml(offTrailLabel(nearest.distance))} · ${escapeHtml(nearest.name)}${online ? '' : ' · signal lost'}</small>
        </button>`).join('');
  };

  const offTrailLine = (nearest) => `<span class="hiker-off-tag">OFF TRAIL</span><br><small>${escapeHtml(offTrailLabel(nearest.distance))} · nearest: ${escapeHtml(nearest.name)}</small><br>`;
  const farLine = (nearest) => `<span class="hiker-far-tag">GETTING FAR</span><br><small>${escapeHtml(offTrailLabel(nearest.distance))} · nearest: ${escapeHtml(nearest.name)}</small><br>`;

  const hikerPopup = (data, coordinates, updatedAt, online, far = null, offTrail = null, estimate = null) => {
    const details = [];
    const speed = Number(data.speed);
    if (Number.isFinite(speed) && speed >= 0) details.push(`${(speed * 3.6).toFixed(1)} km/h`);
    const altitude = Number(data.altitude);
    if (Number.isFinite(altitude)) details.push(`${Math.round(altitude)} m elevation`);
    const accuracy = Number(data.accuracy);
    if (Number.isFinite(accuracy) && accuracy > 0) details.push(`±${Math.round(accuracy)} m`);
    const teammates = Array.isArray(data.sharedWith) ? data.sharedWith.length : 0;
    // The hike in progress, from the app's Start Hike.
    const hike = emergencyStatuses && data.hike?.trail ? data.hike : null;
    const hikeSince = hike ? toDate(hike.startedAt) : null;
    const guide = guidesByUid.get(data.id);
    return `
      <strong>${escapeHtml(data.name || 'Hiker')}</strong><br>
      ${guide ? `<span class="hiker-guide-line"><i class="fa-solid fa-crown" aria-hidden="true"></i>Guide${guide.agency ? ` · ${escapeHtml(guide.agency)}` : ''}${guide.trail ? ` (${escapeHtml(guide.trail)})` : ''}</span><br>` : ''}
      ${offTrail ? offTrailLine(offTrail) : (far ? farLine(far) : '')}
      ${hike ? `<span style="display:inline-flex;align-items:center;gap:5px;color:#1a73e8;font-weight:600"><i class="fa-solid fa-route" aria-hidden="true"></i>Hiking ${escapeHtml(hike.trail)}${hikeSince ? ` · since ${escapeHtml(hikeSince.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}` : ''}</span><br>` : ''}
      <span style="display:inline-flex;align-items:center;gap:5px"><span style="width:8px;height:8px;border-radius:50%;background:${online ? '#2f8f4e' : '#8a948c'}"></span>${online ? 'Online' : 'Signal lost · last seen'} ${escapeHtml(formatAgo(updatedAt))}</span><br>
      ${estimate ? `<span class="hiker-estimate-line"><i class="fa-solid fa-route" aria-hidden="true"></i> <strong>Estimated now:</strong> ${estimate.atEnd ? 'at or near the end of the trail' : `${escapeHtml(formatKm(estimate.nearM))}–${escapeHtml(formatKm(estimate.farM))} further along`} (amber on the map), at ${estimate.measured ? 'their recent pace of' : 'a usual pace of'} about ${estimate.paceKmh.toFixed(1)} km/h. An estimate, not a live position.</span><br>` : ''}
      ${teammates ? `Sharing with ${teammates} teammate${teammates === 1 ? '' : 's'}` : 'Solo hiker'}<br>
      <small>${details.length ? `${escapeHtml(details.join(' · '))} · ` : ''}${coordinates.map((value) => value.toFixed(5)).join(', ')}</small>
    `;
  };

  const renderHikers = () => {
    const now = Date.now();
    const shown = new Set();
    let online = 0;
    let offline = 0;
    let offMountain = 0;
    let onHike = 0;
    let farShown = 0;
    const offTrailRows = [];

    const pathShown = new Set();
    const estimateShown = new Set();
    hikerDocs.forEach((data) => {
      const receivedAt = toDate(data.updatedAt);
      const coordinates = data.position ? getCoordinates(data.position) : null;
      if (!receivedAt || !coordinates || now - receivedAt.getTime() > HIKER_EXPIRY_MS) return;
      if (!bounds.contains(coordinates)) {
        offMountain += 1;
        return;
      }
      const isOnline = now - receivedAt.getTime() <= HIKER_ONLINE_MS;
      // When the phone took this fix: after a stretch with no signal the
      // server gets it later, so "last seen" goes by the fix itself.
      const fixAt = toDate(data.fixAt);
      const updatedAt = fixAt && fixAt.getTime() <= receivedAt.getTime() + 60000 ? fixAt : receivedAt;

      // Signal lost on a hike: the walked path and an estimate of where
      // they have got to since. The path also shows while the popup is open.
      const onAHike = Boolean(data.hike?.trail);
      const signalLost = onAHike && !isOnline;
      const estimate = signalLost && !offTrailByUid.get(data.id)
        ? estimateAlongTrail({ coordinates, lastFix: updatedAt, track: data.track, trackTimes: data.trackTimes, latLngs: lineForHike(data.hike.trail, coordinates) })
        : null;
      if (signalLost || openPopups.has(data.id)) {
        const path = trackPoints(data);
        if (path.length >= 2) {
          pathShown.add(data.id);
          const existing = pathLines.get(data.id);
          if (existing) existing.setLatLngs(path);
          else pathLines.set(data.id, L.polyline(path, { color: '#5f6b63', weight: 3, opacity: 0.85, dashArray: '2 7', lineCap: 'round', interactive: false }).addTo(layer));
        }
      }
      if (estimate) {
        estimateShown.add(data.id);
        const label = `Estimated position of ${data.name || 'Hiker'} (signal lost ${formatAgo(updatedAt)})`;
        const existing = estimateLayers.get(data.id);
        if (existing) {
          existing.stretch.setLatLngs(estimate.stretch);
          existing.ring.setLatLng(estimate.likely).setTooltipContent(label);
        } else {
          estimateLayers.set(data.id, {
            stretch: L.polyline(estimate.stretch, { color: '#e0962a', weight: 12, opacity: 0.35, lineCap: 'round', interactive: false }).addTo(layer),
            ring: L.circleMarker(estimate.likely, { radius: 9, color: '#b9791b', weight: 2, dashArray: '3 3', fillColor: '#e0962a', fillOpacity: 0.25 })
              .bindTooltip(label)
              .addTo(layer)
          });
        }
      }
      const isHiking = emergencyStatuses && Boolean(data.hike?.trail);
      const offTrail = offTrailByUid.get(data.id) || null;
      const isOffTrail = Boolean(offTrail);
      const far = isOffTrail ? null : (gettingFarByUid.get(data.id) || null);
      const guide = guidesByUid.get(data.id) || null;
      const guideKey = guide ? `${guide.agency}|${guide.trail}` : '';
      if (isOnline) online += 1; else offline += 1;
      if (isHiking) onHike += 1;
      if (far) farShown += 1;
      shown.add(data.id);

      // The dashed line from an off-trail hiker back to the nearest trail.
      const backLine = offTrailLines.get(data.id);
      if (isOffTrail) {
        offTrailRows.push({
          uid: data.id,
          name: data.name || 'Hiker',
          nearest: offTrail,
          online: isOnline,
          coordinates,
          updatedAt,
          since: offTrailSince.get(data.id) || updatedAt,
          trail: data.hike?.trail || ''
        });
        if (backLine) backLine.setLatLngs([coordinates, offTrail.point]);
        else offTrailLines.set(data.id, L.polyline([coordinates, offTrail.point], {
          color: '#d64532', weight: 3, dashArray: '6 6', interactive: false
        }).addTo(layer));
      } else if (backLine) {
        layer.removeLayer(backLine);
        offTrailLines.delete(data.id);
      }

      const popup = hikerPopup(data, coordinates, updatedAt, isOnline, far, offTrail, estimate);
      const zIndex = isOffTrail ? 1400 : (far ? 1300 : (isHiking ? 1100 : 1000));
      // The pin is redrawn when its distance tag changes (by 10 m steps).
      const distKey = offTrail ? `off:${Math.round(offTrail.distance / 10)}` : (far ? `far:${Math.round(far.distance / 10)}` : '');
      const marker = hikerMarkers.get(data.id);
      if (!marker) {
        const created = L.marker(coordinates, { icon: hikerIcon(isOnline, isHiking, far, offTrail, guide), zIndexOffset: zIndex })
          .bindPopup(popup)
          .addTo(layer);
        // Opening a hiker shows the path they walked, signal or not.
        const uid = data.id;
        created.on('popupopen', () => { openPopups.add(uid); renderHikers(); });
        created.on('popupclose', () => { openPopups.delete(uid); renderHikers(); });
        created.isOnline = isOnline;
        created.isHiking = isHiking;
        created.distKey = distKey;
        created.guideKey = guideKey;
        hikerMarkers.set(data.id, created);
        return;
      }
      // Moved in place rather than redrawn, so an open popup stays open.
      marker.setLatLng(coordinates).setPopupContent(popup);
      if (marker.isOnline !== isOnline || marker.isHiking !== isHiking || marker.distKey !== distKey
        || marker.guideKey !== guideKey) {
        marker.setIcon(hikerIcon(isOnline, isHiking, far, offTrail, guide));
        marker.guideKey = guideKey;
        marker.setZIndexOffset(zIndex);
        marker.isOnline = isOnline;
        marker.isHiking = isHiking;
        marker.distKey = distKey;
      }
    });
    offTrailLines.forEach((line, id) => {
      if (shown.has(id)) return;
      layer.removeLayer(line);
      offTrailLines.delete(id);
    });
    pathLines.forEach((line, id) => {
      if (pathShown.has(id)) return;
      layer.removeLayer(line);
      pathLines.delete(id);
    });
    estimateLayers.forEach(({ stretch, ring }, id) => {
      if (estimateShown.has(id)) return;
      layer.removeLayer(stretch);
      layer.removeLayer(ring);
      estimateLayers.delete(id);
    });
    renderAlertBox(offTrailRows);
    /* For a page's own list (Emergency Monitoring's table): the hikers off
       trail now, each with focus() to show them on the map. */
    onOffTrail(offTrailRows.map((row) => ({
      ...row,
      focus: () => {
        map.setView(row.coordinates, Math.max(map.getZoom(), 17));
        hikerMarkers.get(row.uid)?.openPopup();
      }
    })));


    hikerMarkers.forEach((marker, id) => {
      if (shown.has(id)) return;
      layer.removeLayer(marker);
      hikerMarkers.delete(id);
    });

    onCaption((offTrailRows.length ? `${offTrailRows.length} off trail · ` : '') +
      (farShown ? `${farShown} getting far · ` : '') +
      `${online} hiker${online === 1 ? '' : 's'} online` +
      (onHike ? ` · ${onHike} on a hike` : '') +
      (offline ? ` · ${offline} recently offline` : '') +
      (offMountain ? ` · ${offMountain} signed in outside Mount Makiling` : ''));
  };

  const refreshHikers = async () => {
    if (hikerRefreshing) return;
    hikerRefreshing = true;
    try {
      const cutoff = Timestamp.fromMillis(Date.now() - HIKER_EXPIRY_MS);
      const snapshot = await getDocs(query(collection(db, 'locations'), where('updatedAt', '>', cutoff)));
      hikerDocs = snapshot.docs.map((snap) => ({ id: snap.id, ...snap.data() }));
      checkOffTrail();
      renderHikers();
    } catch (error) {
      console.error('Error loading hiker locations:', error);
      onCaption(error?.code === 'permission-denied'
        ? 'Hiker locations blocked by Firestore rules'
        : 'Unable to load hiker locations');
    } finally {
      hikerRefreshing = false;
    }
  };


  refreshHikers();
  setInterval(() => { if (!document.hidden) refreshHikers(); }, HIKER_REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshHikers(); });

  return layer;
}
