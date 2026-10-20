import { db } from './firebase-config.js';
import { escapeHtml } from './utils.js';
import { formatPortalTime, toPortalDate } from './datetime-prefs.js';
import { collection, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// The SOS alarm on every portal page (started from notification.js), so a
// new emergency alert is heard and seen wherever the admin is in the portal:
// a short alarm tone and a pop-up in the lower right for each alert.

const TOAST_LIMIT = 4;     // pop-ups on screen at once; a fifth drops the oldest
const TOAST_MS = 5000;     // how long each pop-up stays

const CSS = `
.sos-toasts { position: fixed; right: 24px; bottom: 24px; z-index: 1300; display: flex; flex-direction: column; gap: 10px;
  width: min(340px, calc(100vw - 32px)); pointer-events: none; }
.sos-toast { position: relative; display: flex; align-items: flex-start; gap: 6px; padding: 12px 10px 14px 14px; overflow: hidden;
  border: 1px solid var(--border, #e4e7e1); border-left: 4px solid var(--danger, #c8402f); border-radius: 10px;
  background: var(--card-bg, #fff); box-shadow: 0 12px 30px rgba(20, 35, 20, .18); pointer-events: auto;
  animation: sos-toast-in .25s ease-out; }
.sos-toast.leaving { animation: sos-toast-out .25s ease-in forwards; }
.sos-toast-link { flex: 1; min-width: 0; display: flex; align-items: flex-start; gap: 12px; color: inherit; text-decoration: none; }
.sos-toast-icon { flex: none; display: grid; place-items: center; width: 34px; height: 34px; border-radius: 50%;
  background: var(--red-bg, #fbe9e7); color: var(--red-text, #c8402f); font-size: 15px; }
.sos-toast-copy { min-width: 0; display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: var(--text-secondary, #5b6b60); }
.sos-toast-copy strong { font-size: 13px; color: var(--red-text, #c8402f); }
.sos-toast-copy .sos-toast-name { font-size: 13px; font-weight: 600; color: var(--text-primary, #1c231c); }
.sos-toast-copy span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sos-toast-close { flex: none; width: 24px; height: 24px; display: grid; place-items: center; border: 0; border-radius: 6px;
  background: transparent; color: var(--text-muted, #93a199); cursor: pointer; }
.sos-toast-close:hover { background: var(--red-bg, #fbe9e7); color: var(--red-text, #c8402f); }
/* pages.css paints every icon green; these take their container's colour. */
.sos-toast-icon i, .sos-toast-close i { color: inherit; }
.sos-toast-close:focus-visible, .sos-toast-link:focus-visible { outline: 2px solid var(--accent, #2f8f4e); outline-offset: 2px; }
.sos-toast-timer { position: absolute; left: 0; bottom: 0; width: 100%; height: 3px; background: var(--danger, #c8402f); opacity: .45;
  transform-origin: left; animation: sos-toast-timer ${TOAST_MS}ms linear forwards; }
@keyframes sos-toast-in { from { opacity: 0; transform: translateX(24px); } }
@keyframes sos-toast-out { to { opacity: 0; transform: translateX(24px); } }
@keyframes sos-toast-timer { to { transform: scaleX(0); } }
@media (max-width: 600px) { .sos-toasts { right: 16px; bottom: 16px; } }
@media (prefers-reduced-motion: reduce) { .sos-toast, .sos-toast.leaving { animation: none; } }
`;

// Same closed words as emergency.html, so the two agree on which alerts are
// still awaiting response. Also used by notification.js.
export const statusOf = (data) => {
  const raw = String(data.status ?? data.Status ?? data.state ?? 'active').toLowerCase();
  if (/cancel|false alarm|dismiss/.test(raw)) return 'cancelled';
  if (/resolv|closed|complet|rescued|safe/.test(raw)) return 'resolved';
  if (/respond|dispatch|assign|progress|en route|search/.test(raw)) return 'responding';
  return 'active';
};

// Objects (GeoPoints, Timestamps) are not text; the first alias with text wins.
const text = (value) => (value === null || value === undefined || typeof value === 'object' ? '' : String(value).trim());
const first = (data, keys) => keys.map((key) => text(data[key])).find(Boolean) || '';
const COORDINATES = /^\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*$/;

// One alert, read through emergency.html's aliases: what a pop-up says, and
// what notification.js says about a Lost / Missing alert. `place` is '' when
// the alert names no place.
export const alertOf = (data) => {
  const place = text(data.location ?? data.Location);
  const created = ['timestamp', 'createdAt', 'reportedAt', 'date', 'time'].map((key) => toPortalDate(data[key])).find(Boolean) || null;
  // Lost / Missing when it says so; every other alert is an SOS.
  const lost = /lost|missing|search|stray/.test(first(data, ['type', 'Type', 'category', 'emergencyType', 'title']).toLowerCase());
  return {
    lost,
    title: lost ? 'Lost / Missing alert' : 'SOS alert',
    name: first(data, ['hikerName', 'userName', 'username', 'name', 'reportedBy', 'email']) || 'Unknown hiker',
    place: place && !COORDINATES.test(place) ? place : first(data, ['trailName', 'trail', 'Trail', 'area']),
    created
  };
};

// Alerts already announced, kept across pages: moving to another page does
// not replay them, while an alert that came in during the page change still
// sounds and pops up on the next one.
const ANNOUNCED_KEY = 'peakpath:sos-announced';
const readAnnounced = () => {
  try { return new Set(JSON.parse(localStorage.getItem(ANNOUNCED_KEY) || '[]')); } catch { return new Set(); }
};
const saveAnnounced = (ids) => {
  try { localStorage.setItem(ANNOUNCED_KEY, JSON.stringify(ids)); } catch { /* the alarm may then repeat on the next page */ }
};

// ---- Pop-ups ----
let stack = null;

const dismiss = (toast) => {
  if (toast.classList.contains('leaving')) return;
  toast.classList.add('leaving');
  setTimeout(() => toast.remove(), 250);
};

// Newest at the bottom, so earlier pop-ups are pushed up; past the limit the
// oldest (top) one goes.
const showToast = ({ title, name, place, created }) => {
  if (!stack) {
    stack = document.createElement('div');
    stack.className = 'sos-toasts';
    stack.setAttribute('role', 'region');
    stack.setAttribute('aria-label', 'SOS alerts');
    document.body.appendChild(stack);
  }
  while (stack.children.length >= TOAST_LIMIT) stack.firstElementChild.remove();

  const time = created ? formatPortalTime(created) : '';
  const toast = document.createElement('div');
  toast.className = 'sos-toast';
  toast.setAttribute('role', 'alert');
  toast.innerHTML = `
    <a class="sos-toast-link" href="emergency.html">
      <span class="sos-toast-icon"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i></span>
      <span class="sos-toast-copy">
        <strong>${escapeHtml(title)}</strong>
        <span class="sos-toast-name">${escapeHtml(name)}</span>
        <span>${escapeHtml(place || 'Location shared on map')}${time ? ` · ${escapeHtml(time)}` : ''}</span>
      </span>
    </a>
    <button type="button" class="sos-toast-close" aria-label="Dismiss alert"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
    <span class="sos-toast-timer" aria-hidden="true"></span>
  `;
  toast.querySelector('.sos-toast-close').addEventListener('click', () => dismiss(toast));
  stack.appendChild(toast);
  setTimeout(() => dismiss(toast), TOAST_MS);
};

// ---- Alarm tone ----
let audio = null;
let waitingForClick = false;
const context = () => (audio ||= new (window.AudioContext || window.webkitAudioContext)());

const playTones = (ctx) => {
  const now = ctx.currentTime;
  [0, 0.28, 0.56].forEach((offset) => {
    const tone = ctx.createOscillator();
    const gain = ctx.createGain();
    tone.type = 'square';
    tone.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, now + offset);
    gain.gain.exponentialRampToValueAtTime(0.18, now + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.2);
    tone.connect(gain).connect(ctx.destination);
    tone.start(now + offset);
    tone.stop(now + offset + 0.22);
  });
};

