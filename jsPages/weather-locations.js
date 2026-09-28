// weather-locations.js
// The places the dashboard's weather card can report on, and which one is
// chosen. Settings > System Settings > Dashboard Weather picks it; the choice
// is saved to this browser (like the theme) and the dashboard reads it here.
//
// Temperatures come from Open-Meteo's live "current" conditions. It models a
// grid a few km wide, so each location also passes its elevation: Open-Meteo
// then corrects the temperature for height, which is what makes the summit
// read cooler than the trailhead and the town below it.

const STORAGE_KEY = 'peakpath-weather-location';

export const WEATHER_LOCATIONS = {
  summit: {
    name: 'Mt. Makiling Summit',
    short: 'Summit',
    // Peak 2, the true summit -- the same centre makiling-area.js uses.
    latitude: 14.1325,
    longitude: 121.1936,
    elevation: 1090
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
