// trail-station-editor.js
// The Trail Station Management panel on Trail Management (trail.html): edit,
// add and delete the saved stations of the selected trail, the documents in
// the Firestore "stations" collection that the Trail Stations panel
// (trail-stations.js) and the mobile app show.
//
// Each station is stations/{trailID}_station_{NN} with
//   trailID, stationNumber, name ("Station 11 · Agila Base"), landmark,
//   description, tags, section, status ("open" / "closed"), lat, lng,
//   coordsEstimated (true while lat/lng are the estimates from
//   STATION_COORDS rather than a GPS reading), createdAt, updatedAt
// The station number is part of the document id, so it is fixed once a
// station exists; to renumber, delete the station and add it again.
// Only admins can write stations (firestore.rules).

import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { REFERENCE_STATIONS, STATION_COORDS, TAGS, referenceKeyFor } from "./trail-stations.js";

const CSS = `
.se-field { display:block; margin-bottom:10px; font-size:12px; color:var(--text-secondary); }
.se-field input, .se-field select, .se-field textarea { display:block; width:100%; margin-top:4px; padding:8px 10px;
  border:1px solid var(--border); border-radius:8px; background:var(--dm-surface,#fff); color:var(--text-primary);
  font-family:inherit; font-size:13px; }
.se-field input:focus, .se-field select:focus, .se-field textarea:focus { outline:none; border-color:var(--accent);
  box-shadow:0 0 0 3px var(--accent-light); }
.se-field input[readonly] { background:var(--dm-surface-2,#f5f8f3); color:var(--text-secondary); }
.se-field textarea { min-height:78px; line-height:1.5; resize:vertical; }
.se-hint { display:block; margin-top:3px; font-size:11px; color:var(--text-muted); }
.se-row { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
.se-tags { display:flex; flex-wrap:wrap; gap:6px; margin:4px 0 12px; }
.se-tag { display:inline-flex; align-items:center; gap:5px; padding:4px 9px; border:1px solid var(--border);
  border-radius:20px; background:var(--dm-surface,#fff); font-size:11.5px; font-weight:600; color:var(--text-secondary);
  cursor:pointer; user-select:none; }
.se-tag input { position:absolute; opacity:0; pointer-events:none; }
.se-tag i { color:var(--text-muted); }
.se-tag.is-on { border-color:var(--accent); background:var(--accent-light); color:var(--accent-dark); }
.se-tag.is-on i { color:var(--accent); }
.se-tag:focus-within { box-shadow:0 0 0 3px var(--accent-light); }
.se-actions { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:8px; }
.se-actions .btn-secondary { margin:0; }
.se-delete { color:var(--danger) !important; }
.se-delete:hover { border-color:var(--danger) !important; background:var(--danger-light,#fbe9e7) !important; }
.se-msg { min-height:16px; margin:6px 0 2px; font-size:12px; }
.se-msg.is-error { color:var(--danger); }
.se-msg.is-ok { color:var(--accent-dark); }
.se-empty { padding:12px; border:1px dashed var(--border); border-radius:10px; margin-bottom:10px;
  font-size:12.5px; line-height:1.5; color:var(--text-secondary); }
.se-sub { margin:-4px 0 12px; font-size:12px; color:var(--text-secondary); }
.se-fill { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap;
  margin-bottom:12px; padding:9px 12px; border-radius:10px; background:var(--dm-surface-2,#f5f8f3);
  font-size:12px; color:var(--text-secondary); }
.se-fill button { border:1px solid var(--accent); background:var(--dm-surface,#fff); color:var(--accent-dark);
  border-radius:7px; padding:5px 10px; font-size:12px; font-weight:600; }
[data-se][disabled] { opacity:.6; cursor:wait; }
/* Confirmation popups (unsaved changes, delete), styled like the page's
   Add Checkpoint popup. */
.se-modal { position:fixed; inset:0; z-index:1100; display:flex; align-items:center; justify-content:center;
  padding:16px; background:rgba(0,0,0,.5); }
.se-dialog { width:min(400px,100%); padding:24px; border-radius:12px; background:var(--dm-surface,#fff);
  color:var(--text-primary); box-shadow:0 18px 40px rgba(0,0,0,.25); }
.se-dialog h3 { display:flex; align-items:center; gap:10px; margin:0 0 8px; font-size:17px; }
.se-dialog h3 i { display:grid; place-items:center; width:34px; height:34px; border-radius:50%;
  background:#fdf3e1; color:#b9791b; font-size:15px; }
.se-dialog.is-danger h3 i { background:var(--danger-light,#fbe9e7); color:var(--danger,#c8402f); }
.se-dialog p { margin:0 0 20px; font-size:13px; line-height:1.5; color:var(--text-secondary); }
.se-dialog .se-dialog-actions { display:flex; gap:10px; }
.se-dialog .se-dialog-actions button { flex:1; padding:10px; border-radius:8px; font:inherit; font-size:13px; font-weight:600; cursor:pointer; }
.se-dialog .se-keep { border:1px solid var(--border); background:var(--dm-surface,#fff); color:var(--text-primary); }
.se-dialog .se-go { border:0; background:var(--accent); color:#fff; }
.se-dialog.is-danger .se-go { background:var(--danger,#c8402f); }
`;

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

