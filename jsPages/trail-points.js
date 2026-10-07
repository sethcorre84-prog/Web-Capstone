// trail-points.js
// Checkpoints and campsites on Trail Management's map (trail.html): the
// "+ Add Checkpoints" and "+ Add Campsites" buttons, and the pins they make.
//
// Each point belongs to a trail and is saved on that trail's own document,
// trails/{id}, in a `checkpoints` or `campsites` array of
//   { id, name, note, lat, lng, createdAt (ISO string), createdBy }
// Admins can already write trails (firestore.rules), so no new rules are
// needed. Arrays rather than a collection because a trail has a handful of
// these at most, and they then arrive with the trail snapshot the page
// already listens to.

import {
  arrayUnion,
  doc,
  getDoc,
  updateDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { trailLineKey } from "./makiling-area.js";
import { STATION_COORDS } from "./trail-stations.js";

/* Suggested checkpoints for each trail, added by Trail Management's
   "+ Suggested Checkpoints" button: the places hikers log in or that mark a
   leg of the climb, from the same sources as the station reference list
   (trail-stations.js). Positions are estimates on the trail line (stations
   from STATION_COORDS, Peak 2 and the jump-offs from the trail data); an
   admin can remove any of them and place it again by hand. */
const PEAK_2 = [14.13574, 121.19387];
const at = (key, n) => STATION_COORDS[key][n];
export const SUGGESTED_CHECKPOINTS = {
  mariang: [
    { name: 'MCME Registration', note: 'Station 1. Log in at the Makiling Center for Mountain Ecosystems office.', at: at('mariang', 1) },
    { name: 'Agila Base', note: 'Station 11. Second log-in before the forest; rangers enforce the morning cut-off here.', at: at('mariang', 11) },
    { name: 'Peak 2 Summit', note: 'Station 30. 1,090 MASL, end of the trail.', at: PEAK_2 }
  ],
  sipit: [
    { name: 'Sto. Tomas Jump-off', note: 'Start of the Sipit Trail. Register before the climb.', at: [14.10642, 121.18826] },
    { name: 'Melkas Campsite', note: 'Station 15. Last campsite before Haring Bato and the ridge.', at: at('sipit', 15) },
    { name: 'Peak 2 Summit', note: 'Station 21. 1,090 MASL.', at: PEAK_2 }
  ],
  traverse: [
    { name: 'Sto. Tomas Start', note: 'Start of the traverse, up the Sipit side. Register before the climb.', at: [14.1091, 121.1657] },
    { name: 'Peak 2 Summit', note: '1,090 MASL, halfway point of the traverse.', at: PEAK_2 },
    { name: 'Agila Base', note: 'Mariang Makiling Station 11. Log back in on the way down.', at: at('mariang', 11) },
    { name: 'MCME Exit', note: 'Mariang Makiling Station 1. Log out at the MCME office, Los Baños.', at: at('mariang', 1) }
  ],
  botanic: [
    // The main entrance on Mauricio Oteyza Road, by the garden's bus stop
    // (OpenStreetMap node 3345224348).
    { name: 'Botanic Gardens Entrance', note: 'Main entrance of the Makiling Botanic Gardens on Mauricio Oteyza Road, Los Baños, beside the bus stop and parking.', at: [14.15487, 121.23527] }
  ]
};

const suggestionKey = (trail) => trailLineKey(trail?.Trail)
  || (/botanic/i.test(String(trail?.Trail || '')) ? 'botanic' : null);

/* The "+ Suggested Checkpoints" popup, styled like the Add Checkpoint one
   (needs initTrailPoints to have run, which adds those styles): lists what
   each trail will get, greying out the ones it already has, then adds them
   and shows the result in the same popup. `trails` is the page's current
   trail list (with id). */
export function openSuggestedCheckpointsDialog({ db, trails }) {
  const modal = document.createElement('div');
  modal.className = 'tp-modal open';
  document.body.appendChild(modal);
  let busy = false;
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() {
    if (busy) return;
    modal.remove();
    document.removeEventListener('keydown', onKey);
  }
  document.addEventListener('keydown', onKey);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  const plan = trails
    .map((trail) => {
      const suggestions = SUGGESTED_CHECKPOINTS[suggestionKey(trail)];
      if (!suggestions) return null;
      const have = new Set((Array.isArray(trail.checkpoints) ? trail.checkpoints : [])
        .map((p) => String(p?.name || '').trim().toLowerCase()));
      return { trail, items: suggestions.map((s) => ({ name: s.name, done: have.has(s.name.toLowerCase()) })) };
    })
    .filter(Boolean)
    .sort((a, b) => String(a.trail.Trail || '').localeCompare(String(b.trail.Trail || '')));
  const toAdd = plan.reduce((sum, p) => sum + p.items.filter((i) => !i.done).length, 0);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  const header = (icon, title, sub) => `
    <h3 id="tpSuggestTitle"><i class="fa-solid ${icon}" aria-hidden="true"></i><span>${title}</span></h3>
    ${sub ? `<p class="tp-sub">${sub}</p>` : ''}`;

  function showResult(icon, title, text) {
    modal.innerHTML = `
      <div class="tp-dialog" role="dialog" aria-modal="true" aria-labelledby="tpSuggestTitle">
        ${header(icon, title, '')}
        <div class="tp-result">${escapeHtml(text)}</div>
        <div class="tp-actions"><button type="button" class="tp-save">Done</button></div>
      </div>`;
    const done = modal.querySelector('.tp-save');
    done.addEventListener('click', close);
    done.focus();
  }

  if (!plan.length) {
    showResult('fa-flag', 'Suggested Checkpoints', 'None of the trails has a suggested list.');
    return;
  }
  if (!toAdd) {
    showResult('fa-circle-check', 'Suggested Checkpoints', 'Every trail already has its suggested checkpoints.');
    return;
  }

  modal.innerHTML = `
    <div class="tp-dialog" role="dialog" aria-modal="true" aria-labelledby="tpSuggestTitle">
      ${header('fa-flag', 'Add Suggested Checkpoints', `${plural(toAdd, 'checkpoint')} will be added to the trails below.`)}
      <ul class="tp-list">${plan.map((p) => `
        <li>
          <strong>${escapeHtml(p.trail.Trail || 'Untitled Trail')}</strong>
          <ul>${p.items.map((i) => `
            <li class="${i.done ? 'is-done' : ''}"><i class="fa-solid ${i.done ? 'fa-check' : 'fa-flag'}" aria-hidden="true"></i>${escapeHtml(i.name)}${i.done ? ' · already added' : ''}</li>`).join('')}
          </ul>
        </li>`).join('')}
      </ul>
      <p class="tp-note-line">Positions are estimates on the trail line; you can remove any of them on the map and place it again.</p>
      <div class="tp-error" role="alert"></div>
      <div class="tp-actions">
        <button type="button" class="tp-cancel">Cancel</button>
        <button type="button" class="tp-save">Add ${plural(toAdd, 'Checkpoint')}</button>
      </div>
    </div>`;
  const cancel = modal.querySelector('.tp-cancel');
  const save = modal.querySelector('.tp-save');
  cancel.addEventListener('click', close);
  save.focus();
  save.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    save.disabled = true;
    cancel.disabled = true;
    save.textContent = 'Adding…';
    try {
      const { added, trails: count } = await addSuggestedCheckpoints(db, trails);
      busy = false;
      showResult('fa-circle-check', 'Checkpoints Added', added
        ? `Added ${plural(added, 'checkpoint')} to ${plural(count, 'trail')}. They are on the map now.`
        : 'Every trail already has its suggested checkpoints.');
    } catch (error) {
      busy = false;
      save.disabled = false;
      cancel.disabled = false;
      save.textContent = 'Try Again';
      modal.querySelector('.tp-error').textContent = error?.code === 'permission-denied'
        ? 'Firebase denied this. Only admins can add checkpoints.'
        : `Could not add the checkpoints: ${error?.message || 'Unknown error'}`;
    }
  });
}

