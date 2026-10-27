// trail-fees.js
// Trail Management > Trail Details > Fees & Payments: what a hike on the
// selected trail costs, as a list the admin edits, saved on the trail as
// trails/{id}.Fees, an array of
//   { label, unit, min, max, groupSize, extraPerHead, rates, note, inEstimate }
//     unit        'head' | 'group' | 'groupNight' | 'night' | 'flat'
//     min / max   pesos; max empty for a single amount, both empty when the
//                 amount is not published (shown as "Not published")
//     groupSize   for per-group fees: how many hikers one group covers
//                 (a ₱1,500 guide for up to 5), used by the estimate
//     extraPerHead  for per-group fees: pesos for each hiker past
//                 groupSize, instead of another whole group (the guide:
//                 ₱1,500 for up to 5, then ₱300 per extra hiker, so 6
//                 hikers pay ₱1,800)
//     rates       for per-group fees: a rate table, [{ guides, from, to,
//                 amount }], each row added once the group reaches `from`
//                 hikers (the Sipit Trail's guide & entrance rates: ₱1,700
//                 for 1-5, +₱340 for the 6th and 7th, +₱1,700 for 8-10 with
//                 a 2nd guide...). Past the last row it repeats the 2nd
//                 guide's rows, one more guide each time.
//     inEstimate  counted in "Estimated cost for N hikers" (off for
//                 discounts and optional extras such as camping)
//
// SUGGESTED holds suggested fees for every trail (suggestedKeyFor): the
// main trails, the Mud Spring and Flat Rocks side trips, the Makiling Botanic
// Gardens, and the standard Mount Makiling Forest Reserve rates for any
// other trail.

import { doc, serverTimestamp, updateDoc } from './firestore-tracked.js';
// The one-time fill of the published fees is not an admin's edit, so it goes
// straight to the SDK (it doesn't move Settings > Last Updated).
import { deleteField, updateDoc as updateDocDirect } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { trailLineKey } from './makiling-area.js';

const UNITS = {
  head: 'per head',
  group: 'per group',
  groupNight: 'per group per night',
  night: 'per night',
  flat: 'flat fee'
};

// The guide, on every trail: ₱1,500 for a group of up to 5 hikers, and ₱300
// for each hiker after that (on top of each hiker's entrance fee).
const GUIDE_NOTE = '₱1,500 for up to 5 hikers, plus ₱300 for each hiker after the 5th.';
const GUIDE_FEE = { label: 'Tour guide', unit: 'group', min: 1500, max: null, groupSize: 5, extraPerHead: 300, inEstimate: true };

// Registration at Station 1 (UPLB) and the mandatory guide: what every trail
// starting on the UPLB side shares.
const STATION1_FEES = (where) => [
  { label: 'Entrance fee (regular)', unit: 'head', min: 40, max: null, note: `${where} Field reports, 2025–2026; the last official MCME notice (2019) lists ₱25. Confirm at Station 1.`, inEstimate: true },
  { label: 'Entrance fee (students, seniors & PWD)', unit: 'head', min: 30, max: null, note: 'Discounted rate with a valid ID; replaces the regular fee.', inEstimate: false },
  { ...GUIDE_FEE, note: `Mandatory (UPLB MCME). ${GUIDE_NOTE}` }
];

// The Sipit Trail's group rates (guide and entrance together), as the
// admin gave them: guides, the hikers the row covers, and what it adds.
const SIPIT_RATES = [
  { guides: 1, from: 1, to: 5, amount: 1700 },
  { guides: 1, from: 6, to: 6, amount: 340 },
  { guides: 1, from: 7, to: 7, amount: 340 },
  { guides: 2, from: 8, to: 10, amount: 1700 },
  { guides: 2, from: 11, to: 11, amount: 340 },
  { guides: 2, from: 12, to: 12, amount: 340 },
  { guides: 3, from: 13, to: 15, amount: 1700 },
  { guides: 3, from: 16, to: 16, amount: 340 },
  { guides: 3, from: 17, to: 17, amount: 340 },
  { guides: 4, from: 18, to: 20, amount: 1700 },
  { guides: 4, from: 21, to: 21, amount: 340 },
  { guides: 4, from: 22, to: 22, amount: 340 },
  { guides: 5, from: 23, to: 25, amount: 1700 }
];

