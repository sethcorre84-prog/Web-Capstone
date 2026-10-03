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
      <span>Click on the map to place a ${POINT_TYPES[type].label.toLowerCase()} on <strong>${escapeHtml(trail.Trail || 'this trail')}</strong></span>
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
    const { type, trail } = placing;
    let latlng = event.latlng;
    let snapped = false;
    const line = lineFor?.(trail);
    if (line) {
      const near = nearestOnLine(line.getLatLngs().flat(), latlng);
      if (near && near.d <= SNAP_METERS) {
        latlng = near.point;
        snapped = true;
      }
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
