// trail-routes.js
// The route of a trail, for Trail Management's map (trail.html): the line a
// trail is drawn with on every map, saved on the trail itself as
//
//   trails/{id}.route         [{ lat, lng }, ...] from trailhead to end
//   trails/{id}.routeSource   'drawn' | 'gpx' | 'kml'
//   trails/{id}.routeUpdatedAt
//
// Only a trail with no line yet can get one: a trail that already has a
// saved route, or one of the built-in trails drawn from the trail file
// (Mariang Makiling, Sipit, MakTrav, Mud Spring, Flat Rocks), has Draw Route
// and Import turned off. A saved route can be removed (Remove Route), which
// turns them back on.
//
// Two ways in, ending in the same editor:
//   Draw Route         click along the trail on the map, point by point
//   Import GPX / KML   a GPS recording of the trail (Strava, AllTrails, a GPS
//                      watch, Google My Maps), simplified, shown to check
// In the editor, points can be dragged, right-clicked away, undone and
// cleared before Save. makiling-area.js draws every saved route on every map,
// and a route on one of the built-in trails replaces its line from the file.
// Admins can already write trails (firestore.rules), so no rule changes.

import {
  deleteField,
  doc,
  serverTimestamp,
  updateDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { trailLineKey, validRoute } from "./makiling-area.js";

const ROUTE_COLOR = '#f08c00';
const MAX_POINTS = 1000;        // plenty for a mountain trail, small for Firestore
const MAX_HANDLES = 400;        // draggable point handles shown up to this many points

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

const CSS = `
.tr-drawing, .tr-drawing .leaflet-interactive { cursor:crosshair !important; }
.tr-drawing .tr-handle { cursor:grab !important; }
.tr-banner { position:absolute; top:10px; left:50%; transform:translateX(-50%); z-index:800;
  display:flex; flex-wrap:wrap; align-items:center; justify-content:center; gap:8px;
  width:max-content; max-width:calc(100% - 20px); padding:8px 10px 8px 14px; border-radius:10px;
  background:var(--dm-surface,#fff); color:var(--text-primary); box-shadow:0 4px 14px rgba(0,0,0,.25);
  font-size:12.5px; font-weight:600; }
.tr-banner > i { color:${ROUTE_COLOR}; }
.tr-banner .tr-text { max-width:360px; line-height:1.4; }
.tr-banner .tr-text small { display:block; font-weight:500; color:var(--text-secondary); }
.tr-banner .tr-buttons { display:flex; flex-wrap:wrap; gap:6px; }
.tr-banner button { display:inline-flex; align-items:center; gap:5px; border:1px solid var(--border);
  background:var(--dm-surface-2,#f5f5f2); color:var(--text-primary); border-radius:7px; padding:5px 10px;
  font-size:12px; font-weight:600; cursor:pointer; }
.tr-banner button i { color:inherit; }
.tr-banner button[disabled] { opacity:.5; cursor:not-allowed; }
.tr-banner .tr-save { border-color:var(--accent); background:var(--accent); color:#fff; }
.tr-banner .tr-delete { color:#c8402f; }
.tr-handle { width:12px; height:12px; margin:-6px 0 0 -6px; border-radius:50%; background:#fff;
  border:3px solid ${ROUTE_COLOR}; box-shadow:0 1px 3px rgba(0,0,0,.4); box-sizing:border-box; }
.tr-handle.is-end { width:16px; height:16px; margin:-8px 0 0 -8px; border-color:#1f6b39; }
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
`;

/* ---- Geometry ---- */

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
  let tolerance = 3;
  let result = simplify(points, tolerance);
  while (result.length > MAX_POINTS) {
    tolerance *= 1.6;
    result = simplify(points, tolerance);
  }
  return result;
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
  buttons      { draw: <button>, import: <button>, remove: <button> }
  notify       (message) => void
*/
export function initTrailRoutes({ map, db, getSelected, lineFor, buttons, notify }) {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const container = map.getContainer();
  const layer = L.layerGroup().addTo(map);
  let editing = null;   // { trail, points: [{lat,lng}], history: [...], source, fileName }
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

  /* ---- Drawing ---- */

  function draw() {
    layer.clearLayers();
    if (!editing) return;
    const { points } = editing;
    if (points.length >= 2) {
      L.polyline(points, { color: '#fff', weight: 8, opacity: 0.9, interactive: false }).addTo(layer);
      L.polyline(points, { color: ROUTE_COLOR, weight: 4, opacity: 1, interactive: false }).addTo(layer);
    }
    if (points.length <= MAX_HANDLES) {
      points.forEach((point, index) => {
        const end = index === 0 || index === points.length - 1;
        const handle = L.marker(point, {
          draggable: true,
          keyboard: false,
          zIndexOffset: end ? 1000 : 500,
          title: index === 0 ? 'Start' : (index === points.length - 1 ? 'End' : `Point ${index + 1}`),
          icon: L.divIcon({ className: `tr-handle${end ? ' is-end' : ''}`, iconSize: null })
        }).addTo(layer);
        handle.on('dragend', () => {
          remember();
          const { lat, lng } = handle.getLatLng();
          editing.points[index] = { lat, lng };
          draw();
        });
        // Right-click a point to take it out.
        handle.on('contextmenu', (event) => {
          L.DomEvent.preventDefault(event.originalEvent);
          remember();
          editing.points.splice(index, 1);
          draw();
        });
      });
    }
    updateBanner();
  }

  // Keeps the step before each change, for Undo.
  function remember() {
    editing.history.push(editing.points.map((p) => ({ ...p })));
    if (editing.history.length > 200) editing.history.shift();
  }

  function updateBanner() {
    if (!banner || !editing) return;
    const { points, trail, source, fileName } = editing;
    const km = lengthKm(points).toFixed(2);
    const intro = source === 'drawn'
      ? `Drawing the route of <strong>${escapeHtml(trail.Trail || 'this trail')}</strong>: click along the trail from start to end.`
      : `Imported from <strong>${escapeHtml(fileName || 'the file')}</strong> for <strong>${escapeHtml(trail.Trail || 'this trail')}</strong>: check it, adjust if needed, then Save.`;
    banner.querySelector('.tr-text').innerHTML = `${intro}
      <small>${points.length} point${points.length === 1 ? '' : 's'} · ${km} km${points.length <= MAX_HANDLES ? ' · drag a point to move it, right-click to remove it' : ''}</small>`;
    banner.querySelector('.tr-undo').disabled = !editing.history.length;
    banner.querySelector('.tr-clear').disabled = !points.length;
    banner.querySelector('.tr-save').disabled = points.length < 2;
  }

  function stop() {
    editing = null;
    layer.clearLayers();
    banner?.remove();
    banner = null;
    container.classList.remove('tr-drawing');
    map.doubleClickZoom.enable();
  }

  function start(trail, points, source, fileName = '') {
    stop();
    editing = { trail, points: points.map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) })), history: [], source, fileName };
    container.classList.add('tr-drawing');
    // Double-clicking would zoom between two clicked points.
    map.doubleClickZoom.disable();

    banner = document.createElement('div');
    banner.className = 'tr-banner';
    banner.innerHTML = `
      <i class="fa-solid fa-route" aria-hidden="true"></i>
      <span class="tr-text"></span>
      <span class="tr-buttons">
        <button type="button" class="tr-undo"><i class="fa-solid fa-rotate-left" aria-hidden="true"></i>Undo</button>
        <button type="button" class="tr-clear"><i class="fa-solid fa-eraser" aria-hidden="true"></i>Clear</button>
        <button type="button" class="tr-cancel-draw">Cancel</button>
        <button type="button" class="tr-save"><i class="fa-solid fa-check" aria-hidden="true"></i>Save Route</button>
      </span>`;
    L.DomEvent.disableClickPropagation(banner);
    L.DomEvent.disableScrollPropagation(banner);
    banner.querySelector('.tr-undo').addEventListener('click', () => {
      if (!editing?.history.length) return;
      editing.points = editing.history.pop();
      draw();
    });
    banner.querySelector('.tr-clear').addEventListener('click', () => {
      if (!editing?.points.length) return;
      remember();
      editing.points = [];
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

  map.on('click', (event) => {
    if (!editing) return;
    if (editing.points.length >= MAX_POINTS) {
      notify?.(`A route can have up to ${MAX_POINTS} points.`);
      return;
    }
    remember();
    editing.points.push({ lat: event.latlng.lat, lng: event.latlng.lng });
    draw();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (modal.classList.contains('open')) closeModal();
    else if (editing) stop();
  });

  /* ---- Saving ---- */

  async function save() {
    if (!editing || editing.points.length < 2) return;
    const button = banner.querySelector('.tr-save');
    button.disabled = true;
    const { trail, points, source } = editing;
    try {
      await updateDoc(doc(db, 'trails', trail.id), {
        route: points.map((p) => ({ lat: Number(p.lat.toFixed(6)), lng: Number(p.lng.toFixed(6)) })),
        routeSource: source,
        routeUpdatedAt: serverTimestamp(),
        UpdatedAt: serverTimestamp()
      });
      stop();
      notify?.(`Route saved for ${trail.Trail || 'the trail'}. It now shows on every map.`);
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

  // Why a trail cannot get a new route, or '' when it can.
  const lockedReason = (trail) => {
    if (validRoute(trail?.route)) return `${trail.Trail || 'This trail'} already has a route. Remove it first to draw or import a new one.`;
    if (trailLineKey(trail?.Trail)) return `${trail.Trail || 'This trail'} already has its standard line on the maps.`;
    return '';
  };

  // Draw Route, Import and Remove Route follow the selected trail.
  function update(trail) {
    const reason = trail ? lockedReason(trail) : '';
    [buttons.draw, buttons.import].forEach((button) => {
      if (!button) return;
      button.disabled = Boolean(reason);
      button.title = reason || button.dataset.title || '';
    });
    if (buttons.remove) buttons.remove.hidden = !validRoute(trail?.route);
    // The trail may have gained a route elsewhere while one was being drawn.
    if (editing && trail?.id === editing.trail.id && reason) stop();
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

  buttons.draw?.addEventListener('click', () => {
    const trail = routableTrail();
    if (trail) start(trail, [], 'drawn');
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

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    const trail = getSelected();
    if (!file || !trail || lockedReason(trail)) return;
    try {
      const track = parseRouteFile(await file.text(), file.name);
      // A recording somewhere else entirely is almost surely the wrong file.
      const area = map.options.maxBounds;
      const onMountain = area ? track.filter((p) => area.contains([p.lat, p.lng])).length : track.length;
      if (!onMountain) throw new Error('This recording is not on Mount Makiling.');
      const points = fitPoints(track);
      start(trail, points, /\.kml$/i.test(file.name) ? 'kml' : 'gpx', file.name);
    } catch (error) {
      notify?.(error.message || 'The file could not be imported.');
    }
  });

  return { stop, update, isEditing: () => Boolean(editing) };
}
