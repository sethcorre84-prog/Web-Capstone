// trail-routes.js
// The route of a trail, for Trail Management's map (trail.html): the line a
// trail is drawn with on every map, saved on the trail itself as
//
//   trails/{id}.route         [{ lat, lng }, ...] from trailhead to end
//   trails/{id}.routeSource   'drawn' | 'gpx' | 'kml' | 'traced'
//   trails/{id}.routeUpdatedAt
//
// Three ways in, ending in the same editor:
//   Draw Route         a trail with no line yet: click along the trail on the
//                      map, point by point
//   Import GPX / KML   a trail with no line yet: a GPS recording of the trail
//                      (Strava, AllTrails, a GPS watch, Google My Maps),
//                      simplified, shown to check
//   Edit Route         a trail that already has a line (its saved route, or
//                      the standard line of a built-in trail from the trail
//                      file): opens that line to change it
//
// In the editor there are two tools:
//   Draw    click to add points. They join the "open end" (the pulsing dot):
//           the end of the line, or a gap left by Erase. Clicking the other
//           side of a gap closes it.
//   Erase   click or drag across the line to rub part of it out. What is
//           left keeps a gap there, ready to be drawn again.
// Points can be dragged, right-clicked away, undone and cleared. Lines that
// are drawn are smoothed into gentle curves (Smooth, on by default), small
// back-and-forth spikes and doubled clicks are tidied away, so the saved line
// looks natural on every map. GPS points that were not touched stay as they
// were. Gaps still open on Save are joined with a straight line.
//
// makiling-area.js draws every saved route on every map, and a route on one
// of the built-in trails replaces its line from the file. Admins can already
// write trails (firestore.rules), so no rule changes.

import {
  deleteField,
  doc,
  serverTimestamp,
  updateDoc
} from "./firestore-tracked.js";
import { trailLineKey, validRoute } from "./makiling-area.js";

const ROUTE_COLOR = '#f08c00';
const MAX_POINTS = 1000;        // plenty for a mountain trail, small for Firestore
const MAX_HANDLES = 400;        // above this, handles only on drawn points and ends
const ERASE_PX = 14;            // the eraser's radius, in screen pixels
const SNAP_PX = 14;             // a click this close to a gap's far side closes it

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

const CSS = `
.tr-drawing, .tr-drawing .leaflet-interactive { cursor:crosshair !important; }
.tr-drawing .tr-handle { cursor:grab !important; }
.tr-erasing, .tr-erasing .leaflet-interactive, .tr-erasing .tr-handle { cursor:cell !important; }
.tr-banner { position:absolute; top:10px; left:50%; transform:translateX(-50%); z-index:800;
  display:flex; flex-wrap:wrap; align-items:center; justify-content:center; gap:8px;
  width:max-content; max-width:calc(100% - 20px); padding:8px 10px 8px 14px; border-radius:10px;
  background:var(--dm-surface,#fff); color:var(--text-primary); box-shadow:0 4px 14px rgba(0,0,0,.25);
  font-size:12.5px; font-weight:600; }
.tr-banner > i { color:${ROUTE_COLOR}; }
.tr-banner .tr-text { max-width:380px; line-height:1.4; }
.tr-banner .tr-text small { display:block; font-weight:500; color:var(--text-secondary); }
.tr-banner .tr-text small.tr-warn { color:#b9791b; }
.tr-banner .tr-buttons { display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
.tr-banner button { display:inline-flex; align-items:center; gap:5px; border:1px solid var(--border);
  background:var(--dm-surface-2,#f5f5f2); color:var(--text-primary); border-radius:7px; padding:5px 10px;
  font-size:12px; font-weight:600; cursor:pointer; }
.tr-banner button i { color:inherit; }
.tr-banner button[disabled] { opacity:.5; cursor:not-allowed; }
.tr-banner .tr-save { border-color:var(--accent); background:var(--accent); color:#fff; }
.tr-banner .tr-tools { display:inline-flex; padding:2px; border:1px solid var(--border); border-radius:8px;
  background:var(--dm-surface-2,#f5f5f2); }
.tr-banner .tr-tools button { border:0; background:transparent; }
.tr-banner .tr-tools button[aria-pressed="true"] { background:${ROUTE_COLOR}; color:#fff; }
.tr-banner .tr-smooth { display:inline-flex; align-items:center; gap:5px; font-size:12px; font-weight:600;
  cursor:pointer; user-select:none; }
.tr-banner .tr-smooth input { accent-color:${ROUTE_COLOR}; margin:0; }
.tr-handle { width:12px; height:12px; margin:-6px 0 0 -6px; border-radius:50%; background:#fff;
  border:3px solid ${ROUTE_COLOR}; box-shadow:0 1px 3px rgba(0,0,0,.4); box-sizing:border-box; }
.tr-handle.is-end { width:16px; height:16px; margin:-8px 0 0 -8px; border-color:#1f6b39; }
.tr-handle.is-gap { border-color:#6b7a70; border-style:dashed; }
.tr-anchor { width:22px; height:22px; margin:-11px 0 0 -11px; border-radius:50%;
  border:2px solid ${ROUTE_COLOR}; background:rgba(240,140,0,.18); pointer-events:none;
  animation:trPulse 1.4s ease-out infinite; }
@keyframes trPulse { 0% { transform:scale(.6); opacity:1; } 100% { transform:scale(1.6); opacity:0; } }
@media (prefers-reduced-motion: reduce) { .tr-anchor { animation:none; } }
.tr-modal { display:none; position:fixed; inset:0; z-index:1000; background:rgba(0,0,0,.5);
  align-items:center; justify-content:center; padding:16px; }
.tr-modal.open { display:flex; }
.tr-dialog { width:min(420px,100%); padding:24px; border-radius:12px; background:var(--dm-surface,#fff);
  color:var(--text-primary); }
.tr-dialog h3 { display:flex; align-items:center; gap:8px; margin:0 0 6px; font-size:18px; }
.tr-dialog h3 i { color:#c8402f; }
.tr-dialog p { margin:0 0 16px; font-size:13px; line-height:1.5; color:var(--text-secondary); }
.tr-dialog .tr-error { min-height:16px; margin:-8px 0 8px; font-size:12px; color:var(--danger); }
.tr-dialog .tr-actions { display:flex; gap:10px; }
.tr-dialog .tr-actions button { flex:1; padding:10px; border-radius:8px; font-size:13px; font-weight:600; cursor:pointer; }
.tr-dialog .tr-cancel { border:1px solid var(--border); background:var(--dm-surface,#fff); color:var(--text-primary); }
.tr-dialog .tr-confirm { border:0; background:#c8402f; color:#fff; }
.tr-dialog .tr-confirm[disabled] { opacity:.6; cursor:wait; }
/* Registering a trail with no line: draw or import its route first. */
.tr-dialog h3 i.is-green { color:#2f8f4e; }
.tr-dialog .tr-choices { display:grid; gap:8px; margin:0 0 14px; }
.tr-dialog .tr-choice { display:flex; align-items:center; gap:10px; width:100%; padding:11px 12px; border-radius:10px;
  border:1px solid var(--border); background:var(--dm-surface,#fff); color:var(--text-primary); font:inherit;
  font-size:13px; font-weight:600; text-align:left; cursor:pointer; }
.tr-dialog .tr-choice:hover, .tr-dialog .tr-choice:focus-visible { border-color:#2f8f4e; background:rgba(47,143,78,.06); outline:none; }
.tr-dialog .tr-choice i { width:18px; color:#2f8f4e; text-align:center; }
.tr-dialog .tr-choice small { display:block; font-weight:400; color:var(--text-secondary); }
`;

