// trail-fees.js
// Trail Management > Trail Details > Fees & Payments: what a hike on the
// selected trail costs, as a list the admin edits, saved on the trail as
// trails/{id}.Fees, an array of
//   { label, unit, min, max, groupSize, note, inEstimate }
//     unit        'head' | 'group' | 'groupNight' | 'night' | 'flat'
//     min / max   pesos; max empty for a single amount, both empty when the
//                 amount is not published (shown as "Not published")
//     groupSize   for per-group fees: how many hikers one group covers
//                 (a ₱1,200 guide for up to 5), used by the estimate
//     inEstimate  counted in "Estimated cost for N hikers" (off for
//                 discounts and optional extras such as camping)
//
// SUGGESTED holds the published amounts for the three main trails (from the
// admin's fee table), offered in the editor as a starting point.

import { doc, serverTimestamp, updateDoc } from './firestore-tracked.js';
// The one-time fill of the published fees is not an admin's edit, so it goes
// straight to the SDK (it doesn't move Settings > Last Updated).
import { updateDoc as updateDocDirect } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { trailLineKey } from './makiling-area.js';

const UNITS = {
  head: 'per head',
  group: 'per group',
  groupNight: 'per group per night',
  night: 'per night',
  flat: 'flat fee'
};

const SUGGESTED = {
  mariang: [
    { label: 'Entrance fee (regular)', unit: 'head', min: 40, max: null, note: 'Some reports range from ₱10 to ₱60.', inEstimate: true },
    { label: 'Entrance fee (students & seniors)', unit: 'head', min: 30, max: null, note: 'Discounted rate; replaces the regular fee.', inEstimate: false },
    { label: 'Tour guide', unit: 'group', min: 1200, max: null, groupSize: 5, note: 'Per group of up to 5. Mandatory for Peak 2 (summit).', inEstimate: true },
    { label: 'Camping', unit: 'groupNight', min: 500, max: null, note: 'Tayabak (Station 9) and Malaboo (Station 13).', inEstimate: false }
  ],
  sipit: [
    { label: 'Total budget (entrance & fees)', unit: 'head', min: 300, max: 550, note: 'Older data, unconfirmed.', inEstimate: true },
    { label: 'Tour guide', unit: 'group', min: 500, max: 800, note: 'Negotiable (older data).', inEstimate: true },
    { label: 'Camping (Melkas Campsite)', unit: 'groupNight', min: null, max: null, note: 'Fee not published.', inEstimate: false }
  ],
  traverse: [
    { label: 'Sto. Tomas side fees', unit: 'head', min: 300, max: 550, note: 'Same as the Sipit Trail side.', inEstimate: true },
    { label: 'UPLB exit fee', unit: 'head', min: null, max: null, note: 'Amount not published.', inEstimate: false },
    { label: 'Tour guide', unit: 'group', min: 500, max: 800, note: 'Same as the Sto. Tomas side, plus the guide\'s fare back to Sto. Tomas.', inEstimate: true }
  ]
};

