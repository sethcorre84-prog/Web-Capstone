// trail-images.js
// The photo shown for a trail: its uploaded image if it has one (imageUrl,
// set by Add Trail), otherwise a picture from the "trailPicture" folder in
// Firebase Storage whose file name matches the trail's name, otherwise a
// plain placeholder (never a stock photo, which would read as the trail's).
// Used by Trail Management and the Dashboard's Trail Status Overview.
//
// Listing the folder waits for sign-in and a few Storage requests, so the
// links found last time are kept in this browser (localStorage) and used
// straight away on the next load; the listing then refreshes them. Without
// that, every refresh showed the placeholder first.
//
// File names are matched loosely, ignoring case, spaces, punctuation and the
// extension, so "sipitTrail.jpg", "Sipit Trail.png" and "sipit-trail.webp"
// all match "Sipit Trail", and "mariangMakiling.jpg" matches "Mariang
// Makiling Trail" (a file name contained in the trail name also counts; the
// longest such match wins). To give a trail a new picture, upload it to
// trailPicture/ named after the trail; no code change is needed.

import { auth, storage } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getDownloadURL, listAll, ref } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

const PICTURE_FOLDER = 'trailPicture';
// Shown while the pictures load and for a trail with no picture: a flat
// tile with a mountain outline, so it can't be mistaken for a real photo.
const DEFAULT_TRAIL_IMAGE = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 100" preserveAspectRatio="xMidYMid slice">'
  + '<rect width="160" height="100" fill="#e6ebe4"/>'
  + '<path d="M58 66 72 46l8 10 10-16 14 26z" fill="none" stroke="#9aa89d" stroke-width="3" stroke-linejoin="round"/>'
  + '</svg>')}`;

const keyOf = (value) => String(value || '')
  .replace(/\.[a-z0-9]+$/i, '') // extension
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '');

const CACHE_KEY = 'peakpath-trail-pictures';

// keyOf(file name) -> download URL: last visit's, until the folder is listed.
let pictures = new Map();
try {
  const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || '[]');
  if (Array.isArray(cached)) pictures = new Map(cached.filter((entry) => Array.isArray(entry) && entry.length === 2));
} catch { /* storage blocked or corrupt: wait for the listing */ }
let ready = false;
const readyCallbacks = [];

// Storage rules only let signed-in users read the folder, so list it once the
// session has been restored.
const unsubscribe = onAuthStateChanged(auth, async (user) => {
  if (!user) return;
  unsubscribe();
  try {
    const { items } = await listAll(ref(storage, PICTURE_FOLDER));
    const entries = await Promise.all(items.map(async (item) => {
      try {
        return [keyOf(item.name), await getDownloadURL(item)];
      } catch (error) {
        console.warn(`Could not load trail picture ${item.fullPath}:`, error.message);
        return null;
      }
    }));
    pictures = new Map(entries.filter(Boolean));
    try { localStorage.setItem(CACHE_KEY, JSON.stringify([...pictures])); } catch { /* not remembered */ }
    console.info(`Trail pictures in ${PICTURE_FOLDER}/:`, items.map((item) => item.name));
  } catch (error) {
    console.warn(`Could not list the trail pictures in Storage (${PICTURE_FOLDER}/). If this says`
      + ' "unauthorized", deploy the Storage rules: firebase deploy --only storage.', error.message);
  }
  ready = true;
  readyCallbacks.splice(0).forEach((callback) => callback());
});

function pictureFor(trailName) {
  const trailKey = keyOf(trailName);
  if (!trailKey) return null;
  if (pictures.has(trailKey)) return pictures.get(trailKey);
  let best = null;
  pictures.forEach((url, fileKey) => {
    if (fileKey.length >= 4 && trailKey.includes(fileKey) && (!best || fileKey.length > best.key.length)) {
      best = { key: fileKey, url };
    }
  });
  return best?.url || null;
}

export function getTrailImage(trail) {
  return trail.imageUrl || trail.imageURL || trail.ImageUrl || trail.photoUrl || trail.photoURL || trail.PhotoUrl
    || pictureFor(trail.Trail) || DEFAULT_TRAIL_IMAGE;
}

// Runs `callback` once the Storage pictures have loaded, so a page can redraw
// the trails it drew before they arrived.
export function onTrailImagesReady(callback) {
  if (ready) callback();
  else readyCallbacks.push(callback);
}