/* ---- Geometry ---- */

const EARTH_K = (Math.PI / 180) * 6371000;   // meters per degree of latitude

// Distance in meters between two { lat, lng } (equirectangular; fine at trail scale).
function meters(a, b) {
  const k = Math.PI / 180;
  const x = (b.lng - a.lng) * k * Math.cos(((a.lat + b.lat) / 2) * k);
  const y = (b.lat - a.lat) * k;
  return Math.sqrt(x * x + y * y) * 6371000;
}

const lengthKm = (points) => points.reduce((sum, p, i) => (i ? sum + meters(points[i - 1], p) : 0), 0) / 1000;

// How far `p` is from the segment a-b, in meters.
function offSegment(p, a, b) {
  const k = Math.PI / 180;
  const cos = Math.cos(a.lat * k);
  const ax = a.lng * cos; const ay = a.lat;
  const bx = b.lng * cos - ax; const by = b.lat - ay;
  const px = p.lng * cos - ax; const py = p.lat - ay;
  const len = bx * bx + by * by;
  const t = len ? Math.max(0, Math.min(1, (px * bx + py * by) / len)) : 0;
  return meters(p, { lat: ay + t * by, lng: (ax + t * bx) / cos });
}

// Douglas-Peucker: drops points that lie within `tolerance` meters of the line.
function simplify(points, tolerance) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let worst = 0; let index = -1;
    for (let i = first + 1; i < last; i += 1) {
      const d = offSegment(points[i], points[first], points[last]);
      if (d > worst) { worst = d; index = i; }
    }
    if (worst > tolerance && index > 0) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

// Simplified until it fits MAX_POINTS, starting at 3 m (a GPS fix's own error).
function fitPoints(points) {
  if (points.length <= MAX_POINTS) return points;
  let tolerance = 3;
  let result = simplify(points, tolerance);
  while (result.length > MAX_POINTS) {
    tolerance *= 1.6;
    result = simplify(points, tolerance);
  }
  return result;
}

/* Drawn lines, made to look natural:
   1. clicks that land on the same spot (< 1.5 m apart) count once;
   2. a drawn point that makes the line jump out and straight back (a sharp
      reversal on a short leg, usually a stray click) is dropped;
   3. with `smooth`, every stretch next to a drawn point is bent into a
      curve through the points (centripetal Catmull-Rom, which never loops
      or overshoots), so clicked corners become gentle bends.
   Points that were not drawn (a GPS recording, the trail file) are kept as
   they are, apart from the curves where drawn points meet them. */
function tidy(points, smooth) {
  // 1. Doubled clicks.
  let pts = [];
  points.forEach((p) => {
    const last = pts[pts.length - 1];
    if (!last || meters(last, p) >= 1.5) pts.push(p);
    else if (p.d) pts[pts.length - 1] = { ...last, d: true };
  });

  // 2. Spikes.
  for (let pass = 0; pass < 3; pass += 1) {
    let dropped = false;
    const kept = [];
    pts.forEach((p, i) => {
      if (!p.d || i === 0 || i === pts.length - 1) { kept.push(p); return; }
      // Against the last point kept, so one stray click takes out one point.
      const a = kept[kept.length - 1]; const b = pts[i + 1];
      const legA = meters(a, p); const legB = meters(p, b);
      const cos = Math.cos(p.lat * Math.PI / 180);
      const v1 = { x: (p.lng - a.lng) * cos, y: p.lat - a.lat };
      const v2 = { x: (b.lng - p.lng) * cos, y: b.lat - p.lat };
      const turn = (v1.x * v2.x + v1.y * v2.y) / ((Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y)) || 1);
      if (turn < -0.85 && Math.min(legA, legB) < 30) { dropped = true; return; }
      kept.push(p);
    });
    pts = kept;
    if (!dropped) break;
  }
  if (!smooth || pts.length < 3) return pts.map(({ lat, lng }) => ({ lat, lng }));

  // 3. Curves, worked out in flat meters around the line.
  const cos = Math.cos(pts[0].lat * Math.PI / 180);
  const xy = (p) => ({ x: p.lng * EARTH_K * cos, y: p.lat * EARTH_K });
  const ll = (q) => ({ lat: q.y / EARTH_K, lng: q.x / (EARTH_K * cos) });
  const flat = pts.map(xy);
  const out = [];
  for (let i = 0; i < pts.length - 1; i += 1) {
    out.push({ lat: pts[i].lat, lng: pts[i].lng });
    if (!pts[i].d && !pts[i + 1].d) continue;
    const p1 = flat[i]; const p2 = flat[i + 1];
    // Past either end, a point mirrored through the end keeps the curve straight there.
    const p0 = flat[i - 1] || { x: 2 * p1.x - p2.x, y: 2 * p1.y - p2.y };
    const p3 = flat[i + 2] || { x: 2 * p2.x - p1.x, y: 2 * p2.y - p1.y };
    const steps = Math.min(12, Math.max(1, Math.round(Math.hypot(p2.x - p1.x, p2.y - p1.y) / 8)));
    for (let s = 1; s < steps; s += 1) out.push(ll(catmullRom(p0, p1, p2, p3, s / steps)));
  }
  const last = pts[pts.length - 1];
  out.push({ lat: last.lat, lng: last.lng });
  return out;
}

