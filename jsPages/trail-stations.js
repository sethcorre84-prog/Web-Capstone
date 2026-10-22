// trail-stations.js
// The Trail Stations panel on Trail Management (trail.html): the numbered
// checkpoints along a trail, read from the Firestore "stations" collection,
// the same documents the mobile app lists on a trail's page
// (lib/features/trails/station_service.dart in the app repo).
//
// Until a trail's stations are saved there, the panel shows the reference
// list below and offers to save it. The reference was put together from
// hiker reports and the Makiling Center for Mountain Ecosystems (MCME) in
// October 2026. Only stations those sources name are described; the rest are
// plain numbered markers. Check it against MCME's own trail map before
// relying on it for safety.
//
// Sources:
//   https://makiling.center/places-in-mount-makiling/
//   https://www.pinoymountaineer.com/2009/12/maktrav-mt-makilingsto-tomas-los-banos.html
//   https://www.pinoymountaineer.com/2013/05/hiking-matters-342-mt-makiling-via.html
//   https://www.pinoymountaineer.com/2014/02/hiking-matters-390-makiling-traverse.html
//   https://lakbaypinas.com/guide-to-mt-makiling-2025-uplb-trail-or-maktrav/
//   https://www.jovialwanderer.com/2025/06/holy-week-hike-2025-mt-makiling-via.html
//   https://mountaintipsandtops.wordpress.com/2014/03/18/mt-makiling-traverse-dayhike-via-sipit-trail/

import {
  collection,
  doc,
  onSnapshot,
  serverTimestamp,
  writeBatch
} from "./firestore-tracked.js";

// Tag -> label and icon (Font Awesome), shown on landmark stations and as
// the station badges on the GeoMap (map-features.js). The keys are what is
// saved on a station, so they stay as they are: "registration" is shown as
// Monitoring station (where rangers log hikers in and out) and "store" as
// Food station.
export const TAGS = {
  registration: { label: 'Monitoring station', icon: 'fa-tower-broadcast' },
  store: { label: 'Food station', icon: 'fa-utensils' },
  water: { label: 'Water source', icon: 'fa-droplet' },
  firstaid: { label: 'First aid', icon: 'fa-kit-medical' },
  sidetrip: { label: 'Side trip', icon: 'fa-signs-post' },
  steep: { label: 'Steep / roped', icon: 'fa-person-hiking' },
  junction: { label: 'Trail junction', icon: 'fa-code-branch' },
  peak: { label: 'Summit', icon: 'fa-mountain' }
};