// The Makiling Traverse's guide, on the Sipit Trail's steps (₱2,000 for
// 1-5 hikers, +₱400 for the 6th and 7th, +₱2,000 for 8-10 with a 2nd
// guide...). Guide only: the entrance and exit fees are per head on top.
const TRAVERSE_GUIDE_RATES = SIPIT_RATES.map((row) => ({ ...row, amount: row.amount === 1700 ? 2000 : 400 }));

const SUGGESTED = {
  mudspring: STATION1_FEES('Side trip of the Mariang Makiling Trail (Station 8); registered at Station 1.'),
  flatrocks: STATION1_FEES('Side trip of the Mariang Makiling Trail near the trailhead; registered at Station 1.'),
  botanic: [
    { label: 'Entrance fee (regular)', unit: 'head', min: 50, max: 60, note: 'Makiling Botanic Gardens: ₱50 in the last official MCME notice (2019); ₱60 reported by visitors in 2025.', inEstimate: true },
    { label: 'Entrance fee (students, seniors & PWD)', unit: 'head', min: 40, max: 45, note: 'Discounted rate with a valid ID; replaces the regular fee.', inEstimate: false }
  ],
  standard: STATION1_FEES('Standard Mount Makiling Forest Reserve rates (UPLB MCME); confirm the rate for this trail.'),
  mariang: [
    { label: 'Entrance fee (regular)', unit: 'head', min: 40, max: null, note: 'Some reports range from ₱10 to ₱60.', inEstimate: true },
    { label: 'Entrance fee (students & seniors)', unit: 'head', min: 30, max: null, note: 'Discounted rate; replaces the regular fee.', inEstimate: false },
    { ...GUIDE_FEE, note: `Mandatory for Peak 2 (summit). ${GUIDE_NOTE}` },
    { label: 'Camping', unit: 'groupNight', min: 500, max: null, note: 'Tayabak (Station 9) and Malaboo (Station 13).', inEstimate: false }
  ],
  sipit: [
    { label: 'Guide & entrance (group rate)', unit: 'group', min: 1700, max: null, rates: SIPIT_RATES,
      note: 'Covers the guide and each hiker\'s entrance fee: ₱1,700 for up to 5 hikers, ₱340 for each of the next 2, then another guide (₱1,700 for the next 3 hikers, ₱340 each for 2 more), and so on.',
      inEstimate: true },
    { label: 'Entrance fee', unit: 'head', min: 40, max: null, note: 'Included in the group rate above.', inEstimate: false },
    { label: 'Camping (Melkas Campsite)', unit: 'groupNight', min: null, max: null, note: 'Fee not published.', inEstimate: false }
  ],
  traverse: [
    { label: 'Tour guide (group rate)', unit: 'group', min: 2000, max: null, rates: TRAVERSE_GUIDE_RATES,
      note: 'Same steps as the Sipit Trail: ₱2,000 for up to 5 hikers, ₱400 for each of the next 2, then another guide (₱2,000 for the next 3 hikers, ₱400 each for 2 more), and so on. Entrance and exit fees are on top.',
      inEstimate: true },
    { label: 'Sto. Tomas side entrance fee', unit: 'head', min: 40, max: null, note: 'Paid at the Sto. Tomas jump-off. Subject to change.', inEstimate: true },
    { label: 'UPLB exit fee', unit: 'head', min: 30, max: null, note: 'Paid at the UPLB exit. Subject to change.', inEstimate: true },
    { label: 'Entrance fee (students, PWD & seniors)', unit: 'head', min: 32, max: null, note: '20% off with a valid ID; replaces the regular entrance fee.', inEstimate: false },
    { label: 'UPLB exit fee (students, PWD & seniors)', unit: 'head', min: 24, max: null, note: '20% off with a valid ID; replaces the regular exit fee.', inEstimate: false }
  ]
};