const soundAlarm = () => {
  try {
    const ctx = context();
    if (ctx.state === 'running') {
      playTones(ctx);
      return;
    }
  } catch {
    return; // no Web Audio in this browser
  }
  // The browser holds sound until the page is clicked; play it then.
  waitingForClick = true;
};

const unlock = () => {
  try {
    const ctx = context();
    ctx.resume().then(() => {
      if (!waitingForClick || ctx.state !== 'running') return;
      waitingForClick = false;
      playTones(ctx);
    }).catch(() => { /* still blocked */ });
  } catch { /* no sound */ }
};

export const watchSosAlarm = () => {
  document.head.appendChild(Object.assign(document.createElement('style'), { textContent: CSS }));
  document.addEventListener('pointerdown', unlock);
  document.addEventListener('keydown', unlock);

  onSnapshot(collection(db, 'emergency'), (snapshot) => {
    const awaiting = snapshot.docs.filter((snap) => statusOf(snap.data() || {}) === 'active');
    const announced = readAnnounced();
    // Only alerts still awaiting response are kept, so the list stays short.
    saveAnnounced(awaiting.map((snap) => snap.id));

    const fresh = awaiting
      .filter((snap) => !announced.has(snap.id))
      .map((snap) => alertOf(snap.data() || {}))
      .sort((a, b) => (a.created?.getTime() || 0) - (b.created?.getTime() || 0));
    if (!fresh.length) return;
    fresh.slice(-TOAST_LIMIT).forEach(showToast);
    soundAlarm();
  }, (error) => {
    console.warn('SOS alarm could not watch emergency alerts:', error.message);
  });
};