export const REFERENCE_STATIONS = {
  mariang: {
    title: 'Mariang Makiling Trail',
    count: 30,
    summary: 'About 8 km from the MCME office in Los Baños (Station 1) to Peak 2 (Station 30, 1,090 MASL).',
    sections: [
      { from: 1, to: 11, label: 'Concrete road', note: 'About 5.4 km of steep paved road' },
      { from: 12, to: 30, label: 'Forest trail', note: 'Muddy, root-covered trail to Peak 2' }
    ],
    stations: {
      // Stations 1 and 11 are the ranger posts where hikers log in; they are
      // marked first aid because the rangers there are the trail's first
      // responders. No source lists official first-aid stations, so confirm
      // with MCME.
      1: { landmark: 'Trailhead', tags: ['registration', 'firstaid', 'sidetrip'],
        description: 'Official start of the trail, near the Makiling Center for Mountain Ecosystems (MCME) office. Flat Rocks, natural pools on Molawin Creek, is a few hundred meters away.' },
      7: { landmark: 'Rest stop', tags: ['store'],
        description: 'Stores and buko stalls along the road; a common rest stop.' },
      8: { landmark: 'Mud Spring jump-off', tags: ['sidetrip'],
        description: 'Jump-off to the Mud Spring, volcanic mud pots about 690 m off the trail. Tayabak Campsite is around here.' },
      11: { landmark: 'Agila Base', tags: ['registration', 'firstaid', 'water', 'store'],
        description: 'End of the concrete road. Hikers log in again before entering the forest; natural water refill and occasional vendors. Rangers enforce the morning cut-off for continuing to the peak here.' },
      12: { landmark: 'Forest entry', tags: [],
        description: 'Start of the forest trail toward Malaboo.' },
      14: { landmark: 'Malaboo Campsite', tags: [],
        description: 'Malaboo Campsite (Stations 13 to 14). Rafflesia buds have been seen around here.' },
      20: { landmark: 'Steeper section', tags: ['steep'],
        description: 'The trail becomes noticeably steeper from here on.' },
      26: { landmark: 'Landslide area', tags: [],
        description: 'Start of a major landslide section; watch the footing.' },
      28: { landmark: 'Roped segments', tags: ['steep'],
        description: 'Roped sections on the final climb.' },
      30: { landmark: 'Peak 2', tags: ['peak'],
        description: 'Summit, 1,090 MASL, with a small metal viewing deck. End of the trail.' }
    }
  },
  sipit: {
    title: 'Sipit Trail',
    count: 21,
    summary: 'The Sto. Tomas, Batangas route up Mt. Makiling, through Melkas Ridge. It is the ascent side of the Makiling Traverse.',
    sections: [
      { from: 1, to: 3, label: 'Lower trail', note: 'Gradual, past the Kambingan water source' },
      { from: 4, to: 15, label: 'Steep climb to Melkas', note: 'Steep, roped sections up to Melkas Campsite' },
      { from: 16, to: 21, label: 'Ridge and upper trail', note: 'Past Haring Bato along the ridge' }
    ],
    stations: {
      1: { landmark: 'Eroded river', tags: [],
        description: 'First station, beside an eroded river past the Sto. Tomas jump-off.' },
      2: { landmark: 'Kambingan', tags: ['water'],
        description: 'Water source, about 30 minutes from the trailhead.' },
      4: { landmark: 'Start of the steep climb', tags: ['steep'],
        description: 'About 812 MASL by one hiker\'s reading. Concrete marker and yellow ribbon; the steep, roped climb starts here.' },
      7: { landmark: 'Palanggana junction', tags: ['junction'],
        description: 'Where the Sipit Trail meets the old Palanggana / San Bartolome trail, now closed.' },
      11: { landmark: 'End of the steepest part', tags: ['steep'],
        description: 'The steepest section ends; the trail continues to Melkas Campsite.' },
      15: { landmark: 'Melkas Campsite', tags: [],
        description: 'Melkas Ridge (Gubatan) campsite. Haring Bato, the towering rock where Melkas Ridge begins, is less than 10 minutes away.' },
      21: { landmark: 'Trail levels off', tags: [],
        description: 'The trail loses elevation and flattens out here, but there are still many roots and branches to watch for.' }
    }
  }
};


/* Estimated [latitude, longitude] of every reference station. No official
   list of station coordinates exists, so each station is placed along its
   trail's OpenStreetMap line (assets/data/makiling-trails.geojson), with the
   landmarks the sources pin down used as anchors and the stations between
   two anchors spaced evenly along the line:
     Mariang Makiling  1  where the Flat Rocks side trail meets the road,
                          by the MCME office (the trailhead)
                       8  where the Mud Spring side trail leaves the road
                      11  Agila Base, 5.4 km of road after Station 1 (the
                          concrete-road length the sources give)
                      30  Peak 2, the end of the line
     Sipit             1  150 m past the Sto. Tomas jump-off (the start of
                          the line); 21 at Peak 2, the end of the line
   Expect them to be off by up to a few hundred metres; replace any with a
   GPS reading taken at the marker (Trail Station Management). */
export const STATION_COORDS = {
  mariang: {
    1: [14.14814, 121.23185], 2: [14.145695, 121.23042], 3: [14.143921, 121.232058],
    4: [14.141533, 121.229972], 5: [14.139733, 121.230711], 6: [14.137916, 121.23034],
    7: [14.135944, 121.229063], 8: [14.1358, 121.22573], 9: [14.131933, 121.219781],
    10: [14.129922, 121.212583], 11: [14.132792, 121.208493], 12: [14.133768, 121.20792],
    13: [14.134999, 121.207767], 14: [14.1356, 121.206861], 15: [14.136559, 121.205869],
    16: [14.137726, 121.205396], 17: [14.138667, 121.204845], 18: [14.138445, 121.203696],
    19: [14.137375, 121.202754], 20: [14.136851, 121.201577], 21: [14.13737, 121.201344],
    22: [14.1382, 121.201418], 23: [14.138841, 121.200423], 24: [14.138608, 121.199237],
    25: [14.138996, 121.198965], 26: [14.138217, 121.197868], 27: [14.137965, 121.196808],
    28: [14.136691, 121.196247], 29: [14.135815, 121.195149], 30: [14.13574, 121.19387]
  },
  sipit: {
    1: [14.107584, 121.187988], 2: [14.109588, 121.187099], 3: [14.111757, 121.186862],
    4: [14.113844, 121.187294], 5: [14.115493, 121.186152], 6: [14.117606, 121.185981],
    7: [14.119641, 121.186052], 8: [14.119928, 121.184158], 9: [14.121195, 121.182925],
    10: [14.122601, 121.18444], 11: [14.124765, 121.184548], 12: [14.126518, 121.185959],
    13: [14.128397, 121.187002], 14: [14.12989, 121.186645], 15: [14.130857, 121.184749],
    16: [14.132523, 121.184455], 17: [14.134333, 121.185363], 18: [14.134294, 121.187646],
    19: [14.1349, 121.189578], 20: [14.1353, 121.191634], 21: [14.13574, 121.19387]
  }
};

