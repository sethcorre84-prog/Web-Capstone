// hiker-layer.js
// Live hiker pins from the PeakPath app, for the GeoMap and the Emergency
// map: everyone signed in to the app on Mount Makiling (locations/{uid},
// written by the app's LiveLocationService). Green while online, grey once
// silent ("last seen"), blue while on a hike (the app's Start Hike), and
// orange when the hiker is LOST / MISSING: an open Lost / Missing alert in
// emergency/{id} names them (missingUserId), reported by a companion from the
// app or marked by an admin from their SOS. A lost hiker who is not sharing a
// position is shown at the alert's last known position instead (unless
// `showLostAlerts` is false, as on the Emergency map, which draws the alerts
// itself).
//
//   addHikerLayer({ map, db, bounds, layer, onCaption }) -> the Leaflet layer
//     layer      optional layer group to draw into (e.g. one already in a
//                layers control); a new one is added to the map otherwise
//     bounds     the Mount Makiling bounds (createMakilingMap); hikers outside
//                them are counted, not drawn
//     onCaption  called with a one-line summary ("3 hikers online · ...")
//     showLostAlerts  draw lost hikers with no live pin at the alert's position

import { escapeHtml } from './utils.js';
import { toPortalDate as toDate } from './datetime-prefs.js';
import { Timestamp, collection, getDocs, onSnapshot, query, where } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const CSS = `
.hiker-marker {
    background: none;
    border: none;
}
.hiker-pin {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    border: 2px solid #fff;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
    color: #fff;
    font-size: 12px;
}
.hiker-pin.online {
    background: #2f8f4e;
}
.hiker-pin.offline {
    background: #8a948c;
}
/* On a hike right now (the app's Start Hike): blue, as hikers are in
   the app; grey with a blue ring once its signal is lost. */
.hiker-pin.online.on-hike {
    background: #1a73e8;
}
.hiker-pin.online.on-hike::after {
    border-color: #1a73e8;
}
.hiker-pin.offline.on-hike {
    box-shadow: 0 0 0 2px #1a73e8, 0 1px 4px rgba(0, 0, 0, 0.35);
}
.hiker-pin.online::after {
    content: "";
    position: absolute;
    inset: -5px;
    border-radius: 50%;
    border: 2px solid #2f8f4e;
    animation: hikerPulse 2s ease-out infinite;
}
/* Lost / Missing: orange and larger, with a fast pulse, above every other pin. */
.hiker-pin.lost {
    background: #e0962a;
    width: 30px;
    height: 30px;
    font-size: 14px;
    box-shadow: 0 0 0 3px rgba(224, 150, 42, .35), 0 1px 5px rgba(0, 0, 0, .45);
}
.hiker-pin.lost::after {
    content: "";
    position: absolute;
    inset: -6px;
    border-radius: 50%;
    border: 2px solid #e0962a;
    animation: hikerPulse 1.2s ease-out infinite;
}
.hiker-lost-tag {
    display: inline-block;
    margin: 2px 0;
    padding: 1px 7px;
    border-radius: 10px;
    background: #e0962a;
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: .02em;
}
@keyframes hikerPulse {
    from {
        transform: scale(0.8);
        opacity: 0.8;
    }
    to {
        transform: scale(1.5);
        opacity: 0;
    }
}
@media (prefers-reduced-motion: reduce) {
    .hiker-pin.online::after {
        animation: none;
        opacity: 0;
    }
}
`;

// The position fields the app writes (a GeoPoint, or latitude/longitude).
const getCoordinates = (data) => {
  const latitude = Number(data.latitude ?? data.lat ?? data.coordinates?.latitude);
  const longitude = Number(data.longitude ?? data.lng ?? data.coordinates?.longitude);
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
    ? [latitude, longitude]
    : null;
};

