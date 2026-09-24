// active-hikers.js
// The one definition of "an active hiker" for the whole portal, in the spirit
// of makiling-area.js: the Dashboard tile and the Geomap tile both count from
// here, so the two pages can never disagree about how many hikers are out.
//
// A hiker counts as active today when the PeakPath app has written a position
// for them (locations/{uid}) since midnight in the portal's time zone. Before
// this, the two pages answered the question differently — Geomap counted hiker
// *accounts* that were not suspended, which said nothing about today.
//
// Polled rather than listened to: the app rewrites a hiker's position about
// once a second while they are signed in, and a live listener is billed one
// read per phone per second for as long as the page is open. A summary tile
// does not need per-second figures, so it polls once a minute and pauses while
// the tab is hidden.
//
// When the app's "Start Hiking" flag is confirmed, isActiveHiker() below is the
// only thing that has to change, and both tiles follow it.

import {
    collection,
    getDocs,
    query,
    where,
    Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { portalTimeZone, toPortalDate } from "./datetime-prefs.js";

/* Thresholds shared with the Geomap hiker pins, so a hiker the map draws as
   online is the same hiker this counts as on the mountain. */
export const HIKER_POLL_MS = 60 * 1000;
export const HIKER_ONLINE_MS = 2 * 60 * 1000;
export const HIKER_EXPIRY_MS = 12 * 60 * 60 * 1000;

/* Midnight today in the portal's time zone (Settings > Date & Time), so the
   count rolls over with the clock the admin is reading rather than with the
   browser's own zone. Derived by asking the zone what time it is now and
   subtracting that from the current instant, which stays correct across
   offsets and daylight saving without any date arithmetic. */
export function portalMidnight() {
    const now = new Date();
    const parts = {};
    new Intl.DateTimeFormat('en-US', {
        timeZone: portalTimeZone(),
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).formatToParts(now).forEach(({ type, value }) => { parts[type] = value; });
    // en-US with hour12:false reports midnight as 24; fold it back to 0.
    const secondsIntoDay = (Number(parts.hour) % 24) * 3600
        + Number(parts.minute) * 60 + Number(parts.second);
    return new Date(now.getTime() - secondsIntoDay * 1000);
}

// Accepts a GeoPoint, {lat,lng} or {latitude,longitude}, like the pages' maps.
const getCoordinates = (position) => {
    const latitude = Number(position.latitude ?? position.lat);
    const longitude = Number(position.longitude ?? position.lng);
    return Number.isFinite(latitude) && Number.isFinite(longitude)
        && latitude >= -90 && latitude <= 90
        && longitude >= -180 && longitude <= 180
        ? [latitude, longitude]
        : null;
};

/* Counts one poll's worth of location documents.
     hikedToday      hikers the app reported a position for since midnight
     onMountainNow   of those, the ones still reporting (within HIKER_ONLINE_MS)
                     from inside the Mount Makiling bounds

   A locations document holds a hiker's *latest* position, not their track, so
   someone who hiked this morning and has since gone home still counts in
   hikedToday — they did hike today — but no longer in onMountainNow. */
export function countActiveHikers(docs, bounds) {
    const now = Date.now();
    let hikedToday = 0;
    let onMountainNow = 0;

    docs.forEach((data) => {
        const updatedAt = toPortalDate(data.updatedAt);
        const coordinates = data.position ? getCoordinates(data.position) : null;
        if (!updatedAt || !coordinates) return;
        hikedToday += 1;
        if (now - updatedAt.getTime() <= HIKER_ONLINE_MS && bounds.contains(coordinates)) {
            onMountainNow += 1;
        }
    });

    return { hikedToday, onMountainNow };
}

export async function fetchActiveHikers(db, bounds) {
    const snapshot = await getDocs(query(
        collection(db, 'locations'),
        where('updatedAt', '>=', Timestamp.fromDate(portalMidnight()))
    ));
    return countActiveHikers(snapshot.docs.map((snap) => snap.data()), bounds);
}

/* Polls fetchActiveHikers and hands each result to the page.

   onUpdate({ hikedToday, onMountainNow })  a fresh count
   onError(message)                         a message ready to show; the
                                            rules failure is named, because
                                            that is the one an admin can fix

   Returns a stop function. Overlapping polls are skipped rather than queued,
   so a slow network cannot stack requests up. */
export function watchActiveHikers({ db, bounds, onUpdate, onError }) {
    let polling = false;

    const tick = async () => {
        if (polling) return;
        polling = true;
        try {
            onUpdate(await fetchActiveHikers(db, bounds));
        } catch (error) {
            console.error('Error loading active hikers:', error);
            onError(error?.code === 'permission-denied'
                ? 'Hiker locations blocked by Firestore rules'
                : 'Hiker activity unavailable');
        } finally {
            polling = false;
        }
    };

    const onVisible = () => { if (!document.hidden) tick(); };

    tick();
    const timer = setInterval(onVisible, HIKER_POLL_MS);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
        clearInterval(timer);
        document.removeEventListener('visibilitychange', onVisible);
    };
}
