import { db } from './firebase-config.js';
import { collection, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// The SOS alarm tone, on every portal page (started from notification.js),
// so a new emergency alert is heard wherever the admin is in the portal.

// Same closed words as emergency.html, so the two agree on which alerts are
// still awaiting response.
const statusOf = (data) => {
  const raw = String(data.status ?? data.Status ?? data.state ?? 'active').toLowerCase();
  if (/cancel|false alarm|dismiss/.test(raw)) return 'cancelled';
  if (/resolv|closed|complet|rescued|safe/.test(raw)) return 'resolved';
  if (/respond|dispatch|assign|progress|en route|search/.test(raw)) return 'responding';
  return 'active';
};

// Alerts already sounded, kept across pages: moving to another page does not
// replay the alarm for them, while an alert that came in during the page
// change still sounds on the next one.
const ANNOUNCED_KEY = 'peakpath:sos-announced';
const readAnnounced = () => {
  try { return new Set(JSON.parse(localStorage.getItem(ANNOUNCED_KEY) || '[]')); } catch { return new Set(); }
};
const saveAnnounced = (ids) => {
  try { localStorage.setItem(ANNOUNCED_KEY, JSON.stringify(ids)); } catch { /* the alarm may then repeat on the next page */ }
};

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
  document.addEventListener('pointerdown', unlock);
  document.addEventListener('keydown', unlock);

  onSnapshot(collection(db, 'emergency'), (snapshot) => {
    const awaiting = snapshot.docs
      .filter((snap) => statusOf(snap.data() || {}) === 'active')
      .map((snap) => snap.id);
    const announced = readAnnounced();
    // Only alerts still awaiting response are kept, so the list stays short.
    saveAnnounced(awaiting);
    if (awaiting.some((id) => !announced.has(id))) soundAlarm();
  }, (error) => {
    console.warn('SOS alarm could not watch emergency alerts:', error.message);
  });
};