export function addHikerLayer({ map, db, bounds, layer = null, onCaption = () => {}, showLostAlerts = true }) {
  if (!document.getElementById('hiker-layer-css')) {
    const style = document.createElement('style');
    style.id = 'hiker-layer-css';
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  layer ||= L.layerGroup().addTo(map);

  /* Live hiker positions from the PeakPath app (locations/{uid}), written
     about once a second while a hiker is signed in. Polled rather than
     listened to: a live listener is billed one read per phone per second
     for as long as this page is open. The thresholds match the app's own
     teammate pins — silent for 2 minutes means the signal was lost or the
     app closed (kept as "last seen"), and after 12 hours the hike is over. */
  const HIKER_REFRESH_MS = 10 * 1000;
  const HIKER_ONLINE_MS = 2 * 60 * 1000;
  const HIKER_EXPIRY_MS = 12 * 60 * 60 * 1000;
  const hikerMarkers = new Map();
  let hikerDocs = [];
  let hikerRefreshing = false;

  const formatAgo = (date) => {
    const minutes = Math.floor((Date.now() - date.getTime()) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours} hr${hours === 1 ? '' : 's'} ago`;
  };

  const hikerIcon = (online, onHike, lost = false) => (lost
    ? L.divIcon({
      className: 'hiker-marker',
      html: '<span class="hiker-pin lost"><i class="fa-solid fa-person-circle-question"></i></span>',
      iconSize: [30, 30],
      iconAnchor: [15, 15],
      popupAnchor: [0, -16]
    })
    : L.divIcon({
      className: 'hiker-marker',
      html: `<span class="hiker-pin ${online ? 'online' : 'offline'}${onHike ? ' on-hike' : ''}"><i class="fa-solid fa-person-hiking"></i></span>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13],
      popupAnchor: [0, -14]
    }));

  /* Open Lost / Missing alerts, by the hiker they are about. Live: the pin
     turns orange the moment a companion reports them or an admin marks
     their SOS, and back when the alert is resolved or cancelled. */
  const lostByUid = new Map(); // uid -> the alert's data
  const lostAlertMarkers = new Map(); // alert id -> marker at its position
  const isOpenAlert = (data) => ['active', 'responding'].includes(String(data.status || 'active').toLowerCase())
    || /respond|dispatch|assign|progress|search/.test(String(data.status || '').toLowerCase());
  const lostUidOf = (data) => String(data.missingUserId || (data.reportedById ? '' : data.userId) || '');
  const lostLine = (alert) => {
    const by = alert.reportedByName
      ? `Reported by ${escapeHtml(alert.reportedByName)}${alert.teamName ? ` (team ${escapeHtml(alert.teamName)})` : ''}`
      : (alert.markedLostBy ? `Marked by ${escapeHtml(alert.markedLostBy)} from their SOS` : 'Reported to the rangers');
    const since = toDate(alert.createdAt);
    return `<span class="hiker-lost-tag">LOST / MISSING</span><br><small>${by}${since ? ` · ${escapeHtml(since.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}` : ''}</small><br>`;
  };

  const hikerPopup = (data, coordinates, updatedAt, online, lostAlert = null) => {
    const details = [];
    const speed = Number(data.speed);
    if (Number.isFinite(speed) && speed >= 0) details.push(`${(speed * 3.6).toFixed(1)} km/h`);
    const altitude = Number(data.altitude);
    if (Number.isFinite(altitude)) details.push(`${Math.round(altitude)} m elevation`);
    const accuracy = Number(data.accuracy);
    if (Number.isFinite(accuracy) && accuracy > 0) details.push(`±${Math.round(accuracy)} m`);
    const teammates = Array.isArray(data.sharedWith) ? data.sharedWith.length : 0;
    // The hike in progress, from the app's Start Hike.
    const hike = data.hike?.trail ? data.hike : null;
    const hikeSince = hike ? toDate(hike.startedAt) : null;
    return `
      <strong>${escapeHtml(data.name || 'Hiker')}</strong><br>
      ${lostAlert ? lostLine(lostAlert) : ''}
      ${hike ? `<span style="display:inline-flex;align-items:center;gap:5px;color:#1a73e8;font-weight:600"><i class="fa-solid fa-route" aria-hidden="true"></i>Hiking ${escapeHtml(hike.trail)}${hikeSince ? ` · since ${escapeHtml(hikeSince.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}` : ''}</span><br>` : ''}
      <span style="display:inline-flex;align-items:center;gap:5px"><span style="width:8px;height:8px;border-radius:50%;background:${online ? '#2f8f4e' : '#8a948c'}"></span>${online ? 'Online' : 'Offline · last seen'} ${escapeHtml(formatAgo(updatedAt))}</span><br>
      ${teammates ? `Sharing with ${teammates} teammate${teammates === 1 ? '' : 's'}` : 'Solo hiker'}<br>
      <small>${details.length ? `${escapeHtml(details.join(' · '))} · ` : ''}${coordinates.map((value) => value.toFixed(5)).join(', ')}</small>
    `;
  };

  const renderHikers = () => {
    const now = Date.now();
    const shown = new Set();
    let online = 0;
    let offline = 0;
    let offMountain = 0;
    let onHike = 0;
    let lostShown = 0;

    hikerDocs.forEach((data) => {
      const updatedAt = toDate(data.updatedAt);
      const coordinates = data.position ? getCoordinates(data.position) : null;
      if (!updatedAt || !coordinates || now - updatedAt.getTime() > HIKER_EXPIRY_MS) return;
      if (!bounds.contains(coordinates)) {
        offMountain += 1;
        return;
      }
      const isOnline = now - updatedAt.getTime() <= HIKER_ONLINE_MS;
      const isHiking = Boolean(data.hike?.trail);
      const lostAlert = lostByUid.get(data.id) || null;
      const isLost = Boolean(lostAlert);
      if (isOnline) online += 1; else offline += 1;
      if (isHiking) onHike += 1;
      if (isLost) lostShown += 1;
      shown.add(data.id);

      const popup = hikerPopup(data, coordinates, updatedAt, isOnline, lostAlert);
      const zIndex = isLost ? 1500 : (isHiking ? 1100 : 1000);
      const marker = hikerMarkers.get(data.id);
      if (!marker) {
        const created = L.marker(coordinates, { icon: hikerIcon(isOnline, isHiking, isLost), zIndexOffset: zIndex })
          .bindPopup(popup)
          .addTo(layer);
        created.isOnline = isOnline;
        created.isHiking = isHiking;
        created.isLost = isLost;
        hikerMarkers.set(data.id, created);
        return;
      }
      // Moved in place rather than redrawn, so an open popup stays open.
      marker.setLatLng(coordinates).setPopupContent(popup);
      if (marker.isOnline !== isOnline || marker.isHiking !== isHiking || marker.isLost !== isLost) {
        marker.setIcon(hikerIcon(isOnline, isHiking, isLost));
        marker.setZIndexOffset(zIndex);
        marker.isOnline = isOnline;
        marker.isHiking = isHiking;
        marker.isLost = isLost;
      }
    });

    // Lost hikers with no live pin: at the alert's last known position.
    const drawnAlerts = new Set();
    if (showLostAlerts) {
      lostByUid.forEach((alert, uid) => {
        if (shown.has(uid)) return;
        const coordinates = getCoordinates(alert);
        if (!coordinates || !bounds.contains(coordinates)) return;
        drawnAlerts.add(alert.id);
        lostShown += 1;
        const popup = `<strong>${escapeHtml(alert.hikerName || 'Hiker')}</strong><br>${lostLine(alert)}
          ${alert.trailName ? `${escapeHtml(alert.trailName)}<br>` : ''}<small>Last known position (not sharing a location now) · ${coordinates.map((v) => v.toFixed(5)).join(', ')}</small>`;
        const existing = lostAlertMarkers.get(alert.id);
        if (existing) {
          existing.setLatLng(coordinates).setPopupContent(popup);
          return;
        }
        lostAlertMarkers.set(alert.id, L.marker(coordinates, { icon: hikerIcon(false, false, true), zIndexOffset: 1500 })
          .bindPopup(popup)
          .addTo(layer));
      });
    }
    lostAlertMarkers.forEach((marker, id) => {
      if (drawnAlerts.has(id)) return;
      layer.removeLayer(marker);
      lostAlertMarkers.delete(id);
    });

    hikerMarkers.forEach((marker, id) => {
      if (shown.has(id)) return;
      layer.removeLayer(marker);
      hikerMarkers.delete(id);
    });

    onCaption((lostShown ? `${lostShown} lost / missing · ` : '') +
      `${online} hiker${online === 1 ? '' : 's'} online` +
      (onHike ? ` · ${onHike} on a hike` : '') +
      (offline ? ` · ${offline} recently offline` : '') +
      (offMountain ? ` · ${offMountain} signed in outside Mount Makiling` : ''));
  };

  const refreshHikers = async () => {
    if (hikerRefreshing) return;
    hikerRefreshing = true;
    try {
      const cutoff = Timestamp.fromMillis(Date.now() - HIKER_EXPIRY_MS);
      const snapshot = await getDocs(query(collection(db, 'locations'), where('updatedAt', '>', cutoff)));
      hikerDocs = snapshot.docs.map((snap) => ({ id: snap.id, ...snap.data() }));
      renderHikers();
    } catch (error) {
      console.error('Error loading hiker locations:', error);
      onCaption(error?.code === 'permission-denied'
        ? 'Hiker locations blocked by Firestore rules'
        : 'Unable to load hiker locations');
    } finally {
      hikerRefreshing = false;
    }
  };

  // Open Lost / Missing alerts (type "Lost": the app's reports and the
  // portal's "Mark as Lost / Missing" both write it).
  onSnapshot(query(collection(db, 'emergency'), where('type', '==', 'Lost')), (snapshot) => {
    lostByUid.clear();
    snapshot.docs.forEach((snap) => {
      const data = { id: snap.id, ...snap.data() };
      const uid = lostUidOf(data);
      if (uid && isOpenAlert(data)) lostByUid.set(uid, data);
    });
    renderHikers();
  }, (error) => console.warn('Could not read Lost / Missing alerts:', error.message));

  refreshHikers();
  setInterval(() => { if (!document.hidden) refreshHikers(); }, HIKER_REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshHikers(); });

  return layer;
}
