// admin-sessions.js
// Login sessions: one record per browser an admin is signed in on, at
// admins/{uid}/sessions/{sessionId}. dashboard-guard.js starts and watches the
// session on every protected page; Settings > Login Sessions lists them and
// ends them. Ending a session marks it revoked, and the browser holding it
// signs out as soon as it sees that (at once if a page is open, otherwise the
// next time a page loads).
//
// One place at a time: while an admin account is open in one browser, no
// other browser or device can use it. Signing in elsewhere is refused at the
// login page, and a browser that was already signed in is signed out when it
// next loads a page, naming the device that has the account. A session counts
// as open while its page sends a heartbeat, every minute; a browser closed
// without logging out stops, and after ACTIVE_WINDOW_MS the account is free
// again.
//
// Finished sessions are kept, not deleted, as the account's sign-in history
// for HISTORY_DAYS: endedAt and endReason say how each ended (logged-out,
// closed, signed-out: ended from another device). A sign-in refused because
// the account was open elsewhere is kept too (blocked: true), so an attempt
// from an unknown device shows in Settings > Login Sessions.
import { auth, db } from "./firebase-config.js";
import { signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, deleteDoc, doc, getDoc, getDocs, onSnapshot, serverTimestamp, setDoc, updateDoc, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const SESSION_KEY = "peakpath-session-id";
const HEARTBEAT_MS = 60 * 1000; // lastActiveAt is refreshed this often while a page is open
// A session with no heartbeat for this long is over (its browser was closed).
const ACTIVE_WINDOW_MS = 3 * 60 * 1000;
export const SESSION_ENDED_REASON = "session-ended";
// How long finished sessions and blocked attempts stay listed.
const HISTORY_DAYS = 30;
export const SESSION_IN_USE_REASON = "in-use";

const sessionsOf = (uid) => collection(db, "admins", uid, "sessions");
const sessionRef = (uid, id) => doc(db, "admins", uid, "sessions", id);

function readSessionId() {
  try { return localStorage.getItem(SESSION_KEY) || ""; } catch { return ""; }
}
function writeSessionId(id) {
  try {
    if (id) localStorage.setItem(SESSION_KEY, id);
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* storage blocked: the session lasts for this page only */ }
}

export const currentSessionId = () => readSessionId();

// The login page calls this after a successful sign-in, so every sign-in is a
// new session, never the reuse of one that was ended earlier.
export function beginNewSession() {
  writeSessionId("");
}

/* "Chrome on Windows 11"-style labels from the user agent. Windows 11 also
   reports "Windows NT 10.0", so it reads as Windows 10/11 unless the browser
   says more through userAgentData. */
export async function describeDevice() {
  const ua = navigator.userAgent;
  const browser =
    /Edg\//.test(ua) ? "Edge" :
    /OPR\/|Opera/.test(ua) ? "Opera" :
    /SamsungBrowser/.test(ua) ? "Samsung Internet" :
    /Firefox\//.test(ua) ? "Firefox" :
    /Chrome\//.test(ua) ? "Chrome" :
    /Safari\//.test(ua) ? "Safari" : "Browser";
  let os =
    /Windows NT 10/.test(ua) ? "Windows 10/11" :
    /Windows/.test(ua) ? "Windows" :
    /Android/.test(ua) ? "Android" :
    /iPhone|iPad|iPod/.test(ua) ? "iOS" :
    /Mac OS X/.test(ua) ? "macOS" :
    /CrOS/.test(ua) ? "ChromeOS" :
    /Linux/.test(ua) ? "Linux" : "Unknown system";
  try {
    if (os === "Windows 10/11" && navigator.userAgentData?.getHighEntropyValues) {
      const { platformVersion } = await navigator.userAgentData.getHighEntropyValues(["platformVersion"]);
      os = Number(String(platformVersion).split(".")[0]) >= 13 ? "Windows 11" : "Windows 10";
    }
  } catch { /* keep "Windows 10/11" */ }
  const mobile = navigator.userAgentData?.mobile ?? /Mobi|Android|iPhone/.test(ua);
  return { browser, os, deviceType: mobile ? "Mobile" : "Computer" };
}

const toMillis = (t) => (t?.toMillis ? t.toMillis() : 0);

// A record that is history, not a session that can hold the account.
const isFinished = (data) => Boolean(data.endedAt || data.blocked);

/* Another browser that has this account open right now, or null: a session
   not ended, not this browser's own, with a heartbeat in the last
   ACTIVE_WINDOW_MS. On the way, a session whose heartbeat stopped (closed
   without logging out) is marked ended, kept as history, and history older
   than HISTORY_DAYS is cleared out. */
export async function activeSessionElsewhere(user) {
  const own = readSessionId();
  const snap = await getDocs(sessionsOf(user.uid));
  const now = Date.now();
  let active = null;
  for (const item of snap.docs) {
    const data = item.data();
    const last = toMillis(data.lastActiveAt) || toMillis(data.signedInAt);
    if (isFinished(data)) {
      const ended = toMillis(data.endedAt) || last;
      if (now - ended > HISTORY_DAYS * 24 * 60 * 60 * 1000) deleteDoc(item.ref).catch(() => {});
      continue;
    }
    if (item.id === own) continue;
    if (data.revoked || now - last > ACTIVE_WINDOW_MS) {
      updateDoc(item.ref, {
        endedAt: data.lastActiveAt || data.signedInAt || serverTimestamp(),
        endReason: data.revoked ? "signed-out" : "closed"
      }).catch(() => {});
      continue;
    }
    if (!active || last > active.last) active = { id: item.id, ...data, last };
  }
  return active;
}

/* A sign-in refused because the account was open elsewhere (login.js),
   kept in the history so it shows in Login Sessions. Best effort. */
export async function recordBlockedSignIn(user, elsewhere) {
  try {
    const device = await describeDevice();
    await setDoc(sessionRef(user.uid, randomId()), {
      ...device,
      email: user.email || "",
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
      signedInAt: serverTimestamp(),
      lastActiveAt: serverTimestamp(),
      endedAt: serverTimestamp(),
      endReason: "blocked",
      blocked: true,
      blockedBy: [elsewhere?.browser, elsewhere?.os].filter(Boolean).join(" on ") || "",
      revoked: true
    });
  } catch (error) {
    console.warn("Could not record the refused sign-in:", error.message);
  }
}

// "Chrome on Windows 11 (active 1 minute ago)", for the refusal message.
export function describeSession(session) {
  const device = [session?.browser, session?.os].filter(Boolean).join(" on ") || "another device";
  const minutes = Math.max(0, Math.round((Date.now() - (session?.last || Date.now())) / 60000));
  return `${device} (active ${minutes < 1 ? "just now" : `${minutes} minute${minutes === 1 ? "" : "s"} ago`})`;
}

const randomId = () =>
  (crypto.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/-/g, "");

/* Starts (or resumes) this browser's session and watches it. Calls onEnded
   once if the session is ended from another device, and onInUse(session)
   instead of starting when another browser has the account open. Failures
   (for example before the Firestore rules allow sessions) are logged, never
   fatal. */
export async function startSession(user, onEnded, onInUse) {
  let id = readSessionId();
  try {
    const elsewhere = await activeSessionElsewhere(user);
    if (elsewhere) {
      onInUse?.(elsewhere);
      return;
    }
    const device = await describeDevice();
    const fields = {
      ...device,
      email: user.email || "",
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
      lastActiveAt: serverTimestamp()
    };
    let existing = null;
    if (id) existing = await getDoc(sessionRef(user.uid, id));
    if (existing?.exists() && existing.data().revoked && !existing.data().endedAt) {
      onEnded();
      return;
    }
    // Ended already (closed while idle, then reopened): a new sign-in entry.
    if (existing?.exists() && isFinished(existing.data())) existing = null;
    if (existing?.exists()) {
      await updateDoc(sessionRef(user.uid, id), fields);
    } else {
      id = randomId();
      await setDoc(sessionRef(user.uid, id), { ...fields, signedInAt: serverTimestamp(), revoked: false });
      writeSessionId(id);
    }
  } catch (error) {
    console.warn("Could not record the login session:", error.message);
    return;
  }

  let ended = false;
  const end = () => { if (!ended) { ended = true; onEnded(); } };
  onSnapshot(sessionRef(user.uid, id), (snap) => {
    if (!snap.exists() || snap.data().revoked || snap.data().endedAt) end();
  }, (error) => console.warn("Could not watch the login session:", error.message));

  // Keep "last active" current while a page is open, in front or not: it is
  // what keeps the account closed to other devices.
  let lastBeat = Date.now();
  const beat = async () => {
    if (ended) return;
    // A tab the browser froze for a while let its session lapse, so another
    // device may have signed in since; that one keeps the account.
    if (Date.now() - lastBeat > ACTIVE_WINDOW_MS) {
      const elsewhere = await activeSessionElsewhere(user).catch(() => null);
      if (elsewhere) {
        ended = true;
        onInUse?.(elsewhere);
        return;
      }
    }
    lastBeat = Date.now();
    updateDoc(sessionRef(user.uid, id), { lastActiveAt: serverTimestamp() }).catch(() => {});
  };
  setInterval(beat, HEARTBEAT_MS);
  document.addEventListener("visibilitychange", beat);
}

// Logout: ends this browser's session (kept as history), then signs out.
export async function endCurrentSession() {
  const user = auth.currentUser;
  const id = readSessionId();
  writeSessionId("");
  if (user && id) {
    await updateDoc(sessionRef(user.uid, id), { endedAt: serverTimestamp(), endReason: "logged-out" }).catch(() => {});
  }
}

// Signed out because another browser has the account open.
export async function signOutInUse(session) {
  writeSessionId("");
  try {
    sessionStorage.setItem("peakpath-in-use", describeSession(session));
  } catch { /* the login page then says it more generally */ }
  await signOut(auth).catch(() => {});
  window.location.href = `Home.html?reason=${SESSION_IN_USE_REASON}`;
}

// Signed out because the session was ended elsewhere.
export async function signOutEndedSession() {
  // Kept as history: signed out from another device.
  const user = auth.currentUser;
  const id = readSessionId();
  if (user && id) {
    await updateDoc(sessionRef(user.uid, id), { endedAt: serverTimestamp(), endReason: "signed-out" }).catch(() => {});
  }
  writeSessionId("");
  await signOut(auth).catch(() => {});
  window.location.href = `Home.html?reason=${SESSION_ENDED_REASON}`;
}

/* The signed-in admin's sessions: { active, history }. active: open now
   (this browser first). history: sign-ins that have ended and refused
   attempts in the last HISTORY_DAYS, newest first, each with `ended` (when)
   and endReason. */
export async function listSessions() {
  const user = auth.currentUser;
  if (!user) return { active: [], history: [] };
  const snap = await getDocs(sessionsOf(user.uid));
  const current = readSessionId();
  const now = Date.now();
  const all = snap.docs.map((d) => {
    const data = d.data();
    const last = toMillis(data.lastActiveAt) || toMillis(data.signedInAt);
    const open = !isFinished(data) && !data.revoked && (d.id === current || now - last <= ACTIVE_WINDOW_MS);
    return {
      id: d.id,
      ...data,
      current: d.id === current && !isFinished(data),
      open,
      // An open-looking record whose heartbeat stopped is history too.
      endReason: data.endReason || (data.revoked ? "signed-out" : open ? "" : "closed"),
      ended: toMillis(data.endedAt) || (open ? 0 : last)
    };
  });
  const active = all.filter((s) => s.open)
    .sort((a, b) => (b.current - a.current) || (toMillis(b.lastActiveAt) - toMillis(a.lastActiveAt)));
  const history = all.filter((s) => !s.open && now - s.ended <= HISTORY_DAYS * 24 * 60 * 60 * 1000)
    .sort((a, b) => (toMillis(b.signedInAt) || b.ended) - (toMillis(a.signedInAt) || a.ended));
  return { active, history };
}

// Ends one session on another device.
export async function endSession(id) {
  const user = auth.currentUser;
  if (!user) throw new Error("Your session has expired. Sign in again.");
  await updateDoc(sessionRef(user.uid, id), { revoked: true, revokedAt: serverTimestamp() });
}

// Ends every session except this one. Resolves to how many were ended.
export async function endOtherSessions() {
  const others = (await listSessions()).active.filter((s) => !s.current);
  if (!others.length) return 0;
  const batch = writeBatch(db);
  const uid = auth.currentUser.uid;
  others.forEach((s) => batch.update(sessionRef(uid, s.id), { revoked: true, revokedAt: serverTimestamp() }));
  await batch.commit();
  return others.length;
}