const normalize = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();

// Which reference list fits a trail document, by its name.
export function referenceKeyFor(trail) {
  const name = normalize(trail?.Trail);
  if (name.includes('sipit')) return 'sipit';
  if (name.includes('mariang makiling') || name.includes('maria makiling')) return 'mariang';
  return null;
}

const isTraverse = (trail) => /traverse|maktrav/.test(normalize(trail?.Trail));

// The reference stations as the documents the app reads (see the field list
// in station_service.dart): name, stationNumber, description, status.
// landmark/tags/section and lat/lng (with coordsEstimated: true, see
// STATION_COORDS) are extra and ignored by the app.
export function referenceDocs(key, trailID) {
  const ref = REFERENCE_STATIONS[key];
  const docs = [];
  for (let n = 1; n <= ref.count; n += 1) {
    const info = ref.stations[n] || {};
    const section = ref.sections.find((s) => n >= s.from && n <= s.to);
    const [lat, lng] = STATION_COORDS[key]?.[n] || [null, null];
    docs.push({
      trailID,
      stationNumber: n,
      name: info.landmark ? `Station ${n} · ${info.landmark}` : `Station ${n}`,
      landmark: info.landmark || '',
      description: info.description || '',
      tags: info.tags || [],
      section: section ? section.label : '',
      status: 'open',
      lat,
      lng,
      coordsEstimated: lat !== null
    });
  }
  return docs;
}

// A stored station document -> the shape the panel draws.
function fromStored(data) {
  const number = Number(data.stationNumber) || Number(String(data.name || '').match(/\d+/)?.[0]) || 0;
  const name = String(data.name || `Station ${number}`);
  // "Station 11 · Agila Base" -> "Agila Base"; a bare "Station 5" -> "".
  const landmark = data.landmark || name.replace(/^station\s*\d+\s*[·:-]?\s*/i, '');
  return {
    number,
    landmark,
    description: data.description || '',
    tags: Array.isArray(data.tags) ? data.tags.filter((t) => TAGS[t]) : [],
    section: data.section || '',
    open: !String(data.status ?? 'open').toLowerCase().startsWith('close'),
    lat: Number.isFinite(Number(data.lat)) && data.lat !== null ? Number(data.lat) : null,
    lng: Number.isFinite(Number(data.lng)) && data.lng !== null ? Number(data.lng) : null,
    coordsEstimated: data.coordsEstimated === true
  };
}

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

