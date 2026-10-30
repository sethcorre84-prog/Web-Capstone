// weather-locations.js
// The places the dashboard's weather card can report on, and which one is
// chosen. Settings > System Settings > Dashboard Weather picks it and saves
// it to Firestore (settings/weather { location }), shared by every admin and
// by the PeakPath app's Current Conditions card (WeatherService in the app's
// homepage.dart has the same places and makes the same request). This
// browser keeps a copy so the cards show the right place straight away.
//
// Temperatures come from Open-Meteo's live "current" conditions. It models a
// grid a few km wide, so each location also passes its elevation: Open-Meteo
// then corrects the temperature for height, which is what makes the summit
// read cooler than the trailhead and the town below it.

import { doc, onSnapshot, serverTimestamp, setDoc } from './firestore-tracked.js';

const STORAGE_KEY = 'peakpath-weather-location';
const SETTING_PATH = ['settings', 'weather'];

export const WEATHER_LOCATIONS = {
  summit: {
    name: 'Mt. Makiling Summit',
    short: 'Summit',
    // Peak 3, the highest point (1,109 MASL), where the maps put it
    // (assets/data/makiling-trails.geojson). The app's WeatherService uses
    // the same point and height.
    latitude: 14.13465,
    longitude: 121.18828,
    elevation: 1109
  },
  sipit: {
    name: 'Sipit Trail',
    short: 'Sipit Trail',
    // The Sipit Trail marker in trail.html.
    latitude: 14.1150551,
    longitude: 121.186634
  },
  losBanos: {
    name: 'Los Baños',
    short: 'Los Baños',
    // Los Baños town proper, at the foot of the mountain.
    latitude: 14.1699,
    longitude: 121.2441
  }
};

export const DEFAULT_WEATHER_LOCATION = 'summit';

export function getWeatherLocationKey() {
  try {
    const key = localStorage.getItem(STORAGE_KEY);
    return WEATHER_LOCATIONS[key] ? key : DEFAULT_WEATHER_LOCATION;
  } catch {
    // localStorage can be blocked (private mode, site-data settings).
    return DEFAULT_WEATHER_LOCATION;
  }
}

// Throws if the browser blocks storage, so the caller can say so.
export function setWeatherLocationKey(key) {
  if (!WEATHER_LOCATIONS[key]) return;
  localStorage.setItem(STORAGE_KEY, key);
}

export function weatherUrlFor(key) {
  const place = WEATHER_LOCATIONS[key] || WEATHER_LOCATIONS[DEFAULT_WEATHER_LOCATION];
  const params = new URLSearchParams({
    latitude: place.latitude,
    longitude: place.longitude,
    current: 'temperature_2m,weather_code,precipitation,wind_speed_10m',
    temperature_unit: 'celsius',
    wind_speed_unit: 'kmh',
    timezone: 'Asia/Manila'
  });
  if (place.elevation !== undefined) params.set('elevation', place.elevation);
  return `https://api.open-meteo.com/v1/forecast?${params}`;
}

export const WEATHER_STORAGE_KEY = STORAGE_KEY;

/* Calls onChange(key) whenever the shared location changes from the one
   this browser last showed (on load too, if another admin changed it). A
   missing document means the default. Returns the unsubscribe function. */
export function watchWeatherLocation(db, onChange) {
  let last = getWeatherLocationKey();
  return onSnapshot(doc(db, ...SETTING_PATH), (snapshot) => {
    const saved = snapshot.data()?.location;
    const key = WEATHER_LOCATIONS[saved] ? saved : DEFAULT_WEATHER_LOCATION;
    try {
      localStorage.setItem(STORAGE_KEY, key);
    } catch {
      // Storage blocked: the cards still follow the shared choice.
    }
    if (key === last) return;
    last = key;
    onChange(key);
  }, (error) => console.warn('Could not read the shared weather location:', error.message));
}

/* Saves the location for every admin and the app. Throws if Firestore
   refuses (e.g. a Viewer account). */
export async function saveWeatherLocation(db, key, uid = '') {
  if (!WEATHER_LOCATIONS[key]) return;
  await setDoc(doc(db, ...SETTING_PATH), { location: key, updatedAt: serverTimestamp(), updatedBy: uid });
  try {
    localStorage.setItem(STORAGE_KEY, key);
  } catch {
    // Saved in Firestore; this browser just can't keep its copy.
  }
}