// A point `t` (0..1) of the way from p1 to p2 on the centripetal Catmull-Rom curve.
function catmullRom(p0, p1, p2, p3, t) {
  const knot = (a, b) => Math.max(Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)), 1e-4);
  const t0 = 0;
  const t1 = t0 + knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const u = t1 + (t2 - t1) * t;
  const mix = (a, b, ta, tb) => {
    const w = (u - ta) / (tb - ta);
    return { x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w };
  };
  const a1 = mix(p0, p1, t0, t1); const a2 = mix(p1, p2, t1, t2); const a3 = mix(p2, p3, t2, t3);
  const b1 = mix(a1, a2, t0, t2); const b2 = mix(a2, a3, t1, t3);
  return mix(b1, b2, t1, t2);
}

// Distance in pixels from point c to the segment a-b (Leaflet Points).
function pxToSegment(c, a, b) {
  const dx = b.x - a.x; const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.y - a.y) * dy) / len)) : 0;
  return Math.hypot(c.x - (a.x + t * dx), c.y - (a.y + t * dy));
}

/* ---- GPS files ---- */

// The longest track in a GPX or KML file, as [{ lat, lng }].
function parseRouteFile(text, fileName) {
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('This file could not be read. Is it a GPX or KML file?');
  const isKml = /\.kml$/i.test(fileName) || xml.documentElement.localName === 'kml';
  const tracks = [];

  if (isKml) {
    // <coordinates>lng,lat[,alt] lng,lat[,alt] ...</coordinates> in each line,
    // and <gx:coord>lng lat alt</gx:coord> in Google's tracks.
    [...xml.getElementsByTagName('coordinates')].forEach((node) => {
      const points = node.textContent.trim().split(/\s+/).map((tuple) => {
        const [lng, lat] = tuple.split(',').map(Number);
        return { lat, lng };
      });
      tracks.push(points);
    });
    const coords = [...xml.getElementsByTagNameNS('*', 'coord')].map((node) => {
      const [lng, lat] = node.textContent.trim().split(/\s+/).map(Number);
      return { lat, lng };
    });
    if (coords.length) tracks.push(coords);
  } else {
    // Each <trkseg> (a recorded track) and each <rte> (a planned route).
    [...xml.getElementsByTagName('trkseg')].forEach((seg) => {
      tracks.push([...seg.getElementsByTagName('trkpt')].map((pt) => ({
        lat: Number(pt.getAttribute('lat')), lng: Number(pt.getAttribute('lon'))
      })));
    });
    [...xml.getElementsByTagName('rte')].forEach((rte) => {
      tracks.push([...rte.getElementsByTagName('rtept')].map((pt) => ({
        lat: Number(pt.getAttribute('lat')), lng: Number(pt.getAttribute('lon'))
      })));
    });
  }

  const valid = tracks
    .map((track) => track.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)
      && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180))
    .filter((track) => track.length >= 2);
  if (!valid.length) throw new Error('No track or route was found in this file.');
  return valid.reduce((best, track) => (lengthKm(track) > lengthKm(best) ? track : best));
}

