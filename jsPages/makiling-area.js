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
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    minZoom: 13,
    maxZoom: 19,
    bounds,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

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

  // sidebar.js flips data-theme on <html> when Dark Mode is switched in
  // another tab; follow it without a reload.
  new MutationObserver(() => mask.setStyle({ fillColor: maskColor() }))
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  L.polygon(MAKILING_RING, {
    fill: false,
    color: '#2f8f4e',
    weight: 2,
    dashArray: '6 6',
    interactive: false
  }).addTo(map);

  return { map, bounds };
}