/* Published fees that SUGGESTED has since replaced. A trail still holding one
   of these sets exactly (filled in by an earlier seedSuggestedFees and not
   edited since) is given the current ones. */
const OLD_STATION1 = (where) => [
  { label: 'Entrance fee (regular)', unit: 'head', min: 40, max: null, note: `${where} Field reports, 2025–2026; the last official MCME notice (2019) lists ₱25. Confirm at Station 1.`, inEstimate: true },
  { label: 'Entrance fee (students, seniors & PWD)', unit: 'head', min: 30, max: null, note: 'Discounted rate with a valid ID; replaces the regular fee.', inEstimate: false },
  { label: 'Tour guide', unit: 'group', min: 1200, max: null, groupSize: 5, note: 'Mandatory (UPLB MCME): one guide per group of up to 5.', inEstimate: true }
];
const REPLACED = {
  mudspring: [OLD_STATION1('Side trip of the Mariang Makiling Trail (Station 8); registered at Station 1.')],
  flatrocks: [OLD_STATION1('Side trip of the Mariang Makiling Trail near the trailhead; registered at Station 1.')],
  standard: [OLD_STATION1('Standard Mount Makiling Forest Reserve rates (UPLB MCME); confirm the rate for this trail.')],
  mariang: [[
    { label: 'Entrance fee (regular)', unit: 'head', min: 40, max: null, note: 'Some reports range from ₱10 to ₱60.', inEstimate: true },
    { label: 'Entrance fee (students & seniors)', unit: 'head', min: 30, max: null, note: 'Discounted rate; replaces the regular fee.', inEstimate: false },
    { label: 'Tour guide', unit: 'group', min: 1200, max: null, groupSize: 5, note: 'Per group of up to 5. Mandatory for Peak 2 (summit).', inEstimate: true },
    { label: 'Camping', unit: 'groupNight', min: 500, max: null, note: 'Tayabak (Station 9) and Malaboo (Station 13).', inEstimate: false }
  ]],
  sipit: [[
    { label: 'Entrance fee', unit: 'head', min: 40, max: null, inEstimate: true },
    { label: 'Tour guide', unit: 'group', min: 1500, max: null, groupSize: 7, note: 'One guide per group of up to 7: 8–14 hikers need 2 guides (₱3,000), 15–21 need 3 (₱4,500).', inEstimate: true },
    { label: 'Camping (Melkas Campsite)', unit: 'groupNight', min: null, max: null, note: 'Fee not published.', inEstimate: false }
  ], [
    { label: 'Total budget (entrance & fees)', unit: 'head', min: 300, max: 550, note: 'Older data, unconfirmed.', inEstimate: true },
    { label: 'Tour guide', unit: 'group', min: 500, max: 800, note: 'Negotiable (older data).', inEstimate: true },
    { label: 'Camping (Melkas Campsite)', unit: 'groupNight', min: null, max: null, note: 'Fee not published.', inEstimate: false }
  ]],
  traverse: [[
    { label: 'Sto. Tomas side entrance fee', unit: 'head', min: 40, max: null, note: 'Same as the Sipit Trail side.', inEstimate: true },
    { label: 'UPLB exit fee', unit: 'head', min: null, max: null, note: 'Amount not published.', inEstimate: false },
    { label: 'Tour guide', unit: 'group', min: 1500, max: null, groupSize: 7, note: 'Same as the Sipit Trail side (one guide per group of up to 7), plus the guide\'s fare back to Sto. Tomas.', inEstimate: true }
  ], [
    { label: 'Sto. Tomas side fees', unit: 'head', min: 300, max: 550, note: 'Same as the Sipit Trail side.', inEstimate: true },
    { label: 'UPLB exit fee', unit: 'head', min: null, max: null, note: 'Amount not published.', inEstimate: false },
    { label: 'Tour guide', unit: 'group', min: 500, max: 800, note: 'Same as the Sto. Tomas side, plus the guide\'s fare back to Sto. Tomas.', inEstimate: true }
  ]]
};