export function initStationsPanel({ db, root, onSelectTrail, onSelectStation }) {
  const stationsByTrail = new Map();
  let loaded = false;
  let currentTrail = null;
  let allTrails = [];
  let activeNumber = null;
  let saving = false;

  onSnapshot(collection(db, 'stations'), (snapshot) => {
    stationsByTrail.clear();
    snapshot.docs.forEach((d) => {
      const data = d.data();
      const trailID = data.trailID || data.TrailID || data.trailId;
      if (!trailID) return;
      if (!stationsByTrail.has(trailID)) stationsByTrail.set(trailID, []);
      stationsByTrail.get(trailID).push(fromStored(data));
    });
    stationsByTrail.forEach((list) => list.sort((a, b) => a.number - b.number));
    loaded = true;
    draw();
  }, (error) => {
    console.warn('Could not load stations:', error.message);
    loaded = true;
    draw();
  });

  // What to show for a trail: its saved stations, or the reference list.
  function stationsFor(trail) {
    const stored = trail ? stationsByTrail.get(trail.id) : null;
    const key = referenceKeyFor(trail);
    const ref = key ? REFERENCE_STATIONS[key] : null;
    if (stored && stored.length) {
      return { source: 'saved', ref, stations: stored };
    }
    if (ref) {
      return { source: 'reference', key, ref, stations: referenceDocs(key, trail.id).map(fromStored) };
    }
    return null;
  }

  function sectionOf(set, n) {
    const sections = set.ref?.sections || [];
    const index = sections.findIndex((s) => n >= s.from && n <= s.to);
    return index === -1 ? null : { index, ...sections[index] };
  }

  function trackHtml(set) {
    return set.stations.map((s) => {
      const section = sectionOf(set, s.number);
      const classes = [
        'st-node',
        s.landmark ? 'is-landmark' : '',
        s.number === activeNumber ? 'is-active' : '',
        s.open ? '' : 'is-closed',
        section ? `sec-${section.index % 3}` : ''
      ].filter(Boolean).join(' ');
      const label = `Station ${s.number}${s.landmark ? ` · ${s.landmark}` : ''}`;
      return `<button type="button" class="${classes}" data-station="${s.number}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${s.number}</button>`;
    }).join('');
  }

  function tagsHtml(tags) {
    return tags.map((t) =>
      `<span class="st-tag"><i class="fa-solid ${TAGS[t].icon}" aria-hidden="true"></i>${TAGS[t].label}</span>`).join('');
  }

  function detailHtml(set) {
    const s = set.stations.find((x) => x.number === activeNumber) || set.stations[0];
    if (!s) return '';
    const section = sectionOf(set, s.number);
    return `
      <div class="st-detail-head">
        <span class="st-detail-num">${s.number}</span>
        <div>
          <div class="st-detail-title">${escapeHtml(s.landmark || `Station ${s.number}`)}</div>
          <div class="st-detail-sub">Station ${s.number} of ${set.stations.length}${section ? ` · ${escapeHtml(section.label)}` : ''}${s.open ? '' : ' · <span class="st-closed-text">Closed</span>'}</div>
        </div>
      </div>
      ${s.description
        ? `<p class="st-detail-desc">${escapeHtml(s.description)}</p>`
        : '<p class="st-detail-desc st-muted">A numbered trail marker. No landmark has been recorded for this station.</p>'}
      ${s.tags.length ? `<div class="st-tags">${tagsHtml(s.tags)}</div>` : ''}
      <div class="st-coords">
        <i class="fa-solid fa-location-crosshairs" aria-hidden="true"></i>
        ${s.lat !== null && s.lng !== null
          ? `${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}${s.coordsEstimated ? ' <span class="st-muted">· estimated</span>' : ''}`
          : '<span class="st-muted">No coordinates yet</span>'}
      </div>`;
  }

  function landmarksHtml(set) {
    const marks = set.stations.filter((s) => s.landmark);
    if (!marks.length) return '<div class="st-muted" style="padding:6px 2px">No landmark stations recorded.</div>';
    return marks.map((s) => `
      <button type="button" class="st-landmark${s.number === activeNumber ? ' is-active' : ''}" data-station="${s.number}">
        <span class="st-landmark-num">${s.number}</span>
        <span class="st-landmark-text">${escapeHtml(s.landmark)}</span>
        ${s.tags.length ? `<i class="fa-solid ${TAGS[s.tags[0]].icon} st-landmark-icon" aria-hidden="true"></i>` : ''}
      </button>`).join('');
  }

  function legendHtml(set) {
    const sections = set.ref?.sections || [];
    return sections.map((s, i) => `
      <span class="st-legend-item"><span class="st-legend-swatch sec-${i % 3}"></span>${escapeHtml(s.label)} <span class="st-muted">(${s.from}–${s.to})</span></span>`).join('');
  }

  // Trails that have stations, for the switcher above the track.
  function trailsWithStations() {
    return allTrails.filter((t) => stationsByTrail.get(t.id)?.length || referenceKeyFor(t));
  }

  function draw() {
    if (!root) return;
    if (!loaded) {
      root.innerHTML = '<div class="st-empty">Loading stations…</div>';
      return;
    }

    const options = trailsWithStations();
    const switcher = options.length ? `
      <div class="st-switch" role="tablist" aria-label="Trails with stations">
        ${options.map((t) => `<button type="button" role="tab" class="st-switch-btn${t.id === currentTrail?.id ? ' is-active' : ''}" data-trail="${escapeHtml(t.id)}" aria-selected="${t.id === currentTrail?.id}">${escapeHtml(t.Trail || 'Untitled Trail')}</button>`).join('')}
      </div>` : '';

    const set = currentTrail ? stationsFor(currentTrail) : null;

    if (!set) {
      const traverse = isTraverse(currentTrail);
      root.innerHTML = switcher + `
        <div class="st-empty">
          <i class="fa-solid fa-route" aria-hidden="true"></i>
          <div>
            <strong>${escapeHtml(currentTrail?.Trail || 'This trail')}</strong> has no numbered stations.
            ${traverse
              ? '<br>The Makiling Traverse goes up the Sipit Trail from Sto. Tomas and down the Mariang Makiling Trail to Los Baños, so it uses both trails\' stations. Pick either one above.'
              : (options.length ? '<br>Pick a trail above to see its stations.' : '')}
          </div>
        </div>`;
      return;
    }

    if (!set.stations.some((s) => s.number === activeNumber)) {
      activeNumber = (set.stations.find((s) => s.landmark) || set.stations[0])?.number ?? null;
    }

    const isReference = set.source === 'reference';
    const first = set.stations[0];
    const last = set.stations[set.stations.length - 1];

    root.innerHTML = switcher + `
      <div class="st-summary">
        <span class="st-chip"><i class="fa-solid fa-location-dot" aria-hidden="true"></i>${set.stations.length} stations</span>
        ${first && last ? `<span class="st-chip"><i class="fa-solid fa-flag" aria-hidden="true"></i>${escapeHtml(first.landmark || 'Station 1')} → ${escapeHtml(last.landmark || `Station ${last.number}`)}</span>` : ''}
        <span class="st-chip ${isReference ? 'is-ref' : 'is-saved'}" title="${isReference ? 'Compiled from hiker reports and MCME. Not saved to the app yet.' : 'Saved in Firestore; this is what the mobile app shows.'}">
          <i class="fa-solid ${isReference ? 'fa-book-open' : 'fa-mobile-screen'}" aria-hidden="true"></i>${isReference ? 'Reference data · not in the app yet' : 'Saved · shown in the app'}
        </span>
      </div>
      ${set.ref?.summary ? `<p class="st-desc">${escapeHtml(set.ref.summary)}</p>` : ''}
      <div class="st-track" role="list">${trackHtml(set)}</div>
      ${set.ref?.sections?.length ? `<div class="st-legend">${legendHtml(set)}<span class="st-legend-item"><span class="st-legend-swatch is-landmark"></span>Landmark</span></div>` : ''}
      <div class="st-body">
        <div class="st-landmarks">
          <div class="st-subtitle">Landmarks</div>
          ${landmarksHtml(set)}
        </div>
        <div class="st-detail">${detailHtml(set)}</div>
      </div>
      ${isReference ? `
        <div class="st-footer">
          <span class="st-muted">Compiled from hiker reports and MCME. Check it against MCME's trail map before relying on it.</span>
          <button type="button" class="st-save-btn" data-save-stations="${escapeHtml(set.key)}"${saving ? ' disabled' : ''}>
            <i class="fa-solid fa-floppy-disk" aria-hidden="true"></i>${saving ? 'Saving…' : `Save ${set.stations.length} stations to the app`}
          </button>
        </div>
        <div class="st-error" role="alert"></div>` : ''}`;
  }

  async function saveReference(key) {
    if (saving || !currentTrail) return;
    const trailID = currentTrail.id;
    saving = true;
    draw();
    try {
      const batch = writeBatch(db);
      referenceDocs(key, trailID).forEach((data) => {
        // Fixed ids, so saving twice overwrites instead of duplicating.
        batch.set(doc(db, 'stations', `${trailID}_station_${String(data.stationNumber).padStart(2, '0')}`), {
          ...data,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });
      });
      await batch.commit();
      saving = false;
      // onSnapshot redraws with the saved stations.
    } catch (error) {
      saving = false;
      draw();
      const errorEl = root.querySelector('.st-error');
      if (errorEl) {
        errorEl.textContent = error?.code === 'permission-denied'
          ? 'Firebase denied saving the stations. Only admins can save them.'
          : `Could not save the stations: ${error.message || 'Unknown error'}`;
      }
    }
  }

  root?.addEventListener('click', (event) => {
    const stationBtn = event.target.closest('[data-station]');
    if (stationBtn) {
      activeNumber = Number(stationBtn.dataset.station);
      draw();
      onSelectStation?.(activeNumber);
      return;
    }
    const trailBtn = event.target.closest('[data-trail]');
    if (trailBtn) {
      // Selects the trail on the whole page (list, details, map), which
      // calls update() back with it.
      if (onSelectTrail) {
        onSelectTrail(trailBtn.dataset.trail);
      } else {
        currentTrail = allTrails.find((t) => t.id === trailBtn.dataset.trail) || currentTrail;
        activeNumber = null;
        draw();
      }
      return;
    }
    const saveBtn = event.target.closest('[data-save-stations]');
    if (saveBtn) saveReference(saveBtn.dataset.saveStations);
  });

  // Called by trail.html whenever the trail list or the selection changes.
  return {
    update(selectedTrail, trailsList) {
      allTrails = trailsList || [];
      if (selectedTrail?.id !== currentTrail?.id) activeNumber = null;
      currentTrail = selectedTrail || null;
      draw();
    }
  };
}