const CSS = `
.tf-list { display:flex; flex-direction:column; gap:6px; margin-bottom:10px; }
.tf-row { display:flex; justify-content:space-between; align-items:flex-start; gap:10px; padding:8px 10px;
  border:1px solid var(--border); border-radius:8px; background:var(--dm-surface-2, #fbfcfa); font-size:12.5px; }
.tf-row strong { display:block; font-size:12.5px; color:var(--text-primary); }
.tf-row small { display:block; color:var(--text-secondary); font-size:11px; line-height:1.4; margin-top:2px; }
.tf-amount { text-align:right; white-space:nowrap; font-weight:700; color:var(--accent-dark, #1f6b3a); }
.tf-amount small { font-weight:500; text-align:right; }
.tf-amount.is-none { color:var(--text-muted); font-weight:600; }
.tf-empty { padding:10px; border:1px dashed var(--border); border-radius:8px; font-size:12.5px; color:var(--text-secondary); text-align:center; }
.tf-estimate { display:flex; align-items:center; flex-wrap:wrap; gap:6px 8px; padding:8px 10px; border-radius:8px;
  background:var(--accent-light, #e7f5eb); font-size:12.5px; color:var(--text-primary); margin-bottom:8px; }
.tf-estimate input { width:56px; padding:4px 6px; border:1px solid var(--border); border-radius:6px; font:inherit; }
/* Locked outside edit mode (Edit Trail Information). */
.tf-estimate input:disabled { background:transparent; border-color:transparent; color:var(--text-primary); font-weight:700;
  cursor:not-allowed; -moz-appearance:textfield; appearance:textfield; }
.tf-estimate input:disabled::-webkit-inner-spin-button,
.tf-estimate input:disabled::-webkit-outer-spin-button { -webkit-appearance:none; margin:0; }
.tf-estimate strong { color:var(--accent-dark, #1f6b3a); }
.tf-estimate small { flex-basis:100%; color:var(--text-secondary); font-size:11px; }
.tf-modal { position:fixed; inset:0; z-index:1150; display:none; align-items:center; justify-content:center; padding:16px;
  background:rgba(0,0,0,.5); }
.tf-modal.open { display:flex; }
.tf-card { width:min(760px,100%); max-height:88vh; overflow-y:auto; padding:22px; border-radius:12px;
  background:var(--dm-surface, #fff); color:var(--text-primary); }
.tf-card h3 { margin:0 0 4px; font-size:18px; }
.tf-card > p { margin:0 0 14px; font-size:12.5px; color:var(--text-secondary); line-height:1.5; }
.tf-edit-row { display:grid; grid-template-columns:minmax(0,1.6fr) minmax(0,1fr) 84px 84px 62px 32px; gap:6px; align-items:center;
  padding:8px; border:1px solid var(--border); border-radius:8px; margin-bottom:6px; }
.tf-edit-row input, .tf-edit-row select { width:100%; min-width:0; padding:6px 7px; border:1px solid var(--border); border-radius:6px;
  font:inherit; font-size:12.5px; background:var(--dm-surface-2, #fbfcfa); color:var(--text-primary); box-sizing:border-box; }
.tf-edit-row .tf-note { grid-column:1 / 5; }
.tf-edit-row .tf-in { grid-column:5 / 7; display:flex; align-items:center; gap:5px; font-size:11.5px; color:var(--text-secondary); }
.tf-edit-row .tf-in input { width:auto; }
.tf-remove { width:30px; height:30px; border:0; border-radius:6px; background:none; color:var(--danger, #c8402f); cursor:pointer; }
.tf-remove:hover { background:rgba(200,64,47,.1); }
.tf-head { display:grid; grid-template-columns:minmax(0,1.6fr) minmax(0,1fr) 84px 84px 62px 32px; gap:6px; padding:0 9px 4px;
  font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; color:var(--text-muted); }
.tf-tools { display:flex; flex-wrap:wrap; gap:8px; margin:8px 0 14px; }
.tf-tools button, .tf-actions button { padding:8px 12px; border-radius:8px; font:inherit; font-size:12.5px; font-weight:600; cursor:pointer;
  border:1px solid var(--border); background:var(--dm-surface, #fff); color:var(--text-primary); }
.tf-actions { display:flex; justify-content:flex-end; gap:8px; }
.tf-actions .tf-save { border:0; background:var(--accent, #2f8f4e); color:#fff; }
.tf-actions .tf-save:disabled { opacity:.6; cursor:wait; }
.tf-error { min-height:16px; margin:0 0 8px; font-size:12px; color:var(--danger, #c8402f); }
@media (max-width:640px) {
  .tf-head { display:none; }
  .tf-edit-row { grid-template-columns:1fr 1fr; }
  .tf-edit-row > * { grid-column:auto !important; }
  .tf-edit-row .tf-label, .tf-edit-row .tf-note { grid-column:1 / -1 !important; }
}
`;

const peso = (value) => `₱${Number(value).toLocaleString('en-PH', { maximumFractionDigits: 2 })}`;
const num = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