/*
  map          the Leaflet map
  db           Firestore
  getSelected  () => the selected trails/{id} document data (with id)
  lineFor      (trail) => the trail's current Leaflet polyline, or null
  showLine     (trail, visible) => hides the trail's own line while it is
               being edited, and brings it back after (optional)
  buttons      { draw: <button>, import: <button>, remove: <button> }
  notify       (message) => void
*/
export function initTrailRoutes({ map, db, getSelected, lineFor, showLine, buttons, notify }) {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const container = map.getContainer();
  const layer = L.layerGroup().addTo(map);
  /* While the editor is open:
     { trail, kind: 'new' | 'edit', points, history, source, fileName,
       register, done, tool: 'draw' | 'erase', smooth, cursor }
     Each point is { lat, lng, d, b }: d when it was drawn or moved by hand
     (smoothed on Save), b when the line has a gap just before it (from
     Erase). The cursor is where the next drawn point goes:
     { at: 'end' } | { at: 'start' } | { at: 'before', ref: <point> }. */
  let editing = null;
  let banner = null;

  // A file picker, opened by Import GPX / KML.
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.gpx,.kml,application/gpx+xml,application/vnd.google-earth.kml+xml';
  fileInput.hidden = true;
  document.body.appendChild(fileInput);

  // The Remove Route confirmation.
  const modal = document.createElement('div');
  modal.className = 'tr-modal';
  modal.innerHTML = `
    <div class="tr-dialog" role="dialog" aria-modal="true" aria-labelledby="trTitle">
      <h3 id="trTitle"><i class="fa-solid fa-route" aria-hidden="true"></i><span>Remove this route?</span></h3>
      <p class="tr-text"></p>
      <div class="tr-error" role="alert"></div>
      <div class="tr-actions">
        <button type="button" class="tr-cancel">Cancel</button>
        <button type="button" class="tr-confirm">Remove Route</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const closeModal = () => modal.classList.remove('open');
  modal.addEventListener('click', (event) => { if (event.target === modal) closeModal(); });
  modal.querySelector('.tr-cancel').addEventListener('click', closeModal);

  // Registering a trail that has no line yet: its route comes first.
  const chooser = document.createElement('div');
  chooser.className = 'tr-modal';
  chooser.innerHTML = `
    <div class="tr-dialog" role="dialog" aria-modal="true" aria-labelledby="trRegTitle">
      <h3 id="trRegTitle"><i class="fa-solid fa-route is-green" aria-hidden="true"></i><span>Add a route first</span></h3>
      <p class="tr-text"></p>
      <div class="tr-choices">
        <button type="button" class="tr-choice" data-choice="draw"><i class="fa-solid fa-pen" aria-hidden="true"></i>
          <span>Draw Route<small>Click along the trail on the map, from start to end.</small></span></button>
        <button type="button" class="tr-choice" data-choice="import"><i class="fa-solid fa-file-import" aria-hidden="true"></i>
          <span>Import GPX / KML<small>A recording of the trail from a GPS app or Google Earth.</small></span></button>
      </div>
      <div class="tr-actions"><button type="button" class="tr-cancel">Cancel</button></div>
    </div>`;
  document.body.appendChild(chooser);
  // The trail being registered while its route is drawn or imported, and
  // what to tell the page when that ends: done(true) once saved.
  let pendingRegister = null;   // { trail, done }

  /* ---- The line, in pieces ---- */

  // The points split at the gaps Erase left: [[point, ...], ...].
  const piecesOf = (points) => points.reduce((pieces, p, i) => {
    if (i === 0 || p.b) pieces.push([p]);
    else pieces[pieces.length - 1].push(p);
    return pieces;
  }, []);

  // A piece without the fill-in points Erase added along straight stretches
  // (they lie on the line, so nothing changes), except where it now ends.
  const withoutFill = (piece) => piece.filter((p, i) => !p.f || i === 0 || i === piece.length - 1);

  // The line as it will be saved: each piece tidied (and smoothed), the
  // pieces joined end to end.
  const finalRoute = () => piecesOf(editing.points)
    .flatMap((piece) => tidy(withoutFill(piece), editing.smooth));

  const gapCount = () => editing.points.filter((p, i) => i > 0 && p.b).length;

  // The point the next drawn point joins (shown pulsing), or null.
  function anchorPoint() {
    const { points, cursor } = editing;
    if (!points.length) return null;
    if (cursor.at === 'start') return points[0];
    if (cursor.at === 'before') {
      const index = points.indexOf(cursor.ref);
      return index > 0 ? points[index - 1] : points[0];
    }
    return points[points.length - 1];
  }

  /* ---- Drawing ---- */

  let frame = 0;
  // Redraws at most once a frame (Erase calls this on every mouse move).
  const redraw = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; draw(); });
  };

  function draw() {
    layer.clearLayers();
    if (!editing) return;
    const { points, tool } = editing;
    const pieces = piecesOf(points);

    // Each piece as it will look once saved.
    pieces.forEach((piece) => {
      const line = tidy(withoutFill(piece), editing.smooth);
      if (line.length < 2) return;
      L.polyline(line, { color: '#fff', weight: 8, opacity: 0.9, interactive: false }).addTo(layer);
      L.polyline(line, { color: ROUTE_COLOR, weight: 4, opacity: 1, interactive: false }).addTo(layer);
    });
    // The gaps, dashed: what Save would join with a straight line.
    pieces.slice(1).forEach((piece, i) => {
      const before = pieces[i][pieces[i].length - 1];
      L.polyline([before, piece[0]], {
        color: '#6b7a70', weight: 2, opacity: 0.9, dashArray: '4 6', interactive: false
      }).addTo(layer);
    });

    const many = points.length > MAX_HANDLES;
    points.forEach((point, index) => {
      const end = index === 0 || index === points.length - 1;
      const atGap = point.b || points[index + 1]?.b;
      if (!end && !atGap && (point.f || (many && !point.d))) return;
      const handle = L.marker(point, {
        draggable: tool === 'draw',
        interactive: tool === 'draw',
        keyboard: false,
        zIndexOffset: end ? 1000 : 500,
        title: index === 0 ? 'Start' : (index === points.length - 1 ? 'End' : `Point ${index + 1}`),
        icon: L.divIcon({ className: `tr-handle${end ? ' is-end' : ''}${atGap && !end ? ' is-gap' : ''}`, iconSize: null })
      }).addTo(layer);
      handle.on('dragend', () => {
        remember();
        const { lat, lng } = handle.getLatLng();
        Object.assign(point, { lat, lng, d: true });
        draw();
      });
      // Right-click a point to take it out.
      handle.on('contextmenu', (event) => {
        L.DomEvent.preventDefault(event.originalEvent);
        remember();
        removeAt(index);
        draw();
      });
    });

    // Where the next click joins the line.
    const anchor = tool === 'draw' && anchorPoint();
    if (anchor) {
      L.marker(anchor, {
        interactive: false, keyboard: false, zIndexOffset: 1500,
        icon: L.divIcon({ className: 'tr-anchor', iconSize: null })
      }).addTo(layer);
    }
    updateBanner();
  }

  // Takes out one point; a gap it carried passes to the next point.
  function removeAt(index) {
    const [gone] = editing.points.splice(index, 1);
    const next = editing.points[index];
    if (gone?.b && next && index > 0) next.b = true;
    if (editing.points[0]) editing.points[0].b = false;
    if (editing.cursor.ref === gone) editing.cursor = next ? { at: 'before', ref: next } : { at: 'end' };
  }

  // Keeps the step before each change, for Undo.
  function snapshot() {
    const { points, cursor } = editing;
    return {
      points: points.map((p) => ({ ...p })),
      cursor: { at: cursor.at, index: cursor.ref ? points.indexOf(cursor.ref) : -1 }
    };
  }
  function remember() {
    editing.history.push(snapshot());
    if (editing.history.length > 200) editing.history.shift();
  }
  function restore(state) {
    editing.points = state.points;
    const ref = state.cursor.index >= 0 ? editing.points[state.cursor.index] : null;
    editing.cursor = state.cursor.at === 'before' && ref ? { at: 'before', ref } : { at: state.cursor.at === 'start' ? 'start' : 'end' };
  }

  function updateBanner() {
    if (!banner || !editing) return;
    const { points, trail, source, fileName, kind, tool } = editing;
    const name = `<strong>${escapeHtml(trail.Trail || 'this trail')}</strong>`;
    let intro;
    if (kind === 'edit') {
      intro = tool === 'erase'
        ? `Erasing on ${name}: click or drag across the parts of the line to remove.`
        : `Editing the route of ${name}: click to draw. New points join the pulsing dot.`;
    } else if (source === 'drawn') {
      intro = tool === 'erase'
        ? `Erasing on ${name}: click or drag across the line to remove part of it.`
        : `Drawing the route of ${name}: click along the trail from start to end.`;
    } else {
      intro = `Imported from <strong>${escapeHtml(fileName || 'the file')}</strong> for ${name}: check it, adjust if needed, then Save.`;
    }
    const km = points.length >= 2 ? lengthKm(finalRoute()).toFixed(2) : '0.00';
    const gaps = gapCount();
    const hint = tool === 'draw'
      ? (points.length <= MAX_HANDLES ? ' · drag a point to move it, right-click to remove it' : ' · drag a drawn point to move it')
      : '';
    banner.querySelector('.tr-text').innerHTML = `${intro}${editing.register ? ' Saving it makes the trail a <strong>Registered Trail</strong>.' : ''}
      <small>${points.length} point${points.length === 1 ? '' : 's'} · ${km} km${hint}</small>
      ${gaps ? `<small class="tr-warn">${gaps} gap${gaps === 1 ? '' : 's'} (dashed): draw across ${gaps === 1 ? 'it' : 'them'}, or Save joins ${gaps === 1 ? 'it' : 'them'} with a straight line.</small>` : ''}`;
    banner.querySelector('.tr-undo').disabled = !editing.history.length;
    banner.querySelector('.tr-clear').disabled = !points.length;
    banner.querySelector('.tr-save').disabled = points.length < 2;
    banner.querySelector('[data-tool="draw"]').setAttribute('aria-pressed', String(tool === 'draw'));
    banner.querySelector('[data-tool="erase"]').setAttribute('aria-pressed', String(tool === 'erase'));
    banner.querySelector('[data-tool="erase"]').disabled = !points.length;
  }

  function setTool(tool) {
    if (!editing || editing.tool === tool) return;
    if (tool === 'erase' && !editing.points.length) return;
    editing.tool = tool;
    container.classList.toggle('tr-drawing', tool === 'draw');
    container.classList.toggle('tr-erasing', tool === 'erase');
    // Dragging the map would fight the eraser.
    if (tool === 'erase') map.dragging.disable(); else map.dragging.enable();
    draw();
  }

  function stop() {
    // Cancelled while registering: the trail stays unregistered.
    const done = editing?.done;
    const hidden = editing?.hidLine ? editing.trail : null;
    editing = null;
    done?.(false);
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    layer.clearLayers();
    banner?.remove();
    banner = null;
    container.classList.remove('tr-drawing', 'tr-erasing');
    map.dragging.enable();
    map.doubleClickZoom.enable();
    erasing = false;
    if (hidden) showLine?.(hidden, true);
  }

  function start(trail, points, source, fileName = '', register = null, kind = 'new') {
    stop();
    editing = {
      trail,
      kind,
      points: points.map((p) => ({ lat: Number(p.lat), lng: Number(p.lng), d: kind === 'new' && source === 'drawn' })),
      history: [],
      source,
      fileName,
      // Registering: saving the route also makes it a Registered Trail.
      register: Boolean(register),
      done: register?.done || null,
      tool: 'draw',
      smooth: true,
      cursor: { at: 'end' },
      hidLine: false
    };
    // The trail's own line would show under the one being edited.
    if (kind === 'edit' && showLine) {
      showLine(trail, false);
      editing.hidLine = true;
    }
    container.classList.add('tr-drawing');
    // Double-clicking would zoom between two clicked points.
    map.doubleClickZoom.disable();

    banner = document.createElement('div');
    banner.className = 'tr-banner';
    banner.innerHTML = `
      <i class="fa-solid fa-route" aria-hidden="true"></i>
      <span class="tr-text"></span>
      <span class="tr-buttons">
        <span class="tr-tools" role="group" aria-label="Tool">
          <button type="button" data-tool="draw" title="Draw (D): click to add points"><i class="fa-solid fa-pen" aria-hidden="true"></i>Draw</button>
          <button type="button" data-tool="erase" title="Erase (E): click or drag across the line"><i class="fa-solid fa-eraser" aria-hidden="true"></i>Erase</button>
        </span>
        <label class="tr-smooth" title="Turn clicked corners into smooth curves"><input type="checkbox" class="tr-smooth-box" checked>Smooth</label>
        <button type="button" class="tr-undo" title="Undo (Ctrl+Z)"><i class="fa-solid fa-rotate-left" aria-hidden="true"></i>Undo</button>
        <button type="button" class="tr-clear" title="Start the line over"><i class="fa-solid fa-trash-can" aria-hidden="true"></i>Clear</button>
        <button type="button" class="tr-cancel-draw">Cancel</button>
        <button type="button" class="tr-save"><i class="fa-solid fa-check" aria-hidden="true"></i>Save Route</button>
      </span>`;
    L.DomEvent.disableClickPropagation(banner);
    L.DomEvent.disableScrollPropagation(banner);
    banner.querySelectorAll('[data-tool]').forEach((button) => {
      button.addEventListener('click', () => setTool(button.dataset.tool));
    });
    banner.querySelector('.tr-smooth-box').addEventListener('change', (event) => {
      if (!editing) return;
      editing.smooth = event.target.checked;
      draw();
    });
    banner.querySelector('.tr-undo').addEventListener('click', undo);
    banner.querySelector('.tr-clear').addEventListener('click', () => {
      if (!editing?.points.length) return;
      remember();
      editing.points = [];
      editing.cursor = { at: 'end' };
      setTool('draw');
      draw();
    });
    banner.querySelector('.tr-cancel-draw').addEventListener('click', stop);
    banner.querySelector('.tr-save').addEventListener('click', save);
    container.appendChild(banner);

    draw();
    const bounds = editing.points.length >= 2
      ? L.latLngBounds(editing.points)
      : lineFor?.(trail)?.getBounds();
    if (bounds?.isValid()) map.fitBounds(bounds, { padding: [40, 40] });
    container.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function undo() {
    if (!editing?.history.length) return;
    restore(editing.history.pop());
    if (!editing.points.length) setTool('draw');
    draw();
  }

  /* ---- Draw: adding points ---- */

  map.on('click', (event) => {
    if (!editing || editing.tool !== 'draw') return;
    const { points, cursor } = editing;
    const here = map.latLngToContainerPoint(event.latlng);

    // A click on the far side of the gap being filled closes it.
    if (cursor.at === 'before' && points.includes(cursor.ref)) {
      const far = map.latLngToContainerPoint(cursor.ref);
      if (far.distanceTo(here) <= SNAP_PX) {
        remember();
        cursor.ref.b = false;
        // Carry on at the next gap, or at the end.
        const next = points.find((p, i) => i > 0 && p.b);
        editing.cursor = next ? { at: 'before', ref: next } : { at: 'end' };
        draw();
        return;
      }
    }

    if (points.length >= MAX_POINTS) {
      notify?.(`A route can have up to ${MAX_POINTS} points.`);
      return;
    }
    remember();
    const point = { lat: event.latlng.lat, lng: event.latlng.lng, d: true };
    if (cursor.at === 'start') points.unshift(point);
    else if (cursor.at === 'before' && points.includes(cursor.ref)) points.splice(points.indexOf(cursor.ref), 0, point);
    else points.push(point);
    draw();
  });

  /* ---- Erase: rubbing out part of the line ---- */

  let erasing = false;
  let strokeRemembered = false;
  let strokeBefore = null;

  // Removes the points under the eraser at `latlng`. A long straight stretch
  // is first filled with points, so it can be cut part way along. Returns
  // true when something was erased.
  function eraseAt(latlng) {
    const points = editing.points;
    if (!points.length) return false;
    const c = map.latLngToContainerPoint(latlng);
    const px = (p) => map.latLngToContainerPoint([p.lat, p.lng]);

    for (let i = points.length - 2; i >= 0; i -= 1) {
      if (points[i + 1].b) continue;                    // no line across a gap
      const a = px(points[i]); const b = px(points[i + 1]);
      if (pxToSegment(c, a, b) > ERASE_PX) continue;
      const steps = Math.floor(a.distanceTo(b) / (ERASE_PX / 2));
      if (steps < 2) continue;
      const fill = Array.from({ length: steps - 1 }, (_, k) => {
        const t = (k + 1) / steps;
        // f: a fill-in point, on the old straight line (no handle; dropped on Save).
        return {
          lat: points[i].lat + (points[i + 1].lat - points[i].lat) * t,
          lng: points[i].lng + (points[i + 1].lng - points[i].lng) * t,
          d: false,
          f: true
        };
      });
      points.splice(i + 1, 0, ...fill);
    }

    const hit = points.map((p) => px(p).distanceTo(c) <= ERASE_PX);
    if (!hit.some(Boolean)) return false;
    // One Undo step per stroke, back to before it began.
    if (!strokeRemembered && strokeBefore) {
      editing.history.push(strokeBefore);
      if (editing.history.length > 200) editing.history.shift();
      strokeRemembered = true;
    }

    // The first point kept after each erased run starts a new piece.
    const kept = [];
    let firstRun = null;
    points.forEach((p, i) => {
      if (hit[i]) return;
      if (i > 0 && hit[i - 1] && kept.length) {
        p.b = true;
        if (!firstRun) firstRun = { at: 'before', ref: p };
      }
      kept.push(p);
    });
    if (kept[0]) kept[0].b = false;
    const erasedStart = hit[0];
    const erasedEnd = hit[hit.length - 1];
    editing.points = kept;
    // Drawing carries on where the line was cut.
    editing.cursor = firstRun
      || (erasedStart && kept.length ? { at: 'start' } : null)
      || (erasedEnd ? { at: 'end' } : editing.cursor);
    if (editing.cursor.ref && !kept.includes(editing.cursor.ref)) editing.cursor = { at: 'end' };
    return true;
  }

  let lastDownAt = 0;
  map.on('mousedown', (event) => {
    if (!editing || editing.tool !== 'erase') return;
    lastDownAt = Date.now();
    erasing = true;
    strokeRemembered = false;
    strokeBefore = snapshot();
    if (eraseAt(event.latlng)) redraw();
  });
  map.on('mousemove', (event) => {
    if (!erasing || !editing || editing.tool !== 'erase') return;
    if (eraseAt(event.latlng)) redraw();
  });
  const endErase = () => {
    if (!erasing) return;
    erasing = false;
    if (editing) draw();
    // Nothing left to erase: back to Draw, after the click this release
    // makes (which would otherwise add a point).
    setTimeout(() => { if (editing && !editing.points.length) setTool('draw'); }, 0);
  };
  map.on('mouseup', endErase);
  document.addEventListener('mouseup', endErase);
  // A tap on a touch screen comes as a click alone, with no mousedown.
  map.on('click', (event) => {
    if (!editing || editing.tool !== 'erase' || Date.now() - lastDownAt < 600) return;
    strokeRemembered = false;
    strokeBefore = snapshot();
    if (eraseAt(event.latlng)) {
      if (!editing.points.length) setTool('draw');
      draw();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (chooser.classList.contains('open')) chooser.onclick?.({ target: chooser });
      else if (modal.classList.contains('open')) closeModal();
      else if (editing) stop();
      return;
    }
    if (!editing || /^(input|textarea|select)$/i.test(event.target?.tagName || '') || event.target?.isContentEditable) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      undo();
    } else if (!event.ctrlKey && !event.metaKey && !event.altKey) {
      if (event.key.toLowerCase() === 'e') setTool('erase');
      if (event.key.toLowerCase() === 'd') setTool('draw');
    }
  });

  /* ---- Saving ---- */

  async function save() {
    if (!editing || editing.points.length < 2) return;
    const button = banner.querySelector('.tr-save');
    button.disabled = true;
    const { trail, source, register, kind } = editing;
    const route = fitPoints(finalRoute());
    if (route.length < 2) {
      button.disabled = false;
      notify?.('The route needs at least two points far enough apart.');
      return;
    }
    // A route changed by hand counts as drawn; an untouched recording keeps its source.
    const touched = editing.points.some((p) => p.d) || editing.history.length > 0;
    const routeSource = kind === 'edit'
      ? (touched || !['gpx', 'kml'].includes(source) ? 'drawn' : source)
      : source;
    const replacesStandard = !validRoute(trail.route) && Boolean(trailLineKey(trail.Trail));
    try {
      await updateDoc(doc(db, 'trails', trail.id), {
        route: route.map((p) => ({ lat: Number(p.lat.toFixed(6)), lng: Number(p.lng.toFixed(6)) })),
        routeSource,
        // Drawn exactly as saved on every map, the app's too: nothing (no
        // jump-off road) is added to what the editor showed.
        routeExact: true,
        routeUpdatedAt: serverTimestamp(),
        UpdatedAt: serverTimestamp(),
        ...(register ? { EntryType: 'Registered Trail' } : {})
      });
      const done = editing.done;
      editing.done = null;
      stop();
      done?.(true);
      const name = trail.Trail || 'the trail';
      notify?.(register
        ? `Route saved. ${trail.Trail || 'The trail'} is now a Registered Trail and shows on every map.`
        : kind === 'edit'
          ? `Route updated for ${name}.${replacesStandard ? ' It now replaces the standard line' : ' The new line shows'} on every map.`
          : `Route saved for ${name}. It now shows on every map.`);
    } catch (error) {
      console.error('Could not save the route:', error);
      button.disabled = false;
      notify?.(error?.code === 'permission-denied'
        ? 'Firebase denied this. Only admins (not Viewers) can change a trail\'s route.'
        : `Could not save the route: ${error?.message || 'Unknown error'}`);
    }
  }

  function askRemove(trail) {
    modal.querySelector('.tr-text').textContent =
      `${trail.Trail || 'This trail'} will no longer have a line on the maps. `
      + 'You can then draw or import a new route for it.';
    modal.querySelector('.tr-error').textContent = '';
    modal.classList.add('open');
    const confirm = modal.querySelector('.tr-confirm');
    confirm.onclick = async () => {
      confirm.disabled = true;
      try {
        await updateDoc(doc(db, 'trails', trail.id), {
          route: deleteField(),
          routeSource: deleteField(),
          routeExact: deleteField(),
          routeUpdatedAt: serverTimestamp(),
          UpdatedAt: serverTimestamp()
        });
        closeModal();
        stop();
      } catch (error) {
        console.error('Could not remove the route:', error);
        modal.querySelector('.tr-error').textContent = error?.code === 'permission-denied'
          ? 'Only admins (not Viewers) can change a trail\'s route.'
          : 'The route could not be removed. Try again.';
      } finally {
        confirm.disabled = false;
      }
    };
  }

  /* ---- Buttons ---- */

  // Only a Registered Trail (Entry Type, incl. its older names Legal Entry /
  // Registered Map) gets a line on the maps; the app hides the others too.
  const REGISTERED = ['Registered Trail', 'Legal Entry', 'Registered Map'];
  const isRegistered = (trail) => REGISTERED.includes(String(trail?.EntryType || '').trim());

  // Whether a trail already has a line on the maps (a saved route, or the
  // standard line of the built-in trails).
  const hasLine = (trail) => validRoute(trail?.route) || Boolean(trailLineKey(trail?.Trail));

  // Whether Edit Route can open this trail's line.
  const canEditRoute = (trail) => Boolean(trail) && isRegistered(trail) && hasLine(trail);

  // Why a trail cannot get a new route, or '' when it can. While it is being
  // registered (registerWithRoute) the route is what registers it.
  const lockedReason = (trail, registering = false) => {
    if (!registering && !isRegistered(trail)) return `${trail?.Trail || 'This trail'} is not a Registered Trail. Set its Entry Type to Registered Trail to draw or import a route.`;
    if (validRoute(trail?.route)) return `${trail.Trail || 'This trail'} already has a route. Use Edit Route to change it, or Remove Route first to import a new one.`;
    if (trailLineKey(trail?.Trail)) return `${trail.Trail || 'This trail'} already has its standard line on the maps. Use Edit Route to change it.`;
    return '';
  };

  // Draw Route (or Edit Route), Import and Remove Route follow the selected trail.
  function update(trail) {
    const reason = trail ? lockedReason(trail) : '';
    const editable = canEditRoute(trail);
    const registering = editing?.register && trail?.id === editing.trail.id;
    if (buttons.draw) {
      buttons.draw.textContent = editable ? '✏️ Edit Route' : '✏️ Draw Route';
      buttons.draw.disabled = editable ? false : Boolean(reason);
      buttons.draw.title = editable
        ? 'Erase, redraw or adjust this trail\'s line on the map'
        : (reason || buttons.draw.dataset.title || '');
    }
    if (buttons.import) {
      buttons.import.disabled = Boolean(reason);
      buttons.import.title = reason || buttons.import.dataset.title || '';
    }
    if (buttons.remove) buttons.remove.hidden = !validRoute(trail?.route);
    // The trail may have gained a route elsewhere while a new one was being drawn.
    if (editing?.kind === 'new' && trail?.id === editing.trail.id && lockedReason(trail, registering)) stop();
  }
  [buttons.draw, buttons.import].forEach((button) => {
    if (button) button.dataset.title = button.title;
  });

  // The selected trail, if it can get a new route; otherwise says why not.
  const routableTrail = () => {
    const trail = getSelected();
    if (!trail) {
      notify?.('Select a trail in the Trail List first.');
      return null;
    }
    const reason = lockedReason(trail);
    if (reason) {
      notify?.(reason);
      return null;
    }
    return trail;
  };

  // Opens the trail's current line in the editor exactly as the maps draw
  // it (any jump-off road included, so it can be erased too): its saved
  // route, or the standard line from the trail file (saving it then
  // replaces that line).
  function editRoute(trail = getSelected()) {
    if (!trail) {
      notify?.('Select a trail in the Trail List first.');
      return;
    }
    if (!isRegistered(trail)) {
      notify?.(`${trail.Trail || 'This trail'} is not a Registered Trail, so it has no line on the maps to edit.`);
      return;
    }
    const shown = (lineFor?.(trail)?.getLatLngs().flat(Infinity) || []).map((p) => ({ lat: p.lat, lng: p.lng }));
    const points = shown.length >= 2
      ? shown
      : (trail.route || []).filter((p) => Number.isFinite(Number(p?.lat)) && Number.isFinite(Number(p?.lng)));
    if (points.length < 2) {
      notify?.(`${trail.Trail || 'This trail'} has no line on the map yet. Use Draw Route or Import GPX / KML.`);
      return;
    }
    start(trail, points, trail.routeSource || 'drawn', '', null, 'edit');
  }

  buttons.draw?.addEventListener('click', () => {
    const trail = getSelected();
    if (canEditRoute(trail)) {
      editRoute(trail);
      return;
    }
    if (routableTrail()) start(trail, [], 'drawn');
  });

  buttons.import?.addEventListener('click', () => {
    if (!routableTrail()) return;
    fileInput.value = '';
    fileInput.click();
  });

  buttons.remove?.addEventListener('click', () => {
    const trail = getSelected();
    if (trail && validRoute(trail.route)) askRemove(trail);
  });

  // Closing the file picker without a file cancels a registration.
  fileInput.addEventListener('cancel', () => {
    const waiting = pendingRegister;
    pendingRegister = null;
    waiting?.done(false);
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    const waiting = pendingRegister;
    pendingRegister = null;
    const trail = waiting?.trail || getSelected();
    if (!file || !trail || lockedReason(trail, Boolean(waiting))) {
      waiting?.done(false);
      return;
    }
    try {
      const track = parseRouteFile(await file.text(), file.name);
      // A recording somewhere else entirely is almost surely the wrong file.
      const area = map.options.maxBounds;
      const onMountain = area ? track.filter((p) => area.contains([p.lat, p.lng])).length : track.length;
      if (!onMountain) throw new Error('This recording is not on Mount Makiling.');
      const points = fitPoints(track);
      start(trail, points, /\.kml$/i.test(file.name) ? 'kml' : 'gpx', file.name, waiting);
    } catch (error) {
      waiting?.done(false);
      notify?.(error.message || 'The file could not be imported.');
    }
  });

  /* ---- Registering ---- */

  /* Makes `trail` a Registered Trail through its route: asks to draw or
     import one, and only saving it writes Entry Type "Registered Trail".
     Resolves true once registered, false if the route was not saved. */
  function registerWithRoute(trail) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      const register = { trail, done };
      chooser.querySelector('.tr-text').innerHTML = `<strong>${escapeHtml(trail.Trail || 'This trail')}</strong> has no route on the map yet. `
        + 'A Registered Trail needs one: draw it or import a recording. It becomes a Registered Trail once the route is saved.';
      const close = () => {
        chooser.classList.remove('open');
        chooser.onclick = null;
      };
      chooser.onclick = (event) => {
        const choice = event.target.closest('[data-choice]')?.dataset.choice;
        if (event.target === chooser || event.target.closest('.tr-cancel')) {
          close();
          done(false);
        } else if (choice === 'draw') {
          close();
          start(trail, [], 'drawn', '', register);
        } else if (choice === 'import') {
          close();
          pendingRegister = register;
          fileInput.value = '';
          fileInput.click();
        }
      };
      chooser.classList.add('open');
      chooser.querySelector('[data-choice="draw"]').focus();
    });
  }

  return {
    stop,
    update,
    hasLine,
    canEditRoute,
    editRoute,
    registerWithRoute,
    isEditing: () => Boolean(editing)
  };
}
