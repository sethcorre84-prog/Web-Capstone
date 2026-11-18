// weather-fetch.js
// Every Open-Meteo request the portal makes goes through here (Dashboard,
// Geomap and Emergency weather cards, Analytics' forecast).
//
// Why: api.open-meteo.com is sometimes unreachable from a given network
// (the connection never opens) even while the service itself is up, and a
// plain fetch() has no time limit, so a card could sit on "Loading" for
// minutes. This module:
//   - gives each attempt TIMEOUT_MS, then retries once;
//   - reuses a reading younger than maxAgeMs instead of asking again, so
//     moving between pages does not re-download the same weather;
//   - when every attempt fails, returns the last good reading (up to
//     STALE_LIMIT_MS old) marked stale, so the card still shows a real,
//     dated value -- each card prints the reading's own time;
//   - shares one in-flight request per URL within a page.
// The cache is this browser's localStorage, a convenience only: when
// storage is blocked everything still works, just without the reuse.

const CACHE_PREFIX = 'peakpath-weather-cache:';
const TIMEOUT_MS = 8000;
const ATTEMPTS = 2;
const STALE_LIMIT_MS = 6 * 60 * 60 * 1000;

const inFlight = new Map();

const readCache = (url) => {
  try {
    const entry = JSON.parse(localStorage.getItem(CACHE_PREFIX + url) || 'null');
    return entry && Number.isFinite(entry.at) && entry.data ? entry : null;
  } catch {
    return null;
  }
};

const writeCache = (url, data) => {
  try {
    localStorage.setItem(CACHE_PREFIX + url, JSON.stringify({ at: Date.now(), data }));
  } catch {
    // Storage blocked or full: the reading is still returned.
  }
};

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Weather request failed with ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/* Resolves to { data, stale, savedAt }. Throws only when nothing works and
   no saved reading is recent enough to show. */
export function fetchWeather(url, { maxAgeMs = 10 * 60 * 1000 } = {}) {
  const cached = readCache(url);
  if (cached && Date.now() - cached.at < maxAgeMs) {
    return Promise.resolve({ data: cached.data, stale: false, savedAt: new Date(cached.at) });
  }
  if (inFlight.has(url)) return inFlight.get(url);

  const request = (async () => {
    let lastError;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      try {
        const data = await fetchWithTimeout(url);
        writeCache(url, data);
        return { data, stale: false, savedAt: new Date() };
      } catch (error) {
        lastError = error.name === 'AbortError'
          ? new Error(`Weather service did not answer within ${TIMEOUT_MS / 1000} s`)
          : error;
      }
    }
    const fallback = readCache(url);
    if (fallback && Date.now() - fallback.at < STALE_LIMIT_MS) {
      console.warn('Weather service unreachable; showing the last saved reading.', lastError);
      return { data: fallback.data, stale: true, savedAt: new Date(fallback.at) };
    }
    throw lastError;
  })().finally(() => inFlight.delete(url));

  inFlight.set(url, request);
  return request;
}
