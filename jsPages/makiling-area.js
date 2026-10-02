// makiling-area.js
// The one definition of "Mount Makiling" for every map in the portal: a 6 km
// radius around the summit. geomap.html and dashboard.html both build their
// maps from this, so they can never disagree on where the mountain ends.
//
// Leaflet is loaded as a classic deferred script, which runs before the
// pages' module scripts, so the global `L` is ready whenever this is called.

export const MAKILING_CENTER = [14.1325, 121.1936];
export const MAKILING_RADIUS_M = 6000;

// The mountain's edge as a polygon, reused both as the outline drawn on the
// map and as the hole cut out of the grey mask.
export const MAKILING_RING = (() => {
  const latDegrees = MAKILING_RADIUS_M / 111320;
  const lngDegrees = latDegrees / Math.cos(MAKILING_CENTER[0] * Math.PI / 180);
  const points = [];
  for (let step = 0; step < 180; step += 1) {
    const angle = (step / 180) * 2 * Math.PI;
    points.push([
      MAKILING_CENTER[0] + latDegrees * Math.cos(angle),
      MAKILING_CENTER[1] + lngDegrees * Math.sin(angle)
    ]);
  }
  return points;
})();

/* The same box L.latLngBounds(MAKILING_RING) gives, for pages that count
   hikers on the mountain without drawing a map (User Management), so they
   need neither Leaflet nor a map element. Only contains([lat, lng]) is used. */
export const MAKILING_BOUNDS = (() => {
  const lats = MAKILING_RING.map(([lat]) => lat);
  const lngs = MAKILING_RING.map(([, lng]) => lng);
  const south = Math.min(...lats);
  const north = Math.max(...lats);
  const west = Math.min(...lngs);
  const east = Math.max(...lngs);
  return {
    contains: ([lat, lng]) => lat >= south && lat <= north && lng >= west && lng <= east
  };
})();

/* Satellite imagery (Esri World Imagery) for every map in the portal. Esri
   has imagery down to about zoom 18 here; closer than that, Leaflet enlarges
   the zoom 18 tiles rather than showing blank squares. */
export function addSatelliteLayer(map, options = {}) {
  return L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    maxNativeZoom: 18,
    attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
    ...options
  }).addTo(map);
}

// The same colours as the page behind the map in each theme (pages.css).
const maskColor = () =>
  (document.documentElement.getAttribute('data-theme') === 'dark' ? '#111410' : '#e8edf0');

/* A Mount Makiling map only: everything outside the 6 km radius is greyed
   out, and panning/zooming is locked to that area so the view can never
   wander off the mountain. Returns the map and the locked bounds, which
   pages use to keep markers and views inside the mountain. */
export function createMakilingMap(element) {
  const bounds = L.latLngBounds(MAKILING_RING);

  const map = L.map(element, {
    center: MAKILING_CENTER,
    zoom: 13,
    minZoom: 13,
    maxZoom: 19,
    maxBounds: bounds,
    maxBoundsViscosity: 1
  });
  addSatelliteLayer(map, { minZoom: 13, bounds });

  // Grey out everything beyond the mountain: one polygon covering the world
  // with the Makiling ring punched out of it as a hole. Leaflet draws it in
  // SVG with a colour given here, so CSS dark mode cannot reach it; it reads
  // the theme itself instead.
  const mask = L.polygon([
    [[-90, -180], [-90, 180], [90, 180], [90, -180]],
    MAKILING_RING
  ], {
    stroke: false,
    fillColor: maskColor(),
    fillOpacity: 0.94,
    interactive: false
  }).addTo(map);

  // sidebar.js flips data-theme on <html> when the theme changes in
  // another tab or the computer switches (System); follow it without a reload.
  new MutationObserver(() => mask.setStyle({ fillColor: maskColor() }))
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  L.polygon(MAKILING_RING, {
    fill: false,
    color: '#2f8f4e',
    weight: 2,
    dashArray: '6 6',
    interactive: false
  }).addTo(map);

  // Every Mount Makiling map shows the trails. A missing file only costs
  // the lines, never the map.
  addTrailLines(map).catch((error) => console.warn('Could not draw the trail lines:', error.message));

  return { map, bounds };
}