// "₱40", "₱300 – ₱550", or "Not published".
function amountText(fee) {
  const min = num(fee.min);
  const max = num(fee.max);
  if (min === null && max === null) return 'Not published';
  if (min !== null && max !== null && max > min) return `${peso(min)} – ${peso(max)}`;
  return peso(min ?? max);
}

const cleanFees = (fees) => (Array.isArray(fees) ? fees : []).map((fee) => ({
  label: String(fee?.label || '').trim(),
  unit: UNITS[fee?.unit] ? fee.unit : 'head',
  min: num(fee?.min),
  max: num(fee?.max),
  groupSize: num(fee?.groupSize),
  note: String(fee?.note || '').trim(),
  inEstimate: fee?.inEstimate !== false
})).filter((fee) => fee.label);

/* The cost for `hikers` people: per-head fees times the hikers, per-group
   fees once per group (groupSize hikers each, one group when not set), flat
   fees once. Per-night fees are left out: they depend on the stay. */
function estimate(fees, hikers) {
  let low = 0;
  let high = 0;
  let counted = 0;
  fees.forEach((fee) => {
    if (!fee.inEstimate) return;
    const min = num(fee.min);
    const max = num(fee.max);
    if (min === null && max === null) return;
    let times = 0;
    if (fee.unit === 'head') times = hikers;
    else if (fee.unit === 'group') times = fee.groupSize ? Math.ceil(hikers / fee.groupSize) : 1;
    else if (fee.unit === 'flat') times = 1;
    if (!times) return;
    counted += 1;
    low += (min ?? max) * times;
    high += (max ?? min) * times;
  });
  return { low, high, counted };
}

/* The fees as they are saved: one amount when max equals min, a group size
   only on per-group fees. Shared by Save Fees and the one-time fill below. */
const toSaved = (fee) => ({
  label: fee.label,
  unit: fee.unit,
  min: fee.min,
  max: fee.max !== null && fee.max !== fee.min ? fee.max : null,
  groupSize: fee.unit === 'group' ? fee.groupSize : null,
  note: fee.note,
  inEstimate: fee.inEstimate
});

/* Puts the published fees (SUGGESTED) into Firestore, trails/{id}.Fees, for
   the main trails that have none yet, so the PeakPath app can read them.
   Only a trail with no Fees field at all: one whose fees an admin edited or
   cleared (an empty list) is left as it is. Runs once per page load, from
   Trail Management's trails listener; a Viewer's write is refused quietly
   and the next editor to open the page fills them in. */
let seedTried = false;
export async function seedSuggestedFees(db, trails) {
  if (seedTried || !trails.length) return;
  seedTried = true;
  const missing = trails.filter((trail) => !('Fees' in trail) && SUGGESTED[trailLineKey(trail.Trail)]);
  for (const trail of missing) {
    try {
      await updateDocDirect(doc(db, 'trails', trail.id), {
        Fees: cleanFees(SUGGESTED[trailLineKey(trail.Trail)]).map(toSaved),
        FeesUpdatedAt: serverTimestamp(),
        FeesSource: 'published'
      });
    } catch (error) {
      console.warn(`Could not add the published fees to ${trail.Trail}:`, error.code || error.message);
    }
  }
}