const stationName = (number, landmark) => landmark ? `Station ${number} · ${landmark}` : `Station ${number}`;
const stationId = (trailID, number) => `${trailID}_station_${String(number).padStart(2, '0')}`;
const isOpen = (status) => !String(status ?? 'open').toLowerCase().startsWith('close');

// A stored station document -> what the form edits.
function fromStored(d) {
  const data = d.data();
  const number = Number(data.stationNumber) || Number(String(data.name || '').match(/\d+/)?.[0]) || 0;
  return {
    id: d.id,
    trailID: data.trailID || data.TrailID || data.trailId,
    number,
    landmark: data.landmark || String(data.name || '').replace(/^station\s*\d+\s*[·:-]?\s*/i, ''),
    description: data.description || '',
    section: data.section || '',
    tags: Array.isArray(data.tags) ? data.tags : [],
    open: isOpen(data.status),
    lat: typeof data.lat === 'number' ? data.lat : null,
    lng: typeof data.lng === 'number' ? data.lng : null,
    coordsEstimated: data.coordsEstimated === true
  };
}

/* A confirmation popup; resolves true for the main button, false for the
   other one, a click outside or Escape. */
function askDialog({ icon, title, text, confirmLabel, cancelLabel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.className = 'se-modal';
    modal.innerHTML = `
      <div class="se-dialog${danger ? ' is-danger' : ''}" role="alertdialog" aria-modal="true" aria-labelledby="seDialogTitle" aria-describedby="seDialogText">
        <h3 id="seDialogTitle"><i class="fa-solid ${icon}" aria-hidden="true"></i>${escapeHtml(title)}</h3>
        <p id="seDialogText">${escapeHtml(text)}</p>
        <div class="se-dialog-actions">
          <button type="button" class="se-keep">${escapeHtml(cancelLabel)}</button>
          <button type="button" class="se-go">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    const finish = (answer) => {
      modal.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(answer);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        finish(false);
      }
    };
    modal.addEventListener('click', (event) => { if (event.target === modal) finish(false); });
    modal.querySelector('.se-keep').addEventListener('click', () => finish(false));
    modal.querySelector('.se-go').addEventListener('click', () => finish(true));
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(modal);
    // The safe choice has the focus, so Enter keeps the edits.
    modal.querySelector('.se-keep').focus();
  });
}

// Coordinates as typed: a number, or null when the field is empty.
const coordValue = (text) => (String(text).trim() === '' ? null : Number(text));

/*
  db     Firestore
  root   the element the panel draws into
  Returns { update(selectedTrail), select(stationNumber) }.
*/
export function initStationEditor({ db, root }) {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  let all = [];
  let loaded = false;
  let trail = null;
  let activeNumber = null;
  let adding = false;
  let dirty = false; // unsaved edits in the form: snapshots don't redraw over them
  let busy = false;
  let message = null; // { text, error }

  onSnapshot(collection(db, 'stations'), (snapshot) => {
    all = snapshot.docs.map(fromStored).filter((s) => s.trailID);
    loaded = true;
    if (!dirty) draw();
  }, (error) => {
    console.warn('Could not load stations:', error.message);
    loaded = true;
    draw();
  });

  const stations = () => (trail ? all.filter((s) => s.trailID === trail.id).sort((a, b) => a.number - b.number) : []);

  // Section names to suggest: the reference list's and any already in use.
  function sectionOptions(list) {
    const name = String(trail?.Trail || '').toLowerCase();
    const key = name.includes('sipit') ? 'sipit'
      : (name.includes('mariang makiling') || name.includes('maria makiling')) ? 'mariang' : null;
    const names = new Set((key ? REFERENCE_STATIONS[key].sections : []).map((s) => s.label));
    list.forEach((s) => s.section && names.add(s.section));
    return [...names];
  }

  function tagsHtml(selected) {
    return Object.entries(TAGS).map(([key, tag]) => `
      <label class="se-tag${selected.includes(key) ? ' is-on' : ''}">
        <input type="checkbox" name="seTag" value="${key}"${selected.includes(key) ? ' checked' : ''}>
        <i class="fa-solid ${tag.icon}" aria-hidden="true"></i>${tag.label}
      </label>`).join('');
  }

  function formHtml(station, list) {
    const sections = sectionOptions(list);
    const nextNumber = (list[list.length - 1]?.number || 0) + 1;
    return `
      <div class="se-row">
        <label class="se-field">Station Number
          <input type="number" id="seNumber" min="1" step="1" value="${adding ? nextNumber : station.number}"${adding ? '' : ' readonly'}>
          ${adding ? '' : '<span class="se-hint">Fixed once saved</span>'}
        </label>
        <label class="se-field">Status
          <select id="seStatus">
            <option value="open"${station.open ? ' selected' : ''}>Open</option>
            <option value="closed"${station.open ? '' : ' selected'}>Closed</option>
          </select>
        </label>
      </div>
      <label class="se-field">Landmark
        <input type="text" id="seLandmark" maxlength="80" value="${escapeHtml(station.landmark)}" placeholder="e.g. Agila Base">
        <span class="se-hint">Leave blank for a plain numbered marker.</span>
      </label>
      <label class="se-field">Section
        <input type="text" id="seSection" maxlength="60" list="seSections" value="${escapeHtml(station.section)}" placeholder="e.g. Forest trail">
        <datalist id="seSections">${sections.map((s) => `<option value="${escapeHtml(s)}">`).join('')}</datalist>
      </label>
      <div class="se-row">
        <label class="se-field">Latitude
          <input type="number" id="seLat" step="any" min="-90" max="90" value="${station.lat ?? ''}" placeholder="e.g. 14.13279">
        </label>
        <label class="se-field">Longitude
          <input type="number" id="seLng" step="any" min="-180" max="180" value="${station.lng ?? ''}" placeholder="e.g. 121.20849">
        </label>
      </div>
      ${station.coordsEstimated ? '<span class="se-hint" style="margin:-6px 0 10px">Estimated from the trail line. Replace with a GPS reading taken at the marker.</span>' : ''}
      <label class="se-field">Description
        <textarea id="seDescription" maxlength="1000" placeholder="What hikers find at this station">${escapeHtml(station.description)}</textarea>
      </label>
      <div class="se-field" style="margin-bottom:0">Tags</div>
      <div class="se-tags">${tagsHtml(station.tags)}</div>
      <div class="se-msg${message?.error ? ' is-error' : ' is-ok'}" role="status">${escapeHtml(message?.text || '')}</div>
      ${adding ? `
        <button type="button" class="btn-primary" data-se="create"${busy ? ' disabled' : ''}>
          <i class="fa-solid fa-plus" aria-hidden="true"></i>${busy ? 'Adding…' : 'Add Station'}
        </button>
        <div class="se-actions" style="grid-template-columns:1fr">
          <button type="button" class="btn-secondary" data-se="cancel">Cancel</button>
        </div>` : `
        <button type="button" class="btn-primary" data-se="save"${busy ? ' disabled' : ''}>
          <i class="fa-solid fa-floppy-disk" aria-hidden="true"></i>${busy ? 'Saving…' : 'Save Changes'}
        </button>
        <div class="se-actions">
          <button type="button" class="btn-secondary" data-se="add">+ Add Station</button>
          <button type="button" class="btn-secondary se-delete" data-se="delete"${busy ? ' disabled' : ''}>
            <i class="fa-solid fa-trash" aria-hidden="true"></i> Delete
          </button>
        </div>`}`;
  }

  function draw() {
    if (!root) return;
    dirty = false;
    if (!loaded) {
      root.innerHTML = '<div class="se-empty">Loading stations…</div>';
      return;
    }
    if (!trail) {
      root.innerHTML = '<div class="se-empty">Select a trail to manage its stations.</div>';
      return;
    }

    const list = stations();
    const blank = { number: 0, landmark: '', description: '', section: '', tags: [], open: true, lat: null, lng: null, coordsEstimated: false };

    if (!list.length && !adding) {
      root.innerHTML = `
        <div class="se-empty">
          <strong>${escapeHtml(trail.Trail || 'This trail')}</strong> has no saved stations yet.
          If the Trail Stations panel shows reference data for it, save that first to edit it here.
          Or add stations one by one.
        </div>
        <button type="button" class="btn-primary" data-se="add">+ Add Station</button>`;
      return;
    }

    if (!list.some((s) => s.number === activeNumber)) activeNumber = list[0]?.number ?? null;
    const station = adding ? blank : list.find((s) => s.number === activeNumber);

    root.innerHTML = `
      <p class="se-sub">${escapeHtml(trail.Trail || 'Untitled Trail')} · ${list.length} station${list.length === 1 ? '' : 's'}</p>
      ${fillableCount(list) && !adding ? `
        <div class="se-fill">
          <span>${fillableCount(list)} station${fillableCount(list) === 1 ? ' has' : 's have'} no coordinates.</span>
          <button type="button" data-se="fill"${busy ? ' disabled' : ''}>Add estimated coordinates</button>
        </div>` : ''}
      ${adding ? '<div class="se-field" style="font-weight:600;color:var(--text-primary)">New station</div>' : `
        <label class="se-field">Station
          <select id="seStation">
            ${list.map((s) => `<option value="${s.number}"${s.number === activeNumber ? ' selected' : ''}>${escapeHtml(stationName(s.number, s.landmark))}${s.open ? '' : ' (Closed)'}</option>`).join('')}
          </select>
        </label>`}
      ${formHtml(station, list)}`;
  }

  // Saved stations of this trail with no coordinates that STATION_COORDS has.
  function fillable(list) {
    const coords = STATION_COORDS[referenceKeyFor(trail)];
    if (!coords) return [];
    return list.filter((s) => (s.lat === null || s.lng === null) && coords[s.number]);
  }
  const fillableCount = (list) => fillable(list).length;

  async function fillCoordinates() {
    const targets = fillable(stations());
    if (!targets.length) return;
    const coords = STATION_COORDS[referenceKeyFor(trail)];
    await run(async () => {
      try {
        const batch = writeBatch(db);
        targets.forEach((s) => {
          const [lat, lng] = coords[s.number];
          batch.update(doc(db, 'stations', s.id), { lat, lng, coordsEstimated: true, updatedAt: serverTimestamp() });
        });
        await batch.commit();
      } catch (error) {
        error.userMessage = denied(error, 'update');
        throw error;
      }
    }, `Added estimated coordinates to ${targets.length} station${targets.length === 1 ? '' : 's'}.`);
  }

  // The form's coordinates, or an error message when they are not valid.
  function readCoords() {
    const lat = coordValue(root.querySelector('#seLat').value);
    const lng = coordValue(root.querySelector('#seLng').value);
    if ((lat === null) !== (lng === null)) return { error: 'Enter both latitude and longitude, or leave both empty.' };
    if (lat !== null && (!Number.isFinite(lat) || lat < -90 || lat > 90)) return { error: 'Latitude must be between -90 and 90.' };
    if (lng !== null && (!Number.isFinite(lng) || lng < -180 || lng > 180)) return { error: 'Longitude must be between -180 and 180.' };
    return { lat, lng };
  }

  // The form's values, as the fields saved on the station document.
  function readForm(number) {
    const landmark = root.querySelector('#seLandmark').value.trim();
    const current = stations().find((s) => s.number === number);
    const { lat, lng } = readCoords();
    // Still the estimate only while the admin left it exactly as it was.
    const coordsEstimated = Boolean(current?.coordsEstimated && lat === current.lat && lng === current.lng);
    // Keep any tags this form doesn't know, so editing never drops them,
    // except retired ones ("hazard" was removed), which a save clears.
    const RETIRED_TAGS = ['hazard'];
    const unknownTags = (current?.tags || []).filter((t) => !TAGS[t] && !RETIRED_TAGS.includes(t));
    return {
      stationNumber: number,
      name: stationName(number, landmark),
      landmark,
      section: root.querySelector('#seSection').value.trim(),
      description: root.querySelector('#seDescription').value.trim(),
      tags: [...[...root.querySelectorAll('input[name="seTag"]:checked')].map((i) => i.value), ...unknownTags],
      status: root.querySelector('#seStatus').value,
      lat,
      lng,
      coordsEstimated,
      updatedAt: serverTimestamp()
    };
  }

  // Shows a form error without redrawing over what the admin typed.
  function formError(text) {
    message = { text, error: true };
    const el = root.querySelector('.se-msg');
    if (el) {
      el.textContent = text;
      el.className = 'se-msg is-error';
    }
  }

  function denied(error, action) {
    return error?.code === 'permission-denied'
      ? `Firebase denied this. Only admins can ${action} stations.`
      : `Could not ${action} the station: ${error?.message || 'Unknown error'}`;
  }

  async function run(task, success) {
    busy = true;
    message = null;
    draw();
    try {
      await task();
      message = { text: success };
    } catch (error) {
      message = { text: error.userMessage || error.message, error: true };
    }
    busy = false;
    draw();
  }

  async function save() {
    const station = stations().find((s) => s.number === activeNumber);
    if (!station) return;
    const coordsCheck = readCoords();
    if (coordsCheck.error) return formError(coordsCheck.error);
    const data = readForm(station.number);
    await run(async () => {
      try {
        await updateDoc(doc(db, 'stations', station.id), data);
      } catch (error) {
        error.userMessage = denied(error, 'save');
        throw error;
      }
    }, `Station ${station.number} saved.`);
  }

  async function create() {
    const number = Number(root.querySelector('#seNumber').value);
    if (!Number.isInteger(number) || number < 1) {
      message = { text: 'Enter a station number of 1 or more.', error: true };
      draw();
      return;
    }
    if (stations().some((s) => s.number === number)) {
      message = { text: `Station ${number} already exists. Pick it from the list to edit it.`, error: true };
      draw();
      return;
    }
    const coordsCheck = readCoords();
    if (coordsCheck.error) return formError(coordsCheck.error);
    const data = readForm(number);
    const trailID = trail.id;
    await run(async () => {
      try {
        await setDoc(doc(db, 'stations', stationId(trailID, number)), {
          ...data,
          trailID,
          createdAt: serverTimestamp()
        });
      } catch (error) {
        error.userMessage = denied(error, 'add');
        throw error;
      }
      adding = false;
      activeNumber = number;
    }, `Station ${number} added.`);
  }

  async function remove() {
    const station = stations().find((s) => s.number === activeNumber);
    if (!station) return;
    const sure = await askDialog({
      icon: 'fa-trash',
      title: `Delete ${stationName(station.number, station.landmark)}?`,
      text: 'Hikers will no longer see this station in the app. This cannot be undone.',
      confirmLabel: 'Delete Station',
      danger: true
    });
    if (!sure) return;
    await run(async () => {
      try {
        await deleteDoc(doc(db, 'stations', station.id));
      } catch (error) {
        error.userMessage = denied(error, 'delete');
        throw error;
      }
      activeNumber = null;
    }, `Station ${station.number} deleted.`);
  }

  /* Unsaved edits are only thrown away after the admin says so. Resolves
     true when there is nothing to lose or they chose to discard. */
  function confirmDiscard() {
    if (!dirty) return Promise.resolve(true);
    return askDialog({
      icon: 'fa-triangle-exclamation',
      title: 'Discard unsaved changes?',
      text: `You have changes to ${adding ? 'the new station' : `Station ${activeNumber}`} that are not saved yet. Discard them, or keep editing and press Save Changes.`,
      confirmLabel: 'Discard Changes',
      cancelLabel: 'Keep Editing'
    });
  }

  root?.addEventListener('change', async (event) => {
    if (event.target.id === 'seStation') {
      const picked = Number(event.target.value);
      if (!(await confirmDiscard())) {
        event.target.value = String(activeNumber); // stay on the station being edited
        return;
      }
      activeNumber = picked;
      message = null;
      draw();
      return;
    }
    if (event.target.name === 'seTag') {
      event.target.closest('.se-tag')?.classList.toggle('is-on', event.target.checked);
    }
    dirty = true;
  });
  root?.addEventListener('input', (event) => {
    if (event.target.id !== 'seStation') dirty = true;
  });

  root?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-se]');
    if (!button || busy) return;
    const action = button.dataset.se;
    if (action === 'save') save();
    if (action === 'create') create();
    if (action === 'delete') remove();
    if (action === 'fill') fillCoordinates();
    if (action === 'add' || action === 'cancel') {
      confirmDiscard().then((discard) => {
        if (!discard) return;
        adding = action === 'add';
        message = null;
        draw();
      });
    }
  });

  return {
    // Called by trail.html whenever the selection changes.
    update(selectedTrail) {
      if (selectedTrail?.id === trail?.id) return;
      trail = selectedTrail || null;
      activeNumber = null;
      adding = false;
      message = null;
      draw();
    },
    // Opens a station in the form, e.g. when it is clicked in the Trail Stations panel.
    async select(number) {
      if (busy || !stations().some((s) => s.number === number)) return;
      if (number === activeNumber && !adding) return;
      if (!(await confirmDiscard())) return;
      activeNumber = number;
      adding = false;
      message = null;
      draw();
    }
  };
}