/* ---- Trail lines ----
   The trails themselves, drawn over the satellite imagery: Mariang Makiling,
   Sipit, the Makiling Traverse and the Mud Spring and Flat Rocks side trails.
   The lines are OpenStreetMap data, copied once into
   assets/data/makiling-trails.geojson (see its "attribution") so the maps
   do not depend on a live OSM service. The Botanic Gardens trail is not
   mapped in OSM, so it has no line. */
const TRAILS_URL = new URL('../assets/data/makiling-trails.geojson', import.meta.url).href;
let trailsRequest = null;

export function loadTrailLines() {
  trailsRequest ||= fetch(TRAILS_URL)
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .catch((error) => {
      trailsRequest = null; // let a later call try again
      throw error;
    });
  return trailsRequest;
}

// A trails/{id} document's name -> the line it is drawn with, or null.
export function trailLineKey(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('sipit')) return 'sipit';
  if (n.includes('traverse') || n.includes('maktrav')) return 'traverse';
  if (n.includes('mariang makiling') || n.includes('maria makiling')) return 'mariang';
  if (n.includes('mud spring') || n.includes('mudspring')) return 'mudspring';
  if (n.includes('flat rock')) return 'flatrocks';
  return null;
}

const TRAIL_COLOR = '#ffb020';

/* Draws every trail line on a map. Each line is a white casing under a
   coloured stroke, which keeps it readable on both forest and cloud.
   colorFor(key) picks a line's colour (Trail Management colours by open or
   closed); onClick(key) makes the lines clickable. Returns the lines by key
   and highlight(key), which thickens one line and fades the rest. */
export async function addTrailLines(map, { colorFor, onClick } = {}) {
  const data = await loadTrailLines();
  const lines = new Map();
  const peaks = [];
  const group = L.layerGroup().addTo(map);

  // The traverse goes first, so the trails it shares a path with draw on top.
  const features = [...data.features].sort((a, b) =>
    (a.properties.key === 'traverse' ? -1 : 0) - (b.properties.key === 'traverse' ? -1 : 0));

  for (const feature of features) {
    const { key, name, kind, lengthKm, elevation } = feature.properties;
    if (feature.geometry.type === 'Point') {
      const [lng, lat] = feature.geometry.coordinates;
      peaks.push(L.circleMarker([lat, lng], {
        radius: 6, color: '#fff', weight: 2, fillColor: '#c8402f', fillOpacity: 1
      }).bindTooltip(`${name}${elevation ? ` · ${elevation}` : ''}`, { direction: 'top' }));
      continue;
    }
    const latLngs = feature.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    const color = colorFor?.(key) || TRAIL_COLOR;
    const side = kind === 'side';
    const casing = L.polyline(latLngs, {
      color: '#fff', weight: side ? 5 : 7, opacity: 0.85, interactive: false
    }).addTo(group);
    const stroke = L.polyline(latLngs, {
      color, weight: side ? 3 : 4, opacity: 1, dashArray: side ? '6 6' : null
    }).bindTooltip(`${name}${lengthKm ? ` · ${lengthKm} km` : ''}`, { sticky: true }).addTo(group);
    if (onClick) stroke.on('click', () => onClick(key));
    lines.set(key, { casing, stroke, side, name });
  }

  // Added after the lines so Peak 2 sits on top of the trails that end there.
  peaks.forEach((peak) => peak.addTo(group));

  map.attributionControl?.addAttribution('Trails &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors');

  function highlight(activeKey) {
    lines.forEach((line, key) => {
      const active = key === activeKey;
      const dim = activeKey && !active;
      line.casing.setStyle({ weight: active ? 10 : (line.side ? 5 : 7), opacity: dim ? 0.35 : 0.85 });
      line.stroke.setStyle({ weight: active ? 6 : (line.side ? 3 : 4), opacity: dim ? 0.45 : 1 });
      if (active) { line.casing.bringToFront(); line.stroke.bringToFront(); }
    });
    peaks.forEach((peak) => peak.bringToFront());
  }

  function recolor() {
    lines.forEach((line, key) => line.stroke.setStyle({ color: colorFor?.(key) || TRAIL_COLOR }));
  }

  return { lines, highlight, recolor, group };
}
