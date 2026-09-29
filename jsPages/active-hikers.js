// active-hikers.js
// The one definition of "an active hiker" for the whole portal, in the spirit
// of makiling-area.js: the Dashboard, Geomap and User Management tiles all
// count from here, so the pages can never disagree about how many hikers are out.
//
//   hikedToday   hikers currently checked in: users/{uid} with
//                checkIns == true. Setting it back to false takes the hiker
//                off the count straight away.
//   onlineNow    hikers whose users/{uid}.lastActive is within
//                ACTIVE_ONLINE_MS. The PeakPath app stamps it when a hiker
//                signs in and about once a minute while they stay signed in
//                (ActivityService in the app).
//
// Polled rather than listened to by default: a summary tile does not need
// per-second figures, so it polls once a minute and pauses while the tab is
// hidden.

import {
    collection,
    getDocs,
    onSnapshot,
    query,
    where,
    Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { portalTimeZone, toPortalDate } from "./datetime-prefs.js";

/* Thresholds shared with the Geomap hiker pins. */
export const HIKER_POLL_MS = 60 * 1000;
export const HIKER_ONLINE_MS = 2 * 60 * 1000;
export const HIKER_EXPIRY_MS = 12 * 60 * 60 * 1000;

/* The app checks in every minute, so three minutes allows for one missed
   check-in (a slow network, a phone waking up) before a hiker drops offline. */
export const ACTIVE_ONLINE_MS = 3 * 60 * 1000;

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

// Hikers checked in right now: users/{uid} with checkIns: true.
const checkInsQuery = (db) => query(
    collection(db, 'users'),
    where('checkIns', '==', true)
);

// Hikers who have used the app today; onlineNow narrows these down.
const loginsQuery = (db, midnight) => query(
    collection(db, 'users'),
    where('lastActive', '>=', Timestamp.fromDate(midnight))
);

/* Counts one poll's worth of documents.
     checkedInIds   ids of users docs with checkIns == true
     users          users docs whose lastActive is today */
export function countActiveHikers(checkedInIds, users) {
    const now = Date.now();
    let onlineNow = 0;
    users.forEach((data) => {
        const lastActive = toPortalDate(data.lastActive);
        if (lastActive && now - lastActive.getTime() <= ACTIVE_ONLINE_MS) onlineNow += 1;
    });
    return { hikedToday: new Set(checkedInIds).size, onlineNow };
}

/* A failed online count must not blank the check-in count, so the logins
   read falls back to nobody online; the check-ins read is the one that has
   to succeed. */
const readLogins = (db) => getDocs(loginsQuery(db, portalMidnight()))
    .then((snapshot) => snapshot.docs.map((snap) => snap.data()))
    .catch((error) => {
        console.warn('Could not read hiker logins:', error.message);
        return [];
    });

export async function fetchActiveHikers(db) {
    const [checkIns, users] = await Promise.all([
        getDocs(checkInsQuery(db)),
        readLogins(db)
    ]);
    return countActiveHikers(checkIns.docs.map((snap) => snap.id), users);
}

const errorMessage = (error) => error?.code === 'permission-denied'
    ? 'Hiker check-ins blocked by Firestore rules'
    : 'Hiker activity unavailable';

/* Polls fetchActiveHikers and hands each result to the page.

   onUpdate({ hikedToday, onlineNow })  a fresh count
   onError(message)                     a message ready to show; the rules
                                        failure is named, because that is
                                        the one an admin can fix

   live: true listens instead of polling, so a hiker who checks in shows up
   on the tile within seconds. The count is still redone every minute so
   hikers who closed the app drop out of onlineNow.

   Returns a stop function. Overlapping polls are skipped rather than queued,
   so a slow network cannot stack requests up. */
export function watchActiveHikers({ db, onUpdate, onError, live = false }) {
    if (live) {
        let checkedInIds = [];
        let users = [];
        let dayKey;
        let unsubscribeLogins;
        let stopped = false;
        const report = () => onUpdate(countActiveHikers(checkedInIds, users));

        const unsubscribeCheckIns = onSnapshot(checkInsQuery(db), (snapshot) => {
            if (stopped) return;
            checkedInIds = snapshot.docs.map((snap) => snap.id);
            report();
        }, (error) => {
            if (stopped) return;
            console.error('Error loading hiker check-ins:', error);
            onError(errorMessage(error));
        });

        // The logins listener is re-opened at midnight so "today" rolls over.
        const refresh = () => {
            if (stopped || document.hidden) return;
            const midnight = portalMidnight();
            midnight.setMilliseconds(0);
            const nextDay = midnight.getTime();
            if (nextDay === dayKey) {
                report();
                return;
            }
            unsubscribeLogins?.();
            dayKey = nextDay;
            users = [];
            unsubscribeLogins = onSnapshot(loginsQuery(db, midnight), (snapshot) => {
                if (stopped || dayKey !== nextDay) return;
                users = snapshot.docs.map((snap) => snap.data());
                report();
            }, (error) => {
                console.warn('Could not read hiker logins:', error.message);
                dayKey = undefined;
            });
        };
        refresh();
        const timer = setInterval(refresh, HIKER_POLL_MS);
        document.addEventListener('visibilitychange', refresh);
        window.addEventListener('online', refresh);
        return () => {
            stopped = true;
            unsubscribeCheckIns();
            unsubscribeLogins?.();
            clearInterval(timer);
            document.removeEventListener('visibilitychange', refresh);
            window.removeEventListener('online', refresh);
        };
    }
    let polling = false;

    const tick = async () => {
        if (polling) return;
        polling = true;
        try {
            onUpdate(await fetchActiveHikers(db));
        } catch (error) {
            console.error('Error loading active hikers:', error);
            onError(errorMessage(error));
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