// canEdit: whether the trail is in edit mode (Edit Trail Information); Edit
// Fees only works then.
export function initTrailFees({ db, getSelected, container, editButton, canEdit = () => true, notify = (m) => alert(m) }) {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  let hikers = 5;

  /* ---- Display ---- */
  function render(trail = getSelected()) {
    if (!container) return;
    const fees = cleanFees(trail?.Fees);
    if (editButton) {
      const editable = Boolean(trail) && canEdit();
      editButton.disabled = !editable;
      editButton.style.opacity = editable ? '1' : '0.5';
      editButton.style.cursor = editable ? 'pointer' : 'not-allowed';
      editButton.title = editable ? "Edit this trail's fees" : 'Click "Edit Trail Information" first to edit the fees';
    }
    if (!trail) { container.innerHTML = ''; return; }
    if (!fees.length) {
      container.innerHTML = '<div class="tf-empty">No fees set for this trail yet. Use <strong>Edit Fees</strong> to add the entrance, guide and camping fees.</div>';
      return;
    }
    const { low, high, counted } = estimate(fees, hikers);
    container.innerHTML = `
      <div class="tf-list">${fees.map((fee) => `
        <div class="tf-row">
          <div><strong>${escapeHtml(fee.label)}</strong>${fee.note ? `<small>${escapeHtml(fee.note)}</small>` : ''}</div>
          <div class="tf-amount${num(fee.min) === null && num(fee.max) === null ? ' is-none' : ''}">${escapeHtml(amountText(fee))}
            <small>${escapeHtml(UNITS[fee.unit])}${fee.unit === 'group' && fee.groupSize ? ` (up to ${fee.groupSize})` : ''}</small></div>
        </div>`).join('')}
      </div>
      ${counted ? `<div class="tf-estimate">
        <label>Estimated cost for <input type="number" min="1" max="99" value="${hikers}" class="tf-hikers" aria-label="Number of hikers"${canEdit() ? '' : ' disabled title="Click &quot;Edit Trail Information&quot; first to change the number of hikers"'}> hikers:</label>
        <strong>${low === high ? peso(low) : `${peso(low)} – ${peso(high)}`}</strong>
        <span>(≈ ${low === high ? peso(Math.round(low / hikers)) : `${peso(Math.round(low / hikers))} – ${peso(Math.round(high / hikers))}`} per head)</span>
        <small>Counts the fees marked for the estimate; camping and other per-night fees are extra.</small>
      </div>` : ''}`;
    container.querySelector('.tf-hikers:not(:disabled)')?.addEventListener('change', (event) => {
      const value = Math.round(Number(event.target.value));
      hikers = Number.isFinite(value) && value >= 1 ? Math.min(value, 99) : 5;
      render();
    });
  }

  /* ---- Editor ---- */
  const modal = document.createElement('div');
  modal.className = 'tf-modal';
  modal.innerHTML = `
    <div class="tf-card" role="dialog" aria-modal="true" aria-labelledby="tfFeesTitle">
      <h3 id="tfFeesTitle">Edit Fees</h3>
      <p class="tf-intro"></p>
      <div class="tf-head"><span>Fee</span><span>Charged</span><span>Min ₱</span><span>Max ₱</span><span>Group</span><span></span></div>
      <div class="tf-rows"></div>
      <div class="tf-tools">
        <button type="button" class="tf-add">+ Add fee</button>
        <button type="button" class="tf-suggest">Use suggested fees</button>
      </div>
      <div class="tf-error" role="alert"></div>
      <div class="tf-actions">
        <button type="button" class="tf-cancel">Cancel</button>
        <button type="button" class="tf-save">Save Fees</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const rowsEl = modal.querySelector('.tf-rows');
  const errorEl = modal.querySelector('.tf-error');
  let editing = null;

  const rowHtml = (fee = {}) => `
    <div class="tf-edit-row">
      <input class="tf-label" type="text" maxlength="60" placeholder="e.g. Entrance fee" value="${escapeHtml(fee.label || '')}" aria-label="Fee name">
      <select class="tf-unit" aria-label="Charged">${Object.entries(UNITS).map(([key, label]) => `<option value="${key}"${(fee.unit || 'head') === key ? ' selected' : ''}>${label}</option>`).join('')}</select>
      <input class="tf-min" type="number" min="0" step="1" placeholder="₱" value="${num(fee.min) ?? ''}" aria-label="Minimum amount">
      <input class="tf-max" type="number" min="0" step="1" placeholder="—" value="${num(fee.max) ?? ''}" aria-label="Maximum amount (leave empty for one amount)">
      <input class="tf-group" type="number" min="1" step="1" placeholder="—" value="${num(fee.groupSize) ?? ''}" aria-label="Hikers per group (per-group fees)" title="Hikers per group, for per-group fees">
      <button type="button" class="tf-remove" title="Remove this fee" aria-label="Remove this fee"><i class="fa-regular fa-trash-can" aria-hidden="true"></i></button>
      <input class="tf-note" type="text" maxlength="160" placeholder="Note (optional), e.g. Mandatory for Peak 2" value="${escapeHtml(fee.note || '')}" aria-label="Note">
      <label class="tf-in"><input class="tf-in-box" type="checkbox"${fee.inEstimate === false ? '' : ' checked'}> In estimate</label>
    </div>`;

  const readRows = () => [...rowsEl.querySelectorAll('.tf-edit-row')].map((row) => ({
    label: row.querySelector('.tf-label').value.trim(),
    unit: row.querySelector('.tf-unit').value,
    min: num(row.querySelector('.tf-min').value),
    max: num(row.querySelector('.tf-max').value),
    groupSize: num(row.querySelector('.tf-group').value),
    note: row.querySelector('.tf-note').value.trim(),
    inEstimate: row.querySelector('.tf-in-box').checked
  }));

  const close = () => {
    modal.classList.remove('open');
    editing = null;
  };

  function open() {
    const trail = getSelected();
    if (!trail) { notify('Select a trail in the Trail List first.'); return; }
    if (!canEdit()) return;
    editing = trail;
    const key = trailLineKey(trail.Trail);
    const suggested = SUGGESTED[key];
    modal.querySelector('.tf-intro').textContent = `Fees for ${trail.Trail || 'this trail'}. Enter one amount in Min, or Min and Max for a range; leave both empty when the amount is not published.`;
    modal.querySelector('.tf-suggest').hidden = !suggested;
    modal.querySelector('.tf-suggest').title = suggested ? 'Fill in the published fees for this trail' : '';
    const fees = cleanFees(trail.Fees);
    rowsEl.innerHTML = (fees.length ? fees : [{}]).map(rowHtml).join('');
    errorEl.textContent = '';
    modal.classList.add('open');
    rowsEl.querySelector('.tf-label')?.focus();
  }

  rowsEl.addEventListener('click', (event) => {
    const remove = event.target.closest('.tf-remove');
    if (remove) remove.closest('.tf-edit-row').remove();
  });
  modal.querySelector('.tf-add').addEventListener('click', () => {
    rowsEl.insertAdjacentHTML('beforeend', rowHtml());
    rowsEl.lastElementChild.querySelector('.tf-label').focus();
  });
  modal.querySelector('.tf-suggest').addEventListener('click', () => {
    const suggested = SUGGESTED[trailLineKey(editing?.Trail)];
    if (!suggested) return;
    rowsEl.innerHTML = suggested.map(rowHtml).join('');
  });
  modal.querySelector('.tf-cancel').addEventListener('click', close);
  modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modal.classList.contains('open')) close();
  });

  modal.querySelector('.tf-save').addEventListener('click', async () => {
    if (!editing) return;
    const rows = readRows().filter((fee) => fee.label || fee.min !== null || fee.max !== null || fee.note);
    const unnamed = rows.find((fee) => !fee.label);
    if (unnamed) { errorEl.textContent = 'Give every fee a name, or remove the empty row.'; return; }
    const reversed = rows.find((fee) => fee.min !== null && fee.max !== null && fee.max < fee.min);
    if (reversed) { errorEl.textContent = `${reversed.label}: the maximum is lower than the minimum.`; return; }
    const fees = rows.map(toSaved);
    const save = modal.querySelector('.tf-save');
    const name = editing.Trail || 'the trail';
    save.disabled = true;
    errorEl.textContent = '';
    try {
      await updateDoc(doc(db, 'trails', editing.id), {
        Fees: fees,
        FeesUpdatedAt: serverTimestamp(),
        UpdatedAt: serverTimestamp()
      });
      close();
      notify(`Fees saved for ${name}.`);
    } catch (error) {
      console.error('Could not save the fees:', error);
      errorEl.textContent = error?.code === 'permission-denied'
        ? 'Only admins (not Viewers) can change a trail\'s fees.'
        : 'The fees could not be saved. Try again.';
    } finally {
      save.disabled = false;
    }
  });

  editButton?.addEventListener('click', open);
  return { render };
}
