// map-features.js
// The GeoMap's reference layers, so everything its legend names is on the map:
//
//   Rivers / creeks   OpenStreetMap waterways inside the Mount Makiling
//                     Forest Reserve only (clipped to the reserve's OSM
//                     outline, saved as assets/data/makiling-reserve.geojson),
//                     in assets/data/makiling-waterways.geojson
//   Trail stations    the Firestore "stations", at their saved lat/lng, or
//                     at their estimated spot (STATION_COORDS in
//                     trail-stations.js) when none is saved yet; a trail
//                     with a reference list but no saved stations (Mariang
//                     Makiling, Sipit) shows its reference stations. From
//                     their tags come the facility markers:
//                       Monitoring Station  tag "registration" (where
//                                           rangers log hikers in and out)
//                       Food Station        tag "store"
//                       First Aid Station   tag "firstaid"
//
// Both data files were extracted once for the Mount Makiling box, like the
// trail lines (makiling-area.js), so the map does not depend on a live
// OpenStreetMap or elevation service.
//
// Leaflet is loaded as a classic deferred script, so the global `L` is ready.

import { collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { STATION_COORDS, TAGS, referenceDocs, referenceKeyFor } from "./trail-stations.js";
import { loadMapData } from "./map-data.js";
import { JUMP_OFFS } from "./makiling-area.js";


// Colours shared with the legend swatches in geomap.html; picked to read on
// the satellite imagery (dark forest green).
// The river symbol: the wave in the legend's River/Creek row and in each
// named river's label on the map, so the two look the same.
export const RIVER_WAVE = '<svg viewBox="0 0 24 10" aria-hidden="true"><path d="M1 7c4-5 8 2 12-2s7-3 10-1" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
export const WATER_COLOR = '#55b6ff';
// The river and creek lines on the satellite maps: stronger than
// WATER_COLOR (the legend swatch's light blue) so they stand out.
const RIVER_LINE_COLOR = '#1e88ff';

// Station tags that put a facility marker on the map, and its icon.
// Every station tag in Trail Station Management (TAGS in trail-stations.js)
// has one, so whatever is ticked on a station shows on its map badge; the
// GeoMap legend is built from this list too. A tag added to TAGS later
// shows with its own label and icon until it is given one here.
export const FACILITIES = [
  { tag: 'registration', label: 'Monitoring Station', icon: 'fa-tower-broadcast', color: '#1f3a28', hint: 'Stations tagged Monitoring station, where rangers log hikers in and out' },
  { tag: 'firstaid', label: 'First Aid Station', icon: 'fa-kit-medical', color: '#c8402f', hint: 'Stations tagged First aid' },
  { tag: 'store', label: 'Food Station', icon: 'fa-utensils', color: '#b9791b', hint: 'Stations tagged Food station' },
  { tag: 'water', label: 'Water Source', icon: 'fa-droplet', color: '#2a7fd0', hint: 'Stations tagged Water source' },
  { tag: 'sidetrip', label: 'Side Trip', icon: 'fa-signs-post', color: '#1f3a28', hint: 'Stations tagged Side trip' },
  { tag: 'steep', label: 'Steep / Roped Section', icon: 'fa-person-hiking', color: '#6b4cc9', hint: 'Stations tagged Steep / roped' },
  { tag: 'junction', label: 'Trail Junction', icon: 'fa-code-branch', color: '#1f3a28', hint: 'Stations tagged Trail junction' },
  { tag: 'peak', label: 'Summit', icon: 'fa-mountain', color: '#1f3a28', hint: 'Stations tagged Summit' }
];

// "campsite" is no longer a station tag (campsites are only the pins added
// with + Add Campsites); a station saved with it does not show it.
const CAMPSITE_TAG = 'campsite';

// The facilities of a station's tags, in FACILITIES order; unknown tags
// that TAGS knows come last with TAGS' label and icon.
function facilitiesOf(tags) {
  const known = FACILITIES.filter((f) => tags.includes(f.tag));
  const extra = tags
    .filter((tag) => tag !== CAMPSITE_TAG && !FACILITIES.some((f) => f.tag === tag) && TAGS[tag])
    .map((tag) => ({ tag, label: TAGS[tag].label, icon: TAGS[tag].icon, color: '#1f3a28' }));
  return [...known, ...extra];
}

const CSS = `
.mf-facility { display:grid; place-items:center; width:24px; height:24px; border-radius:50%;
  background:#fff; border:2px solid #1f3a28; box-shadow:0 1px 4px rgba(0,0,0,.4); }
.mf-facility i { font-size:11px; color:#1f3a28; }
.mf-facility.is-closed { opacity:.55; }
/* A station with several facilities: one badge, an icon for each. */
.mf-facilities { display:inline-flex; align-items:center; gap:3px; padding:2px; border-radius:16px;
  background:#fff; border:2px solid #1f3a28; box-shadow:0 1px 4px rgba(0,0,0,.4); transform:translate(-50%, -50%); }
.mf-facilities .mf-facility { width:20px; height:20px; border:0; box-shadow:none; }
.mf-facilities.is-closed { opacity:.55; }
.mf-popup .mf-tags { display:flex; flex-wrap:wrap; gap:4px; margin:4px 0; }
.mf-popup .mf-tags span { padding:1px 7px; border-radius:10px; background:#eef3ec; color:#1f3a28; font-size:11px; font-weight:600; }
.mf-popup .mf-tags i { margin-right:4px; }
.mf-popup { min-width:170px; font-size:12.5px; line-height:1.45; }
.mf-popup strong { display:block; font-size:13.5px; }
.mf-popup .mf-sub { color:#5b6b60; font-size:11.5px; margin-bottom:4px; }
.mf-popup .mf-coords { color:#93a199; font-size:11px; margin-top:4px; }
/* The station's number on its pin, as Trail Station Management numbers them:
   a plain station is a small numbered disc; a facility badge carries the
   number in a corner bubble. Closed ones are faded with a red ring. */
.mf-station { display:grid; place-items:center; width:20px; height:20px; border-radius:50%; box-sizing:border-box;
  background:#fff; border:2px solid #1f3a28; box-shadow:0 1px 3px rgba(0,0,0,.4);
  font:800 9.5px/1 system-ui, sans-serif; color:#1f3a28; }
.mf-station.is-closed { border-color:#c8402f; color:#c8402f; opacity:.75; }
.mf-num { position:absolute; top:-7px; right:-8px; min-width:15px; height:15px; padding:0 3px; box-sizing:border-box;
  display:grid; place-items:center; border-radius:8px; background:#1f3a28; color:#fff;
  font:800 9px/1 system-ui, sans-serif; border:1.5px solid #fff; }
.mf-facility, .mf-facilities { position:relative; }
.mf-facilities .mf-num { right:-9px; }
.is-closed > .mf-num, .mf-facility.is-closed .mf-num { background:#c8402f; }
.mf-popup .mf-head { display:flex; align-items:flex-start; gap:8px; }
.mf-popup .mf-badge { flex-shrink:0; display:grid; place-items:center; min-width:26px; height:26px; padding:0 5px;
  border-radius:13px; background:#1f3a28; color:#fff; font:800 12px/1 system-ui, sans-serif; box-sizing:border-box; }
.mf-popup .mf-state { display:inline-block; margin:2px 0 4px; padding:1px 8px; border-radius:10px; font-size:11px; font-weight:700; }
.mf-popup .mf-state.is-open { background:#e3f2e6; color:#1f6b39; }
.mf-popup .mf-state.is-closed { background:#fbe9e6; color:#b8392a; }
.mf-popup .mf-section { display:inline-block; margin:2px 0 4px 4px; padding:1px 8px; border-radius:10px;
  background:#eef1f8; color:#3c4a66; font-size:11px; font-weight:600; }
.mf-popup .mf-desc { margin-top:2px; }
.mf-river { display:inline-flex; align-items:center; gap:5px; padding:3px 8px 3px 6px; border-radius:20px;
  background:#fff; border:2px solid #2a7fd0; box-shadow:0 1px 4px rgba(0,0,0,.35); white-space:nowrap;
  font:600 11px/1.2 system-ui, sans-serif; color:#1d4f86; transform:translate(-50%, -50%); }
/* The same wave as the River/Creek row of the GeoMap legend. */
.mf-river svg { width:18px; height:8px; color:#2a7fd0; flex-shrink:0; }
`;

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));


