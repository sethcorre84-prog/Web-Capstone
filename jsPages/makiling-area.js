// makiling-area.js
// The one definition of "Mount Makiling" for every map in the portal: a 6 km
// radius around the summit. geomap.html and dashboard.html both build their
// maps from this, so they can never disagree on where the mountain ends.
//
// Leaflet is loaded as a classic deferred script, which runs before the
// pages' module scripts, so the global `L` is ready whenever this is called.

import { db } from './firebase-config.js';
import { loadMapData } from './map-data.js';
import { collection, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

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

/* A Mount Makiling map only, shown as a plain rectangle: the box around the
   6 km area (the same box as MAKILING_BOUNDS). Imagery is loaded only inside
   it, panning is locked to it, and the map can never zoom out past the
   point where its whole view is inside the box, so the map is always filled
   with the mountain and nothing beyond it. Returns the map, the locked
   bounds, which pages use to keep markers and views inside the mountain,
   and trailLines, a promise of what addTrailLines returns.
   `trailLineOptions` is passed to addTrailLines (colorFor / onClick).
   `center` is where the map opens (and recentres when a resize forces it
   out to a wider zoom); the middle of the area by default. */
export const PEAK_2 = [14.13574, 121.19387];

export function createMakilingMap(element, { trailLineOptions, center = MAKILING_CENTER } = {}) {
  const bounds = L.latLngBounds(MAKILING_RING);

  const map = L.map(element, {
    center: MAKILING_CENTER,
    zoom: 13,
    minZoom: 13,
    maxZoom: 19,
    maxBounds: bounds,
    maxBoundsViscosity: 1
  });
  addSatelliteLayer(map, { minZoom: 12, bounds });

  /* The furthest out the map may zoom: where its view just fits inside the
     box. It depends on the map's size on screen, so it is worked out again
     whenever the map is resized (the pages already tell Leaflet when that
     happens). A map with no size yet (a hidden tab) keeps the default. */
  const fitBox = () => {
    const size = map.getSize();
    if (!size.x || !size.y) return;
    const fill = map.getBoundsZoom(bounds, true);
    map.setMinZoom(fill);
    if (map.getZoom() < fill) map.setView(center, fill, { animate: false });
  };
  fitBox();
  map.setView(center, map.getMinZoom(), { animate: false });
  map.on('resize', fitBox);

  // Every Mount Makiling map shows the trails. A missing file only costs
  // the lines, never the map.
  const trailLines = addTrailLines(map, trailLineOptions).catch((error) => {
    console.warn('Could not draw the trail lines:', error.message);
    return null;
  });

  return { map, bounds, trailLines };
}

/* ---- Trail lines ----
   The trails themselves, drawn over the satellite imagery: Mariang Makiling,
   Sipit, the Makiling Traverse and the Mud Spring and Flat Rocks side trails.
   The lines are OpenStreetMap data, kept in Firestore (settings/map,
   map-data.js) so the app draws the same and follows any change; the copy
   in assets/data/makiling-trails.geojson (see its "attribution") is the
   starting point and the fallback. The Botanic Gardens trail is not mapped
   in OSM, so it has no line. */
export function loadTrailLines() {
  return loadMapData(JUMP_OFFS).then((data) => data.trails);
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

/* ---- Routes saved on trails ----
   A trail added in Trail Management has no line in the file above, so it can
   carry its own: trails/{id}.route, a list of { lat, lng } points drawn there
   (Draw Route) or imported from a GPS recording (trail-routes.js). Every map
   draws these with the file's lines, live; a route on one of the file's
   trails replaces that trail's file line. */
export const validRoute = (route) => Array.isArray(route)
  && route.filter((p) => Number.isFinite(Number(p?.lat)) && Number.isFinite(Number(p?.lng))).length >= 2;

// The key a trail's line is filed under in `lines`: its own route if it has
// one, else the file line its name matches (or null).
export const lineKeyFor = (trail) => (validRoute(trail?.route) ? `trail:${trail.id}` : trailLineKey(trail?.Trail));

// The trail behind a key from lineKeyFor (or from the file), among `trails`.
export const trailForLineKey = (trails, key) => {
  if (!key) return null;
  if (key.startsWith('trail:')) return trails.find((t) => t.id === key.slice(6)) || null;
  return trails.find((t) => !validRoute(t.route) && trailLineKey(t.Trail) === key) || null;
};

/* Where a trail starts, as [lat, lng]: the first point of its saved route
   (drawn or recorded from the trailhead), or the end of its file line where
   the hike begins (the registration or jump-off below; for any other line,
   the end farther from the summit). `latLngs` are the points of the line it
   is drawn with. Null when it has neither. */
const KNOWN_STARTS = {
  mariang: [14.156768816265368, 121.23416031455696], // its registration (JUMP_OFFS), where its line now starts
  sipit: [14.0995828, 121.1957954], // Sto. Tomas City Eco Park, where its line now starts (JUMP_OFFS)
  traverse: [14.099953324593944, 121.19592880324568] // MakTrav jump-off, Sipit side (JUMP_OFFS)
};
export function trailStart(trail, latLngs) {
  if (validRoute(trail?.route)) {
    const first = trail.route.find((p) => Number.isFinite(Number(p?.lat)) && Number.isFinite(Number(p?.lng)));
    return [Number(first.lat), Number(first.lng)];
  }
  if (!latLngs?.length) return null;
  const first = L.latLng(latLngs[0]);
  const last = L.latLng(latLngs[latLngs.length - 1]);
  const known = KNOWN_STARTS[trailLineKey(trail?.Trail)];
  const end = known
    ? (L.latLng(known).distanceTo(first) <= L.latLng(known).distanceTo(last) ? first : last)
    : (L.latLng(PEAK_2).distanceTo(first) >= L.latLng(PEAK_2).distanceTo(last) ? first : last);
  return [end.lat, end.lng];
}

const routeLength = (latLngs) => latLngs.reduce((sum, point, i) => (i
  ? sum + L.latLng(latLngs[i - 1]).distanceTo(point) : 0), 0);

const TRAIL_COLOR = '#2f8f4e';
const CLOSED_COLOR = '#c8402f';
// Side trails (Mud Spring, Flat Rocks): yellow, like the maps' legends.
const SIDE_TRAIL_COLOR = '#ffb020';

/* The summit badge: the same white disc, dark green ring and mountain icon
   as the GeoMap's Summit station marker (.mf-facility in map-features.js),
   styled inline so every map shows it without map-features.js loaded. */
const PEAK_ICON_HTML = '<div style="display:grid;place-items:center;width:24px;height:24px;'
  + 'border-radius:50%;background:#fff;border:2px solid #1f3a28;box-shadow:0 1px 4px rgba(0,0,0,.4);'
  + 'box-sizing:border-box"><i class="fa-solid fa-mountain" style="font-size:11px;color:#1f3a28" aria-hidden="true"></i></div>';

// The road from the Sto. Tomas City Eco Park to where it meets the Sipit
// Trail (the trail's first point), traced along OpenStreetMap's roads
// (about 1.4 km; the park sits ~50 m off the road). Both Sto. Tomas
// jump-offs use it.
const ECO_PARK_ROAD = [
  [14.100001, 121.195769], [14.100014, 121.195683], [14.100016, 121.195577], [14.100011, 121.195453],
  [14.100034, 121.19529], [14.100063, 121.195243], [14.100132, 121.195203], [14.100208, 121.195162],
  [14.100405, 121.195054], [14.100517, 121.194999], [14.100653, 121.194963], [14.100824, 121.19494],
  [14.100998, 121.194941], [14.101146, 121.19492], [14.101299, 121.194845], [14.101374, 121.194823],
  [14.101493, 121.19475], [14.101612, 121.19463], [14.101745, 121.194484], [14.101923, 121.194362],
  [14.102024, 121.194257], [14.10213, 121.194147], [14.102273, 121.194017], [14.102386, 121.193939],
  [14.102482, 121.193886], [14.102578, 121.193856], [14.10264, 121.193848], [14.102669, 121.193844],
  [14.102722, 121.193832], [14.102816, 121.19381], [14.10284, 121.193786], [14.102877, 121.193723],
  [14.102908, 121.193656], [14.10291, 121.193577], [14.102782, 121.19337], [14.10269, 121.193165],
  [14.102584, 121.192886], [14.102499, 121.192654], [14.102404, 121.192392], [14.102248, 121.191943],
  [14.102104, 121.191536], [14.102109, 121.1914], [14.102176, 121.191256], [14.102289, 121.191128],
  [14.102474, 121.190906], [14.102652, 121.190595], [14.102661, 121.190536], [14.102673, 121.190458],
  [14.102635, 121.190277], [14.102593, 121.19006], [14.102583, 121.189787], [14.102594, 121.189426],
  [14.102602, 121.189339], [14.10261, 121.189255], [14.102625, 121.189093], [14.102689, 121.188873],
  [14.102707, 121.188747], [14.102759, 121.188698], [14.102828, 121.18866], [14.102934, 121.188646],
  [14.103048, 121.188647], [14.103157, 121.188656], [14.103913, 121.188744], [14.104252, 121.188735],
  [14.104357, 121.188757], [14.104457, 121.188751], [14.104543, 121.18872], [14.104644, 121.188673],
  [14.104917, 121.188632], [14.105379, 121.188562], [14.106425, 121.188262]
];

// The road from the Mariang Makiling Trail's registration (UPLB, Los Baños)
// to the trail's first point, along OpenStreetMap's roads (Domingo M.
// Lantican Avenue and Makiling Road, about 750 m).
const UPLB_ROAD = [
  [14.156628, 121.234074], [14.156535, 121.234225], [14.156465, 121.234336], [14.156357, 121.23451],
  [14.156239, 121.234691], [14.156079, 121.234912], [14.155818, 121.235221], [14.155786, 121.235199],
  [14.155369, 121.234908], [14.155309, 121.2349], [14.155131, 121.234748], [14.155, 121.234616],
  [14.154886, 121.234533], [14.154822, 121.234516], [14.154694, 121.234547], [14.154412, 121.234932],
  [14.154326, 121.235049], [14.154253, 121.235039], [14.154086, 121.234976], [14.153739, 121.234813],
  [14.153605, 121.23478], [14.153465, 121.23478], [14.153233, 121.23494], [14.152781, 121.234586],
  [14.152486, 121.23436], [14.152318, 121.234242], [14.152157, 121.234122], [14.151924, 121.234026],
  [14.151828, 121.233975], [14.151728, 121.233935], [14.151677, 121.233914], [14.151518, 121.233849],
  [14.151325, 121.233755]
];

/* Jump-off and registration points shown on every map (with the summit, as
   markers above the lines). The Sto. Tomas City Eco Park is where hikers
   register for the Sipit Trail; its location was taken from Google Maps, as
   the park is not mapped in OpenStreetMap. */
export const JUMP_OFFS = [
  {
    name: 'Sto. Tomas City Eco Park',
    role: 'Sipit Trail jump-off & registration',
    // The trail line it leads to, and the way there (ECO_PARK_ROAD);
    // addTrailLines makes it the start of the trail's own line.
    connectsTo: 'sipit',
    approach: ECO_PARK_ROAD,
    // The barangay is left out: OpenStreetMap puts this spot in Santa Elena,
    // next to San Vicente, so it isn't certain.
    place: 'City of Sto. Tomas, Batangas',
    // Pinned by the admin from Google Maps (the park's own location).
    latLng: [14.0995828, 121.1957954]
  },
  {
    // The Makiling Traverse starts on the Sipit side: from here, along the
    // same road and up the Sipit Trail to Station 9, where the traverse line
    // takes its own way over the summit to Los Baños. (OpenStreetMap's line
    // started on the old Palanggana trail, now closed; the file's traverse
    // line was rerouted up the Sipit Trail.)
    name: 'MakTrav jump-off (Sipit side)',
    role: 'Makiling Traverse jump-off & registration, Sto. Tomas side',
    connectsTo: 'traverse',
    approach: ECO_PARK_ROAD,
    place: 'City of Sto. Tomas, Batangas',
    // Pinned by the admin.
    latLng: [14.099953324593944, 121.19592880324568]
  },
  {
    // Where hikers register before the Mariang Makiling Trail, on the
    // Los Baños side; the road from here leads to the trail's start.
    name: 'Mariang Makiling Trail registration',
    role: 'Mariang Makiling Trail entrance & registration',
    connectsTo: 'mariang',
    approach: UPLB_ROAD,
    place: 'Los Baños, Laguna',
    // Pinned by the admin.
    latLng: [14.156768816265368, 121.23416031455696]
  }
];
const JUMP_OFF_ICON_HTML = '<div style="display:grid;place-items:center;width:26px;height:26px;'
  + 'border-radius:50%;background:#2f8f4e;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.45);'
  + 'box-sizing:border-box"><i class="fa-solid fa-clipboard-check" style="font-size:12px;color:#fff" aria-hidden="true"></i></div>';
const escapeText = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

/* Draws every trail line on a map. Each line is a white casing under a
   coloured stroke, which keeps it readable on both forest and cloud.
   colorFor(key) picks a line's colour (Trail Management colours by open or
   closed); onClick(key) makes the lines clickable. Returns the lines by key
   and highlight(key), which thickens one line and fades the rest. */
export async function addTrailLines(map, { colorFor, onClick } = {}) {
  // A file that will not load costs only its own lines: the routes saved on
  // trails are still drawn.
  const mapData = await loadMapData(JUMP_OFFS).catch((error) => {
    console.warn('Could not load the trail lines:', error.message);
    return { trails: { features: [] }, jumpOffs: JUMP_OFFS };
  });
  const data = mapData.trails;
  // The jump-offs as stored (settings/map), or the built-in list.
  const jumpOffs = Array.isArray(mapData.jumpOffs) ? mapData.jumpOffs : JUMP_OFFS;
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
      peaks.push(L.marker([lat, lng], {
        icon: L.divIcon({ className: '', html: PEAK_ICON_HTML, iconSize: [24, 24], iconAnchor: [12, 12] }),
        title: name,
        keyboard: false
      }).bindTooltip(`${name}${elevation ? ` · ${elevation}` : ''}`, { direction: 'top', offset: [0, -12] }));
      continue;
    }
    let latLngs = feature.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    // A trail reached from a jump-off (the Sipit Trail from the Sto. Tomas
    // City Eco Park): the road from the park becomes the start of the same
    // line, so park, road and trail are one unbroken line with no join.
    const spot = jumpOffs.find((item) => item.connectsTo === key && item.approach?.length);
    if (spot) {
      const here = L.latLng(spot.latLng);
      if (here.distanceTo(latLngs[latLngs.length - 1]) < here.distanceTo(latLngs[0])) latLngs = latLngs.reverse();
      // The road's last point is the trail's first: kept once.
      latLngs = [spot.latLng, ...spot.approach.slice(0, -1), ...latLngs];
    }
    const side = kind === 'side';
    const color = colorFor?.(key) || (side ? SIDE_TRAIL_COLOR : TRAIL_COLOR);
    const casing = L.polyline(latLngs, {
      color: '#fff', weight: side ? 5 : 7, opacity: 0.85, interactive: false
    }).addTo(group);
    const stroke = L.polyline(latLngs, {
      color, weight: side ? 3 : 4, opacity: 1, dashArray: side ? '6 6' : null
    }).bindTooltip(`${name}${lengthKm ? ` · ${lengthKm} km` : ''}`, { sticky: true }).addTo(group);
    if (onClick) stroke.on('click', () => onClick(key));
    lines.set(key, { casing, stroke, side, name });
  }

  // The jump-off / registration points, with the peaks above every line.
  jumpOffs.filter((spot) => Array.isArray(spot?.latLng)).forEach((spot) => {
    peaks.push(L.marker(spot.latLng, {
      icon: L.divIcon({ className: '', html: JUMP_OFF_ICON_HTML, iconSize: [26, 26], iconAnchor: [13, 13], popupAnchor: [0, -14] }),
      title: `${spot.name} (${spot.role})`,
      keyboard: false,
      zIndexOffset: 400
    })
      .bindTooltip(`${escapeText(spot.name)} · ${escapeText(spot.role)}`, { direction: 'top', offset: [0, -13] })
      .bindPopup(`<strong>${escapeText(spot.name)}</strong><br>${escapeText(spot.role)}<br><small>${escapeText(spot.place)}</small>`));
  });

  // Markers draw above every line, so Peak 2 sits on top of the trails that
  // end there.
  peaks.forEach((peak) => peak.addTo(group));

  map.attributionControl?.addAttribution('Trails &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors');

  // The file's lines, kept so one can come back when a route replacing it
  // is removed.
  const fileLines = new Map(lines);
  let routeKeys = [];
  let activeKey = null;

  // A saved route's own colour when the page does not choose one (Dashboard,
  // Emergency): its trail's status, red when closed, as GeoMap shows it.
  const statusColor = (trail) => (String(trail?.Status || 'Open').toLowerCase().startsWith('close')
    ? CLOSED_COLOR : TRAIL_COLOR);

  function drawLine(key, latLngs, { side, name, color, tooltip, trail = null }) {
    const casing = L.polyline(latLngs, {
      color: '#fff', weight: side ? 5 : 7, opacity: 0.85, interactive: false
    }).addTo(group);
    const stroke = L.polyline(latLngs, {
      color, weight: side ? 3 : 4, opacity: 1, dashArray: side ? '6 6' : null
    }).bindTooltip(tooltip, { sticky: true }).addTo(group);
    if (onClick) stroke.on('click', () => onClick(key));
    lines.set(key, { casing, stroke, side, name, trail });
  }

  // Redraws the saved routes from the trails collection.
  function setRoutes(trails) {
    routeKeys.forEach((key) => {
      const line = lines.get(key);
      if (line) { group.removeLayer(line.casing); group.removeLayer(line.stroke); }
      lines.delete(key);
    });
    routeKeys = [];
    // Every file line back in place, then the ones a route replaces taken out.
    fileLines.forEach((line, key) => {
      if (!lines.has(key)) {
        line.casing.addTo(group);
        line.stroke.addTo(group);
        lines.set(key, line);
      }
    });
    trails.filter((trail) => validRoute(trail.route)).forEach((trail) => {
      const replaced = trailLineKey(trail.Trail);
      if (replaced && lines.has(replaced) && fileLines.has(replaced)) {
        const line = lines.get(replaced);
        group.removeLayer(line.casing);
        group.removeLayer(line.stroke);
        lines.delete(replaced);
      }
      const key = `trail:${trail.id}`;
      const latLngs = trail.route
        .map((p) => [Number(p.lat), Number(p.lng)])
        .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));
      const name = trail.Trail || 'Trail';
      const km = (routeLength(latLngs) / 1000).toFixed(1);
      drawLine(key, latLngs, {
        side: false,
        name,
        color: colorFor?.(key) || statusColor(trail),
        tooltip: `${name} · ${km} km`,
        trail
      });
      routeKeys.push(key);
    });
    // The summit badge stays above every line.
    peaks.forEach((peak) => { group.removeLayer(peak); peak.addTo(group); });
    if (activeKey) highlight(activeKey);
    changeListeners.forEach((listener) => listener());
  }

  const changeListeners = new Set();
  onSnapshot(collection(db, 'trails'), (snapshot) => {
    setRoutes(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
  }, (error) => console.warn('Could not load the saved trail routes:', error.message));

  function highlight(key) {
    activeKey = key;
    lines.forEach((line, lineKey) => {
      const active = lineKey === key;
      const dim = key && !active;
      line.casing.setStyle({ weight: active ? 10 : (line.side ? 5 : 7), opacity: dim ? 0.35 : 0.85 });
      line.stroke.setStyle({ weight: active ? 6 : (line.side ? 3 : 4), opacity: dim ? 0.45 : 1 });
      if (active) { line.casing.bringToFront(); line.stroke.bringToFront(); }
    });
  }

  function recolor() {
    lines.forEach((line, key) => {
      const color = colorFor?.(key) || (line.trail ? statusColor(line.trail) : (line.side ? SIDE_TRAIL_COLOR : TRAIL_COLOR));
      line.stroke.setStyle({ color });
    });
  }

  // onChange(listener): called after the saved routes are redrawn.
  const onChange = (listener) => { changeListeners.add(listener); return () => changeListeners.delete(listener); };

  return { lines, highlight, recolor, group, onChange };
}
