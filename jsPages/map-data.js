// map-data.js
// What every map draws that isn't a trail, station or report record: the
// trail lines with Peaks 2 and 3 (GeoJSON), the rivers and creeks (GeoJSON)
// and the jump-off / registration points (with the road to the Sipit
// Trail). They are kept in Firestore, settings/map, so the PeakPath app
// draws the same and picks up a change at once:
//   settings/map {
//     trails     the text of a GeoJSON FeatureCollection (lines + peaks)
//     waterways  the text of a GeoJSON FeatureCollection (rivers, creeks)
//     jumpOffs   the text of a JSON list of jump-offs (JUMP_OFFS' shape)
//     updatedAt, updatedBy
//   }
// Stored as text because Firestore can't hold a list of lists (GeoJSON
// coordinates); the app parses the same text it used to read from its
// bundled files. Written only by the saveMapData function (admins).
//
// The files in assets/data/ are the starting copy: when settings/map is
// missing, the maps use them, and an admin's page fills settings/map from
// them once. A field that won't load or parse falls back to its file.

import { auth, db } from './firebase-config.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js';

const fileUrl = (name) => new URL(`../assets/data/${name}`, import.meta.url).href;
const FILES = { trails: 'makiling-trails.geojson', waterways: 'makiling-waterways.geojson' };

async function fileText(name) {
  const response = await fetch(fileUrl(name));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

const parse = (text) => {
  try { return JSON.parse(text); } catch { return null; }
};

/* The version of the files below. Raise it whenever a file (or the built-in
   jump-offs) changes: an admin's next page then puts them into settings/map,
   replacing what is stored there. 2: the Makiling Traverse rerouted up the
   Sipit Trail, and its jump-off. 3: the Mariang Makiling Trail's
   registration. 4: Peak 3 moved to the highest point,
   1,109 MASL (14.13465, 121.18828). */
const MAP_DATA_VERSION = 4;

let request = null;

// Firestore only lets a signed-in user read settings/: wait for the session
// to be restored (a few seconds at most).
const signedIn = () => new Promise((resolve) => {
  if (auth.currentUser) { resolve(true); return; }
  const timer = setTimeout(() => { stop(); resolve(false); }, 8000);
  const stop = auth.onAuthStateChanged((user) => {
    if (!user) return;
    clearTimeout(timer);
    stop();
    resolve(true);
  });
});

/* { trails, waterways, jumpOffs }: the GeoJSON objects and the jump-off
   list, from settings/map (each falling back to its file), read once per
   page. `fallbackJumpOffs` is the built-in list (makiling-area.js). */
export function loadMapData(fallbackJumpOffs = []) {
  request ||= (async () => {
    let stored = null;
    // Only a successful read that finds a field missing may fill it in:
    // never after a failed read, which would overwrite what is stored.
    let readOk = false;
    try {
      await signedIn();
      const snap = await getDoc(doc(db, 'settings', 'map'));
      stored = snap.exists() ? snap.data() : null;
      readOk = true;
    } catch (error) {
      console.warn('Could not read the map data (settings/map); using the files.', error.message);
    }
    // Stored from older files: every field from the files again.
    const outdated = readOk && stored && Number(stored.version || 0) < MAP_DATA_VERSION;
    const fromStore = (field) => {
      const value = stored && !outdated ? parse(stored[field]) : null;
      return value && (Array.isArray(value) || Array.isArray(value.features)) ? value : null;
    };
    const data = {
      trails: fromStore('trails'),
      waterways: fromStore('waterways'),
      jumpOffs: fromStore('jumpOffs')
    };
    const missing = Object.keys(data).filter((field) => !data[field]);
    const texts = {};
    for (const field of missing) {
      if (field === 'jumpOffs') {
        data.jumpOffs = fallbackJumpOffs;
        texts.jumpOffs = JSON.stringify(fallbackJumpOffs);
        continue;
      }
      try {
        texts[field] = await fileText(FILES[field]);
        data[field] = parse(texts[field]) || { features: [] };
      } catch (error) {
        console.warn(`Could not load ${FILES[field]}:`, error.message);
        data[field] = { features: [] };
      }
    }
    // First time (or a field missing): an admin's page puts the files into
    // settings/map, so the app draws them from Firestore from now on.
    if (readOk && missing.length && Object.keys(texts).length === missing.length) {
      seedMapData({ ...texts, version: MAP_DATA_VERSION });
    }
    return data;
  })().catch((error) => {
    request = null;
    throw error;
  });
  return request;
}

let seeded = false;
function seedMapData(texts) {
  if (seeded) return;
  seeded = true;
  const run = () => httpsCallable(getFunctions(auth.app, 'asia-southeast1'), 'saveMapData')(texts)
    .then(() => console.info('Map data saved to Firestore (settings/map):', Object.keys(texts).filter((k) => k !== 'version').join(', ')))
    // Not an admin, or the function isn't there yet: the files keep working.
    .catch((error) => console.info('Map data not saved to Firestore:', error?.message || error));
  if (auth.currentUser) run();
  else {
    const stop = auth.onAuthStateChanged((user) => {
      if (!user) return;
      stop();
      run();
    });
  }
}