/* Adds the suggested checkpoints to every trail that has a list, skipping
   any a trail already has by name (so pressing it twice adds nothing).
   Returns { added, trails } counts. */
export async function addSuggestedCheckpoints(db, trails) {
  let added = 0;
  let touched = 0;
  for (const trail of trails) {
    const suggestions = SUGGESTED_CHECKPOINTS[suggestionKey(trail)];
    if (!suggestions) continue;
    const ref = doc(db, 'trails', trail.id);
    const snap = await getDoc(ref);
    const existing = new Set((Array.isArray(snap.data()?.checkpoints) ? snap.data().checkpoints : [])
      .map((p) => String(p?.name || '').trim().toLowerCase()));
    const points = suggestions
      .filter((s) => !existing.has(s.name.toLowerCase()))
      .map((s) => ({
        id: (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`),
        name: s.name,
        note: `${s.note} (Estimated position.)`,
        lat: s.at[0],
        lng: s.at[1],
        createdAt: new Date().toISOString(),
        suggested: true
      }));
    if (!points.length) continue;
    await updateDoc(ref, { checkpoints: arrayUnion(...points) });
    added += points.length;
    touched += 1;
  }
  return { added, trails: touched };
}

export const POINT_TYPES = {
  checkpoints: { label: 'Checkpoint', icon: 'fa-flag', color: '#2f6b45' },
  campsites: { label: 'Campsite', icon: 'fa-campground', color: '#8a5a1f' }
};

// A tap this close to the selected trail's line is moved onto the line.
const SNAP_METERS = 150;

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

const CSS = `
.tp-pin { display:grid; place-items:center; width:28px; height:28px; border-radius:50% 50% 50% 0;
  transform:rotate(-45deg); border:2px solid #fff; box-shadow:0 2px 6px rgba(0,0,0,.35); }
.tp-pin i { transform:rotate(45deg); color:#fff; font-size:12px; }
.tp-placing, .tp-placing .leaflet-interactive { cursor:crosshair !important; }
.tp-banner { position:absolute; top:10px; left:50%; transform:translateX(-50%); z-index:800;
  display:flex; align-items:center; gap:10px; max-width:calc(100% - 20px); padding:8px 10px 8px 14px;
  border-radius:10px; background:var(--dm-surface,#fff); color:var(--text-primary);
  box-shadow:0 4px 14px rgba(0,0,0,.25); font-size:12.5px; font-weight:600; }
.tp-banner i { color:var(--accent); }
.tp-banner button { border:1px solid var(--border); background:var(--dm-surface-2,#f5f5f2); color:var(--text-primary);
  border-radius:7px; padding:5px 10px; font-size:12px; font-weight:600; }
.tp-popup { min-width:180px; font-size:12.5px; line-height:1.45; }
.tp-popup strong { display:block; font-size:13.5px; }
.tp-popup .tp-type { color:#5b6b60; font-size:11.5px; margin-bottom:4px; }
.tp-popup .tp-note { margin:4px 0 6px; }
.tp-popup .tp-coords { color:#93a199; font-size:11px; }
.tp-popup button { margin-top:8px; border:0; background:#fbe9e7; color:#c8402f; border-radius:6px;
  padding:5px 10px; font-size:12px; font-weight:600; cursor:pointer; }
.tp-modal { display:none; position:fixed; inset:0; z-index:1000; background:rgba(0,0,0,.5);
  align-items:center; justify-content:center; padding:16px; }
.tp-modal.open { display:flex; }
.tp-dialog { width:min(440px,100%); max-height:85vh; overflow-y:auto; padding:24px; border-radius:12px;
  background:var(--dm-surface,#fff); color:var(--text-primary); }
.tp-dialog h3 { display:flex; align-items:center; gap:8px; margin-bottom:4px; font-size:18px; }
.tp-dialog h3 i { color:var(--accent); }
.tp-dialog .tp-sub { margin-bottom:16px; font-size:12.5px; color:var(--text-secondary); }
.tp-dialog label { display:block; margin-bottom:12px; font-size:12px; color:var(--text-secondary); }
.tp-dialog input, .tp-dialog textarea { display:block; width:100%; margin-top:4px; padding:8px;
  border:1px solid var(--border); border-radius:6px; background:var(--dm-surface,#fff); color:var(--text-primary);
  font-family:inherit; font-size:13px; }
.tp-dialog textarea { min-height:64px; line-height:1.5; }
.tp-dialog .tp-where { margin-bottom:14px; padding:8px 10px; border-radius:8px; background:var(--dm-surface-2,#f3f5f2);
  font-size:12px; color:var(--text-secondary); }
.tp-dialog .tp-error { min-height:16px; margin-bottom:8px; font-size:12px; color:var(--danger); }
.tp-dialog .tp-actions { display:flex; gap:10px; }
.tp-dialog .tp-actions button { flex:1; padding:10px; border-radius:8px; font-size:13px; font-weight:600; }
.tp-dialog .tp-cancel { border:1px solid var(--border); background:var(--dm-surface,#fff); color:var(--text-primary); }
.tp-dialog .tp-save { border:0; background:var(--accent); color:#fff; }
.tp-dialog .tp-save[disabled] { opacity:.6; cursor:wait; }
.tp-dialog .tp-list { margin:0 0 14px; padding:0; list-style:none; display:flex; flex-direction:column; gap:10px; }
.tp-dialog .tp-list > li { padding:10px 12px; border-radius:8px; background:var(--dm-surface-2,#f3f5f2); }
.tp-dialog .tp-list strong { display:block; margin-bottom:4px; font-size:13px; color:var(--text-primary); }
.tp-dialog .tp-list ul { margin:0; padding:0; list-style:none; }
.tp-dialog .tp-list ul li { display:flex; align-items:center; gap:7px; padding:2px 0; font-size:12.5px; color:var(--text-secondary); }
.tp-dialog .tp-list ul li i { width:12px; font-size:11px; color:#2f6b45; }
.tp-dialog .tp-list ul li.is-done, .tp-dialog .tp-list ul li.is-done i { color:var(--text-muted); }
.tp-dialog .tp-note-line { margin:-6px 0 14px; font-size:11.5px; color:var(--text-muted); }
.tp-dialog .tp-result { margin:4px 0 16px; padding:12px; border-radius:8px; background:var(--accent-light);
  color:var(--accent-dark); font-size:13px; font-weight:600; }
`;

const MODAL = `
<div class="tp-dialog" role="dialog" aria-modal="true" aria-labelledby="tpTitle">
  <h3 id="tpTitle"><i class="fa-solid" aria-hidden="true"></i><span></span></h3>
  <p class="tp-sub"></p>
  <div class="tp-where"></div>
  <label>Name <input type="text" id="tpName" maxlength="80"></label>
  <label>Notes (optional) <textarea id="tpNote" maxlength="500" placeholder="e.g. water refill, ranger post, space for 10 tents"></textarea></label>
  <div class="tp-error" role="alert"></div>
  <div class="tp-actions">
    <button type="button" class="tp-cancel">Cancel</button>
    <button type="button" class="tp-save">Save</button>
  </div>
</div>`;

// Distance in meters (equirectangular; plenty for a few hundred meters).
function meters(a, b) {
  const k = Math.PI / 180;
  const x = (b.lng - a.lng) * k * Math.cos(((a.lat + b.lat) / 2) * k);
  const y = (b.lat - a.lat) * k;
  return Math.sqrt(x * x + y * y) * 6371000;
}

// The closest point on a polyline to `p`.
function nearestOnLine(latLngs, p) {
  let best = null;
  for (let i = 1; i < latLngs.length; i += 1) {
    const a = latLngs[i - 1];
    const b = latLngs[i];
    const dx = b.lng - a.lng;
    const dy = b.lat - a.lat;
    const t = dx || dy
      ? Math.max(0, Math.min(1, ((p.lng - a.lng) * dx + (p.lat - a.lat) * dy) / (dx * dx + dy * dy)))
      : 0;
    const q = L.latLng(a.lat + t * dy, a.lng + t * dx);
    const d = meters(p, q);
    if (!best || d < best.d) best = { point: q, d };
  }
  return best;
}

/*
  map         the Leaflet map
  db          Firestore
  getSelected () => the selected trails/{id} document data (with id)
  lineFor     (trail) => that trail's Leaflet polyline, or null
  buttons     { checkpoints: <button>, campsites: <button> }
  notify      (message) => void, for "select a trail first" and the like
  readOnly    true to only show the pins (GeoMap): no Remove button, and
              db, getSelected, lineFor, buttons and notify are not needed
  layer       optional layer group to draw the pins in (e.g. one a layers
              control can toggle); made and added to the map if left out
*/
export function initTrailPoints({ map, db, getSelected, lineFor, buttons, notify, readOnly = false, layer: pinLayer }) {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const layer = pinLayer || L.layerGroup().addTo(map);
  const container = map.getContainer();
  let placing = null; // { type, trail }
  let banner = null;
  let pending = null; // { type, trail, latlng, snapped }
  let saving = false;
  let knownTrails = []; // the trails last drawn, for matching a click to a trail line

  if (readOnly) return { render };

  const modal = document.createElement('div');
  modal.className = 'tp-modal';
  modal.innerHTML = MODAL;
  document.body.appendChild(modal);
  const $ = (sel) => modal.querySelector(sel);

  function pinIcon(type) {
    const t = POINT_TYPES[type];
    return L.divIcon({
      className: '',
      html: `<div class="tp-pin" style="background:${t.color}"><i class="fa-solid ${t.icon}" aria-hidden="true"></i></div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 28],
      popupAnchor: [0, -26]
    });
  }

  // Redraws every trail's checkpoints and campsites.
  function render(trails) {
    knownTrails = trails || [];
    layer.clearLayers();
    for (const trail of trails || []) {
      for (const type of Object.keys(POINT_TYPES)) {
        const points = Array.isArray(trail[type]) ? trail[type] : [];
        for (const point of points) {
          const lat = Number(point?.lat);
          const lng = Number(point?.lng);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
          const marker = L.marker([lat, lng], { icon: pinIcon(type), title: point.name || POINT_TYPES[type].label });
          marker.bindPopup(() => {
            const el = document.createElement('div');
            el.className = 'tp-popup';
            el.innerHTML = `
              <strong>${escapeHtml(point.name || POINT_TYPES[type].label)}</strong>
              <div class="tp-type">${POINT_TYPES[type].label} · ${escapeHtml(trail.Trail || 'Trail')}</div>
              ${point.note ? `<div class="tp-note">${escapeHtml(point.note)}</div>` : ''}
              <div class="tp-coords">${lat.toFixed(5)}, ${lng.toFixed(5)}</div>
              ${readOnly ? '' : '<button type="button">Remove</button>'}`;
            el.querySelector('button')?.addEventListener('click', () => removePoint(trail.id, type, point.id, el));
            return el;
          });
          marker.addTo(layer);
        }
      }
    }
  }

  async function removePoint(trailId, type, pointId, popupEl) {
    const label = POINT_TYPES[type].label.toLowerCase();
    if (!window.confirm(`Remove this ${label}?`)) return;
    try {
      // Read the latest list so a point added meanwhile is not lost.
      const ref = doc(db, 'trails', trailId);
      const snap = await getDoc(ref);
      const list = Array.isArray(snap.data()?.[type]) ? snap.data()[type] : [];
      await updateDoc(ref, { [type]: list.filter((p) => p?.id !== pointId) });
      map.closePopup();
    } catch (error) {
      const btn = popupEl.querySelector('button');
      if (btn) btn.textContent = error?.code === 'permission-denied' ? 'Not allowed' : 'Could not remove';
    }
  }

  function stopPlacing() {
    placing = null;
    container.classList.remove('tp-placing');
    banner?.remove();
    banner = null;
  }

  function startPlacing(type) {
    const trail = getSelected();
    if (!trail) {
      notify?.('Select a trail in the Trail List first.');
      return;
    }
    stopPlacing();
    placing = { type, trail };
    container.classList.add('tp-placing');

    banner = document.createElement('div');
    banner.className = 'tp-banner';
    banner.innerHTML = `
      <i class="fa-solid ${POINT_TYPES[type].icon}" aria-hidden="true"></i>
      <span>Click on a trail line to place a ${POINT_TYPES[type].label.toLowerCase()} on that trail, or anywhere else for <strong>${escapeHtml(trail.Trail || 'this trail')}</strong></span>
      <button type="button">Cancel</button>`;
    banner.querySelector('button').addEventListener('click', (e) => { e.stopPropagation(); stopPlacing(); });
    L.DomEvent.disableClickPropagation(banner);
    container.appendChild(banner);

    // Show the trail being added to, so the admin can see where to click.
    const line = lineFor?.(trail);
    if (line) map.fitBounds(line.getBounds(), { padding: [30, 30] });
    container.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  map.on('click', (event) => {
    if (!placing) return;
    const { type } = placing;
    let { trail } = placing;
    let latlng = event.latlng;
    let snapped = false;
    // A click on or near a trail's line puts the point on THAT trail (the
    // closest line within SNAP_METERS wins), moved onto the line; anywhere
    // else it goes on the trail that was selected when placing started.
    let best = null;
    const candidates = knownTrails.some((t) => t.id === trail.id) ? knownTrails : [trail, ...knownTrails];
    for (const candidate of candidates) {
      const line = lineFor?.(candidate);
      if (!line) continue;
      const near = nearestOnLine(line.getLatLngs().flat(), latlng);
      if (near && near.d <= SNAP_METERS && (!best || near.d < best.near.d)) best = { trail: candidate, near };
    }
    if (best) {
      trail = best.trail;
      latlng = best.near.point;
      snapped = true;
    }
    stopPlacing();
    openForm({ type, trail, latlng, snapped });
  });

  function openForm(next) {
    pending = next;
    const t = POINT_TYPES[next.type];
    const existing = Array.isArray(next.trail[next.type]) ? next.trail[next.type].length : 0;
    $('#tpTitle i').className = `fa-solid ${t.icon}`;
    $('#tpTitle span').textContent = `Add ${t.label}`;
    $('.tp-sub').textContent = `On ${next.trail.Trail || 'this trail'}`;
    $('.tp-where').textContent = `${next.latlng.lat.toFixed(5)}, ${next.latlng.lng.toFixed(5)}${next.snapped ? ' · placed on the trail line' : ''}`;
    $('#tpName').value = `${t.label} ${existing + 1}`;
    $('#tpNote').value = '';
    $('.tp-error').textContent = '';
    modal.classList.add('open');
    $('#tpName').focus();
    $('#tpName').select();
  }

  function closeForm() {
    if (saving) return;
    modal.classList.remove('open');
    pending = null;
  }

  async function save() {
    if (!pending || saving) return;
    const name = $('#tpName').value.trim();
    if (!name) {
      $('.tp-error').textContent = 'Give it a name.';
      return;
    }
    const { type, trail, latlng } = pending;
    const point = {
      id: (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`),
      name,
      note: $('#tpNote').value.trim(),
      lat: Number(latlng.lat.toFixed(6)),
      lng: Number(latlng.lng.toFixed(6)),
      // serverTimestamp() is not allowed inside an array element.
      createdAt: new Date().toISOString()
    };
    saving = true;
    $('.tp-save').disabled = true;
    $('.tp-save').textContent = 'Saving…';
    try {
      await updateDoc(doc(db, 'trails', trail.id), { [type]: arrayUnion(point) });
      saving = false;
      closeForm();
      // The trails snapshot redraws the pins.
    } catch (error) {
      saving = false;
      $('.tp-error').textContent = error?.code === 'permission-denied'
        ? 'Firebase denied this. Only admins can add points.'
        : `Could not save: ${error.message || 'Unknown error'}`;
    } finally {
      $('.tp-save').disabled = false;
      $('.tp-save').textContent = 'Save';
    }
  }

  $('.tp-cancel').addEventListener('click', closeForm);
  $('.tp-save').addEventListener('click', save);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeForm(); });
  $('#tpName').addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (modal.classList.contains('open')) closeForm();
    else if (placing) stopPlacing();
  });

  buttons?.checkpoints?.addEventListener('click', () => startPlacing('checkpoints'));
  buttons?.campsites?.addEventListener('click', () => startPlacing('campsites'));

  // Starts adding a point of `type` ('checkpoints' or 'campsites') on the
  // selected trail, the same as clicking its button (trail.html?add=...).
  const start = (type) => startPlacing(type);

  return { render, start };
}