/* ---- Which stations the map draws, and where ----
   Shared by the GeoMap (render below) and Trail Management's Total
   Checkpoints / Total Campsites (countMapPoints), so the totals always match
   what the map shows. */

const trailIdOf = (data) => data.trailID || data.TrailID || data.trailId;

// Where a station goes: its saved lat/lng, else its estimated spot from
// STATION_COORDS (marked estimated), else nowhere (null).
function stationPosition(data, trails) {
  const lat = Number(data.lat);
  const lng = Number(data.lng);
  // (Empty text reads as 0 in Number(): not a position.)
  if (data.lat != null && data.lng != null && data.lat !== '' && data.lng !== ''
    && Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)) {
    return { lat, lng, estimated: data.coordsEstimated === true };
  }
  const key = referenceKeyFor(trails.find((t) => t.id === data.trailID));
  const spot = key && STATION_COORDS[key]?.[Number(data.stationNumber)];
  return spot ? { lat: spot[0], lng: spot[1], estimated: true } : null;
}

/* The stations the map draws: the saved ones, plus the reference stations
   of any trail that has a reference list but nothing saved yet, each with
   its position. `stationDocs` are stations/{id} data, `trails` the
   trails/{id} documents (with id). */
export function mappedStations(stationDocs, trails) {
  const saved = stationDocs.map((data) => ({ ...data, trailID: trailIdOf(data) }));
  /* Exactly what Trail Station Management shows for each trail: its saved
     stations, or (a trail with none saved yet) its reference list. */
  const savedTrails = new Set(saved.map((data) => data.trailID));
  const unsaved = trails
    .filter((trail) => !savedTrails.has(trail.id) && referenceKeyFor(trail))
    .flatMap((trail) => referenceDocs(referenceKeyFor(trail), trail.id)
      .map((data) => ({ ...data, fromReference: true })));
  const entries = [...saved, ...unsaved]
    .map((data) => ({ data, position: stationPosition(data, trails) }));
  /* A station with no coordinates (added in Trail Station Management
     without a latitude and longitude) is still drawn: between the stations
     before and after it on the same trail, in step with its number, and
     marked estimated. One with no positioned station on either side has
     nowhere to go and is left out. */
  entries.filter((entry) => !entry.position).forEach((entry) => {
    const number = Number(entry.data.stationNumber);
    if (!Number.isFinite(number)) return;
    const siblings = entries.filter((other) => other.position && other !== entry
      && other.data.trailID === entry.data.trailID && Number.isFinite(Number(other.data.stationNumber)));
    const before = siblings.filter((o) => Number(o.data.stationNumber) < number)
      .sort((a, b) => Number(b.data.stationNumber) - Number(a.data.stationNumber))[0];
    const after = siblings.filter((o) => Number(o.data.stationNumber) > number)
      .sort((a, b) => Number(a.data.stationNumber) - Number(b.data.stationNumber))[0];
    if (before && after) {
      const n0 = Number(before.data.stationNumber);
      const n1 = Number(after.data.stationNumber);
      const t = (number - n0) / (n1 - n0);
      entry.position = {
        lat: before.position.lat + (after.position.lat - before.position.lat) * t,
        lng: before.position.lng + (after.position.lng - before.position.lng) * t,
        estimated: true
      };
      entry.why = `no coordinates: placed between Station ${n0} and Station ${n1}`;
      return;
    }
    // The first or last station (a neighbour on one side only): just beside
    // that neighbour, about 40 m along, so it is still on the map.
    const near = before || after;
    if (!near) return;
    entry.position = {
      lat: near.position.lat + (before ? 0.00035 : -0.00035),
      lng: near.position.lng,
      estimated: true
    };
    entry.why = `no coordinates: placed beside Station ${near.data.stationNumber}`;
  });
  // Said in the console, so a station that can't be placed exactly can be
  // found and given its coordinates in Trail Station Management.
  const unplaced = entries.filter((entry) => !entry.position || entry.why);
  if (unplaced.length) {
    console.info('Trail stations without saved coordinates (Trail Station Management):',
      unplaced.map((entry) => ({
        trail: trails.find((t) => t.id === entry.data.trailID)?.Trail || entry.data.trailID,
        station: entry.data.stationNumber,
        name: entry.data.landmark || entry.data.name || '',
        lat: entry.data.lat ?? null,
        lng: entry.data.lng ?? null,
        shown: entry.why || 'not shown: no other station on its trail has a position'
      })));
  }
  /* Two stations on (nearly) the same spot would hide one under the other:
     each later one is set a few metres off, round the first, so every
     station can be seen and clicked. */
  const placed = entries.filter((entry) => entry.position);
  placed.forEach((entry, i) => {
    const clash = placed.slice(0, i).filter((other) =>
      Math.abs(other.position.lat - entry.position.lat) < 0.00005
      && Math.abs(other.position.lng - entry.position.lng) < 0.00005).length;
    if (!clash) return;
    const angle = clash * 2.4;
    entry.position = {
      ...entry.position,
      lat: entry.position.lat + Math.sin(angle) * 0.00012,
      lng: entry.position.lng + Math.cos(angle) * 0.00012
    };
  });
  return placed;
}