/* Which suggested set a trail gets: its line's key (mariang, sipit,
   traverse, mudspring, flatrocks), the Botanic Gardens by name, otherwise
   the standard Forest Reserve rates, so every trail has suggested fees. */
export function suggestedKeyFor(trail) {
  const name = String(trail?.Trail || '');
  return trailLineKey(name) || (/botanic/i.test(name) ? 'botanic' : 'standard');
}

const CSS = `
.tf-list { display:flex; flex-direction:column; gap:6px; margin-bottom:10px; }
.tf-row { display:flex; justify-content:space-between; align-items:flex-start; gap:10px; padding:8px 10px;
  border:1px solid var(--border); border-radius:8px; background:var(--dm-surface-2, #fbfcfa); font-size:12.5px; }
.tf-row strong { display:block; font-size:12.5px; color:var(--text-primary); }
.tf-row small { display:block; color:var(--text-secondary); font-size:11px; line-height:1.4; margin-top:2px; }
.tf-amount { text-align:right; white-space:nowrap; font-weight:700; color:var(--accent-dark, #1f6b3a); }
.tf-amount small { font-weight:500; text-align:right; }
.tf-amount.is-none { color:var(--text-muted); font-weight:600; }
.tf-rates { margin-top:6px; display:grid; grid-template-columns:auto auto auto; gap:1px 10px; font-size:11px; color:var(--text-secondary); }
.tf-rates span:nth-child(3n) { text-align:right; font-weight:600; color:var(--text-primary); }
.tf-rates-head { font-weight:700; text-transform:uppercase; letter-spacing:.04em; font-size:9.5px; color:var(--text-muted) !important; }
.tf-edit-row .tf-rates-in { grid-column:1 / -1; min-height:72px; resize:vertical; font-family:ui-monospace, monospace; font-size:12px; }
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
.tf-edit-row .tf-note { grid-column:1 / 4; }
.tf-edit-row .tf-extra { grid-column:4 / 5; }
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

/* A rate table, cleaned: rows with whole guides / from / to and an amount,
   in order. Null when there is none. */
const cleanRates = (rates) => {
  if (!Array.isArray(rates)) return null;
  const rows = rates.map((row) => ({
    guides: Math.max(1, Math.round(num(row?.guides) ?? 1)),
    from: Math.round(num(row?.from) ?? 0),
    to: Math.round(num(row?.to) ?? num(row?.from) ?? 0),
    amount: num(row?.amount)
  })).filter((row) => row.from >= 1 && row.to >= row.from && row.amount !== null)
    .sort((a, b) => a.from - b.from);
  return rows.length ? rows : null;
};

/* The rate table's rows up to `hikers`: the listed ones, then (past the
   last) the 2nd guide's rows again, one more guide and one period further
   each time. */
function ratesUpTo(rates, hikers) {
  const rows = rates.filter((row) => row.from <= hikers);
  const last = rates[rates.length - 1];
  const cycleGuide = rates.find((row) => row.guides > rates[0].guides)?.guides;
  if (hikers <= last.to || cycleGuide === undefined) return rows;
  const cycle = rates.filter((row) => row.guides === cycleGuide);
  const period = cycle[cycle.length - 1].to - cycle[0].from + 1;
  for (let k = 1; ; k += 1) {
    const shifted = cycle.map((row) => ({ ...row, guides: row.guides + k, from: row.from + k * period, to: row.to + k * period }));
    if (shifted[0].from > hikers) break;
    shifted.forEach((row) => { if (row.from > last.to && row.from <= hikers) rows.push(row); });
  }
  return rows;
}

// "1:5 1700" / "1:6 +340" / "2:8 - 2:10 +1700", one row a line (the admin's
// own way of writing it), and back.
const ratesText = (rates) => (rates || []).map((row, i) => `${row.from === row.to || (i === 0 && row.from === 1) ? `${row.guides}:${row.to}`
  : `${row.guides}:${row.from} - ${row.guides}:${row.to}`} ${i ? '+' : ''}${row.amount}`).join('\n');
function parseRates(text) {
  const rows = [];
  const bad = [];
  String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).forEach((line) => {
    const m = /^(\d+)\s*:\s*(\d+)(?:\s*-\s*(?:(\d+)\s*:\s*)?(\d+))?\s+\+?\s*₱?\s*([\d,]+(?:\.\d+)?)$/.exec(line);
    if (!m) { bad.push(line); return; }
    const to = Number(m[4] ?? m[2]);
    const first = m[4] ? Number(m[2]) : null;
    rows.push({ guides: Number(m[1]), first, to, amount: Number(m[5].replace(/,/g, '')) });
  });
  // A row with one number covers the hikers after the row before it, up to
  // that number ("1:5" is hikers 1-5).
  let next = 1;
  const rates = rows.map((row) => {
    const from = row.first ?? next;
    next = row.to + 1;
    return { guides: row.guides, from, to: row.to, amount: row.amount };
  });
  return { rates: cleanRates(rates), bad };
}

const cleanFees = (fees) => (Array.isArray(fees) ? fees : []).map((fee) => ({
  label: String(fee?.label || '').trim(),
  unit: UNITS[fee?.unit] ? fee.unit : 'head',
  min: num(fee?.min),
  max: num(fee?.max),
  groupSize: num(fee?.groupSize),
  extraPerHead: num(fee?.extraPerHead),
  rates: fee?.unit === 'group' ? cleanRates(fee?.rates) : null,
  note: String(fee?.note || '').trim(),
  inEstimate: fee?.inEstimate !== false
})).filter((fee) => fee.label);

/* The cost for `hikers` people: per-head fees times the hikers, per-group
   fees once per group (groupSize hikers each, one group when not set) --
   or, with extraPerHead, once plus that much for each hiker past groupSize
   (the guide: 6 hikers pay ₱1,500 + ₱300) -- flat fees once. Per-night fees are left out: they depend on the stay. `groups`
   names how many of each sized per-group fee that takes ("2 × Tour guide"
   for 8–14 hikers on a guide for up to 7). */
function estimate(fees, hikers) {
  let low = 0;
  let high = 0;
  let counted = 0;
  const groups = [];
  fees.forEach((fee) => {
    if (!fee.inEstimate) return;
    const min = num(fee.min);
    const max = num(fee.max);
    if (fee.rates) {
      const rows = ratesUpTo(fee.rates, hikers);
      const total = rows.reduce((sum, row) => sum + row.amount, 0);
      counted += 1;
      low += total;
      high += total;
      const guides = rows[rows.length - 1]?.guides || 1;
      groups.push(`${guides} guide${guides === 1 ? '' : 's'}`);
      return;
    }
    if (min === null && max === null) return;
    const extra = num(fee.extraPerHead);
    if (fee.unit === 'group' && fee.groupSize && extra !== null) {
      const over = Math.max(0, hikers - fee.groupSize);
      counted += 1;
      low += (min ?? max) + over * extra;
      high += (max ?? min) + over * extra;
      if (over) groups.push(`${fee.label}: ${peso(min ?? max)} + ${over} × ${peso(extra)}`);
      return;
    }
    let times = 0;
    if (fee.unit === 'head') times = hikers;
    else if (fee.unit === 'group') times = fee.groupSize ? Math.ceil(hikers / fee.groupSize) : 1;
    else if (fee.unit === 'flat') times = 1;
    if (!times) return;
    counted += 1;
    low += (min ?? max) * times;
    high += (max ?? min) * times;
    if (fee.unit === 'group' && fee.groupSize) groups.push(`${times} × ${fee.label}`);
  });
  return { low, high, counted, groups };
}

/* The fees as they are saved: one amount when max equals min, a group size
   only on per-group fees. Shared by Save Fees and the one-time fill below. */
const toSaved = (fee) => ({
  label: fee.label,
  unit: fee.unit,
  min: fee.min,
  max: fee.max !== null && fee.max !== fee.min ? fee.max : null,
  groupSize: fee.unit === 'group' ? fee.groupSize : null,
  // Only beside a group size it applies to.
  extraPerHead: fee.unit === 'group' && fee.groupSize ? fee.extraPerHead : null,
  rates: fee.unit === 'group' && fee.rates ? fee.rates : null,
  note: fee.note,
  inEstimate: fee.inEstimate
});

/* Puts the published fees (SUGGESTED) into Firestore, trails/{id}.Fees, for
   the main trails that have none yet, so the PeakPath app can read them.
   Only a trail with no Fees field at all, or one still holding fees that
   were replaced (REPLACED): one whose fees an admin edited or cleared (an
   empty list) is left as it is. Runs once per page load, from Trail
   Management's trails listener; a Viewer's write is refused quietly and the
   next editor to open the page fills them in. */
const savedFees = (fees) => JSON.stringify(cleanFees(fees).map(toSaved));
const outdated = (trail) => {
  const saved = savedFees(trail.Fees);
  return (REPLACED[suggestedKeyFor(trail)] || []).some((set) => saved === savedFees(set));
};
let seedTried = false;
export async function seedSuggestedFees(db, trails) {
  if (seedTried || !trails.length) return;
  seedTried = true;
  for (const trail of trails) {
    const key = suggestedKeyFor(trail);
    const fill = !('Fees' in trail) || outdated(trail);
    // A saved guide fee from before the ₱300-per-extra-hiker rule (any per-
    // group "guide" fee without it): given the rule, the rest left as is.
    const fees = cleanFees(trail.Fees);
    const oldGuide = (fee) => fee.unit === 'group' && /guide/i.test(fee.label) && fee.extraPerHead === null;
    // The Sipit Trail: its group rate table, until it has one.
    // The Sipit Trail and the Traverse: their group rate tables, until they
    // have one.
    const sipitRates = !fill && (key === 'sipit' || key === 'traverse') && !fees.some((fee) => fee.rates);
    const guideFix = !fill && !sipitRates && fees.some(oldGuide);
    // Source links saved by an earlier version are no longer shown: removed.
    const hasSources = 'FeesSources' in trail;
    if (!fill && !sipitRates && !guideFix && !hasSources) continue;
    try {
      await updateDocDirect(doc(db, 'trails', trail.id), {
        ...(fill || sipitRates ? {
          Fees: cleanFees(SUGGESTED[key]).map(toSaved),
          FeesUpdatedAt: serverTimestamp(),
          FeesSource: 'published'
        } : {}),
        ...(guideFix ? {
          Fees: fees.map((fee) => (oldGuide(fee)
            ? { ...fee, min: GUIDE_FEE.min, max: null, groupSize: GUIDE_FEE.groupSize, extraPerHead: GUIDE_FEE.extraPerHead, note: GUIDE_NOTE }
            : fee)).map(toSaved),
          FeesUpdatedAt: serverTimestamp()
        } : {}),
        ...(hasSources ? { FeesSources: deleteField() } : {})
      });
    } catch (error) {
      console.warn(`Could not add the suggested fees to ${trail.Trail}:`, error.code || error.message);
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
  // A rate table: guides, hikers, and what each row adds.
  const ratesTableHtml = (rates) => `<div class="tf-rates" role="table" aria-label="Group rates">
    <span class="tf-rates-head">Guides</span><span class="tf-rates-head">Hikers</span><span class="tf-rates-head">Adds</span>
    ${rates.map((row, i) => `<span>${row.guides}</span><span>${row.from === row.to ? (i ? `${row.to}th` : row.to) : `${row.from}–${row.to}`}</span><span>${i ? '+' : ''}${escapeHtml(peso(row.amount))}</span>`).join('')}
  </div>`;

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
    const { low, high, counted, groups } = estimate(fees, hikers);
    container.innerHTML = `
      <div class="tf-list">${fees.map((fee) => `
        <div class="tf-row">
          <div><strong>${escapeHtml(fee.label)}</strong>${fee.note ? `<small>${escapeHtml(fee.note)}</small>` : ''}${fee.rates ? ratesTableHtml(fee.rates) : ''}</div>
          <div class="tf-amount${num(fee.min) === null && num(fee.max) === null ? ' is-none' : ''}">${escapeHtml(amountText(fee))}
            <small>${fee.rates ? `group rate (${fee.rates[0].from}–${fee.rates[0].to} hikers)` : `${escapeHtml(UNITS[fee.unit])}${fee.unit === 'group' && fee.groupSize ? ` (up to ${fee.groupSize})` : ''}`}</small>
            ${fee.unit === 'group' && fee.groupSize && num(fee.extraPerHead) !== null ? `<small>+ ${escapeHtml(peso(fee.extraPerHead))} per extra hiker</small>` : ''}</div>
        </div>`).join('')}
      </div>
      ${counted ? `<div class="tf-estimate">
        <label>Estimated cost for <input type="number" min="1" max="99" value="${hikers}" class="tf-hikers" aria-label="Number of hikers"${canEdit() ? '' : ' disabled title="Click &quot;Edit Trail Information&quot; first to change the number of hikers"'}> hikers:</label>
        <strong>${low === high ? peso(low) : `${peso(low)} – ${peso(high)}`}</strong>
        <span>(≈ ${low === high ? peso(Math.round(low / hikers)) : `${peso(Math.round(low / hikers))} – ${peso(Math.round(high / hikers))}`} per head)</span>
        ${groups.length ? `<span>· ${escapeHtml(groups.join(', '))}</span>` : ''}
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
      <input class="tf-extra" type="number" min="0" step="1" placeholder="+₱ extra" value="${num(fee.extraPerHead) ?? ''}" aria-label="Pesos for each hiker past the group size (per-group fees)" title="Per-group fees: pesos for each hiker past the group size (e.g. ₱300 after 5). Empty: another whole group instead.">
      <label class="tf-in"><input class="tf-in-box" type="checkbox"${fee.inEstimate === false ? '' : ' checked'}> In estimate</label>
      <textarea class="tf-rates-in" aria-label="Group rate table (per-group fees)" title="Optional, for per-group fees: one row a line, guides:hikers amount. The first row is the base; the rest add to it. Past the last row, the 2nd guide's rows repeat." placeholder="Group rate table (optional, per-group fees), one row a line, e.g.&#10;1:5 1700&#10;1:6 +340&#10;2:8 - 2:10 +1700">${escapeHtml(ratesText(fee.rates))}</textarea>
    </div>`;

  const readRows = () => [...rowsEl.querySelectorAll('.tf-edit-row')].map((row) => ({
    label: row.querySelector('.tf-label').value.trim(),
    unit: row.querySelector('.tf-unit').value,
    min: num(row.querySelector('.tf-min').value),
    max: num(row.querySelector('.tf-max').value),
    groupSize: num(row.querySelector('.tf-group').value),
    extraPerHead: num(row.querySelector('.tf-extra').value),
    rates: parseRates(row.querySelector('.tf-rates-in').value).rates,
    ratesBad: parseRates(row.querySelector('.tf-rates-in').value).bad,
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
    const key = suggestedKeyFor(trail);
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
    const suggested = SUGGESTED[suggestedKeyFor(editing)];
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
    const badRates = rows.find((fee) => fee.ratesBad.length);
    if (badRates) { errorEl.textContent = `${badRates.label}: the rate table line "${badRates.ratesBad[0]}" is not like "1:6 +340" or "2:8 - 2:10 +1700".`; return; }
    const misplaced = rows.find((fee) => fee.rates && fee.unit !== 'group');
    if (misplaced) { errorEl.textContent = `${misplaced.label}: a rate table needs "per group".`; return; }
    // With a rate table, its first row is the fee's amount.
    const fees = rows.map((fee) => toSaved(fee.rates ? { ...fee, min: fee.rates[0].amount, max: null } : fee));
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