// A checkpoint or campsite pin is drawn only with a valid lat/lng
// (trail-points.js render).
const hasPosition = (point) => Number.isFinite(Number(point?.lat)) && Number.isFinite(Number(point?.lng));

/* How many checkpoint and campsite pins the maps show: the pins added with
   + Add Checkpoints / + Add Campsites (and Suggested Checkpoints) that have
   a position. */
export function countMapPoints(trails) {
  const pins = (type) => trails.reduce((sum, trail) =>
    sum + (Array.isArray(trail[type]) ? trail[type].filter(hasPosition).length : 0), 0);
  return { checkpoints: pins('checkpoints'), campsites: pins('campsites') };
}

/*
  map           the Leaflet map
  db            Firestore
  trails        () => the trails/{id} documents (with id), for station
                popups and for trails whose stations are not saved yet
  stationsOnly  true for the Dashboard and Trail Management overviews: no
                rivers, and every station is the plain
                Trail Station dot rather than a facility badge
  Returns { waterways, stations } layer groups for a layers
  control, and render() to redraw the stations after the trail names change.
*/
export function addMapFeatures({ map, db, trails = () => [], stationsOnly = false }) {
  const trailById = (trailID) => trails().find((t) => t.id === trailID);
  const trailName = (trailID) => trailById(trailID)?.Trail || '';
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  // Water sits under the trail lines and markers.
  if (!map.getPane('mfBackdrop')) {
    map.createPane('mfBackdrop');
    map.getPane('mfBackdrop').style.zIndex = 350;
  }

  const waterways = L.layerGroup().addTo(map);
  const stations = L.layerGroup().addTo(map);

  // The rivers, from Firestore (settings/map) like the trail lines.
  if (!stationsOnly) loadMapData(JUMP_OFFS).then(({ waterways: data }) => {
    // Drawn like the trails, so they read on satellite imagery as they do
    // on the app's map: a white edge under a strong blue line, rivers wider
    // than creeks. The edge is drawn first and takes no clicks.
    L.geoJSON(data, {
      pane: 'mfBackdrop',
      interactive: false,
      style: (feature) => ({
        color: '#ffffff',
        weight: feature.properties.kind === 'river' ? 7 : 4.5,
        opacity: 0.7,
        lineCap: 'round',
        lineJoin: 'round'
      })
    }).addTo(waterways);
    L.geoJSON(data, {
      pane: 'mfBackdrop',
      style: (feature) => ({
        color: RIVER_LINE_COLOR,
        weight: feature.properties.kind === 'river' ? 4 : 2.5,
        opacity: 1,
        lineCap: 'round',
        lineJoin: 'round'
      }),
      onEachFeature: (feature, layer) => {
        const name = feature.properties.name || (feature.properties.kind === 'river' ? 'River' : 'Creek');
        layer.bindTooltip(escapeHtml(name), { sticky: true });
      }
    }).addTo(waterways);

    // A labelled marker on every named river and creek, at the middle of its
    // longest stretch, so they can be found at a glance.
    const lengthOf = (coords) => coords.reduce((sum, point, i) => (i
      ? sum + map.distance([coords[i - 1][1], coords[i - 1][0]], [point[1], point[0]]) : 0), 0);
    const longest = new Map(); // name -> { coords, length }
    data.features.forEach((feature) => {
      const name = feature.properties.name;
      if (!name) return;
      const coords = feature.geometry.coordinates;
      const length = lengthOf(coords);
      if (!longest.has(name) || length > longest.get(name).length) longest.set(name, { coords, length, kind: feature.properties.kind });
    });
    longest.forEach(({ coords, length, kind }, name) => {
      // The vertex halfway along the line.
      let walked = 0;
      let middle = coords[Math.floor(coords.length / 2)];
      for (let i = 1; i < coords.length; i += 1) {
        walked += map.distance([coords[i - 1][1], coords[i - 1][0]], [coords[i][1], coords[i][0]]);
        if (walked >= length / 2) { middle = coords[i]; break; }
      }
      L.marker([middle[1], middle[0]], {
        icon: L.divIcon({
          className: '',
          html: `<div class="mf-river">${RIVER_WAVE}${escapeHtml(name)}</div>`,
          iconSize: [0, 0]
        }),
        keyboard: false
      }).bindPopup(`<div class="mf-popup"><strong>${escapeHtml(name)}</strong>
        <div class="mf-sub">${kind === 'river' ? 'River' : 'Creek'} · OpenStreetMap</div>
        <div class="mf-coords">${middle[1].toFixed(5)}, ${middle[0].toFixed(5)}</div></div>`).addTo(waterways);
    });
  }).catch((error) => console.warn('Could not draw the rivers and creeks:', error.message));

  let stationDocs = [];
  // One facility: the round badge. Several (Agila Base is a monitoring,
  // first-aid and food stop): one pill with an icon for each, so none hides
  // another.
  const numTag = (number) => (number ? `<span class="mf-num">${number}</span>` : '');
  const facilityIcon = (facilities, open, number = '') => {
    const icons = facilities.map((f) => `<div class="mf-facility" title="${f.label}"><i class="fa-solid ${f.icon}" style="color:${f.color}" aria-hidden="true"></i></div>`).join('');
    if (facilities.length === 1) {
      return L.divIcon({
        className: '',
        html: `<div class="mf-facility${open ? '' : ' is-closed'}" title="${facilities[0].label}"><i class="fa-solid ${facilities[0].icon}" style="color:${facilities[0].color}" aria-hidden="true"></i>${numTag(number)}</div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12],
        popupAnchor: [0, -12]
      });
    }
    return L.divIcon({
      className: '',
      html: `<div class="mf-facilities${open ? '' : ' is-closed'}">${icons}${numTag(number)}</div>`,
      iconSize: [0, 0],
      popupAnchor: [0, -14]
    });
  };

  /* Everything Trail Station Management keeps on a station: its number (of
     how many on the trail), landmark, trail, section, open or closed,
     facilities, description and position (saved, or estimated). */
  function popupHtml(data, lat, lng, facilities, total = 0) {
    const number = Number(data.stationNumber) || '';
    const landmark = String(data.landmark || '').trim()
      || String(data.name || '').replace(/^station\s*\d+\s*[·:-]?\s*/i, '').trim();
    const open = !String(data.status ?? 'open').toLowerCase().startsWith('close');
    const firstAid = facilities.some((f) => f.tag === 'firstaid');
    const trail = trailName(data.trailID);
    return `<div class="mf-popup">
      <div class="mf-head">
        ${number ? `<span class="mf-badge" aria-hidden="true">${number}</span>` : ''}
        <div>
          <strong>${escapeHtml(landmark || `Station ${number}`)}</strong>
          <div class="mf-sub">Station ${number}${total ? ` of ${total}` : ''}${trail ? ` · ${escapeHtml(trail)}` : ''}</div>
        </div>
      </div>
      <span class="mf-state ${open ? 'is-open' : 'is-closed'}">${open ? 'Open' : 'Closed'}</span>${data.section ? `<span class="mf-section">${escapeHtml(data.section)}</span>` : ''}
      ${facilities.length ? `<div class="mf-tags">${facilities.map((f) => `<span><i class="fa-solid ${f.icon}" style="color:${f.color}" aria-hidden="true"></i>${escapeHtml(f.label)}</span>`).join('')}</div>` : ''}
      ${data.description
        ? `<div class="mf-desc">${escapeHtml(data.description)}</div>`
        : '<div class="mf-desc" style="color:#93a199">A numbered trail marker. No landmark has been recorded for this station.</div>'}
      ${firstAid && data.coordsEstimated ? '<div class="mf-coords">First aid from the rangers posted here; confirm with MCME.</div>' : ''}
      <div class="mf-coords">${lat.toFixed(5)}, ${lng.toFixed(5)}${data.coordsEstimated ? ' · estimated' : ''}</div>
      ${data.fromReference ? `<div class="mf-coords">From the trail's reference list (Trail Station Management shows it until the trail's stations are saved).</div>` : ''}
    </div>`;
  }

  function render() {
    stations.clearLayers();
    const mapped = mappedStations(stationDocs, trails());
    // How many stations each trail has, for "Station 11 of 30".
    const totals = new Map();
    mapped.forEach(({ data }) => totals.set(data.trailID, (totals.get(data.trailID) || 0) + 1));
    mapped.forEach(({ data, position }) => {
      const { lat, lng } = position;
      data = { ...data, coordsEstimated: position.estimated };
      const open = !String(data.status ?? 'open').toLowerCase().startsWith('close');
      const tags = Array.isArray(data.tags) ? data.tags : [];
      const facilities = facilitiesOf(tags);
      const number = Number(data.stationNumber) || '';
      // The GeoMap: every pin numbered, as in Trail Station Management. The
      // overview maps (stationsOnly) keep their plain dots.
      const marker = stationsOnly
        ? L.circleMarker([lat, lng], {
          radius: 5, color: '#1f3a28', weight: 2, fillColor: '#ffffff', fillOpacity: open ? 1 : 0.5
        })
        : facilities.length
          ? L.marker([lat, lng], { icon: facilityIcon(facilities, open, number), zIndexOffset: 200 })
          : L.marker([lat, lng], {
            icon: L.divIcon({
              className: '',
              html: `<div class="mf-station${open ? '' : ' is-closed'}">${number}</div>`,
              iconSize: [20, 20],
              iconAnchor: [10, 10],
              popupAnchor: [0, -10]
            }),
            zIndexOffset: 150,
            title: `Station ${number}${data.landmark ? ` · ${data.landmark}` : ''}`
          });
      marker.bindPopup(popupHtml(data, lat, lng, facilities, totals.get(data.trailID) || 0)).addTo(stations);
    });
  }

  onSnapshot(collection(db, 'stations'), (snapshot) => {
    stationDocs = snapshot.docs.map((d) => d.data());
    render();
  }, (error) => console.warn('Could not load the trail stations:', error.message));

  return { waterways, stations, render };
}
