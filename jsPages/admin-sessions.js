// admin-sessions.js
// Login sessions: one record per browser an admin is signed in on, at
// admins/{uid}/sessions/{sessionId}. dashboard-guard.js starts and watches the
// session on every protected page; Settings > Login Sessions lists them and
// ends them. Ending a session marks it revoked, and the browser holding it
// signs out as soon as it sees that (at once if a page is open, otherwise the
// next time a page loads).
import { auth, db } from "./firebase-config.js";
import { signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, deleteDoc, doc, getDoc, getDocs, onSnapshot, serverTimestamp, setDoc, updateDoc, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const SESSION_KEY = "peakpath-session-id";
const HEARTBEAT_MS = 5 * 60 * 1000; // lastActiveAt is refreshed this often while a page is open
export const SESSION_ENDED_REASON = "session-ended";

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

const randomId = () =>
  (crypto.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/-/g, "");

/* Starts (or resumes) this browser's session and watches it. Calls onEnded
   once if the session is ended from another device. Failures (for example
   before the Firestore rules allow sessions) are logged, never fatal. */
export async function startSession(user, onEnded) {
  let id = readSessionId();
  try {
    const device = await describeDevice();
    const fields = {
      ...device,
      email: user.email || "",
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
      lastActiveAt: serverTimestamp()
    };
    let existing = null;
    if (id) existing = await getDoc(sessionRef(user.uid, id));
    if (existing?.exists() && existing.data().revoked) {
      onEnded();
      return;
    }
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
    if (!snap.exists() || snap.data().revoked) end();
  }, (error) => console.warn("Could not watch the login session:", error.message));

  // Keep "last active" current while a page is open and in front.
  const beat = () => {
    if (ended || document.visibilityState !== "visible") return;
    updateDoc(sessionRef(user.uid, id), { lastActiveAt: serverTimestamp() }).catch(() => {});
  };
  setInterval(beat, HEARTBEAT_MS);
  document.addEventListener("visibilitychange", beat);
}

// Logout: removes this browser's session, then signs out.
export async function endCurrentSession() {
  const user = auth.currentUser;
  const id = readSessionId();
  writeSessionId("");
  if (user && id) await deleteDoc(sessionRef(user.uid, id)).catch(() => {});
}

// Signed out because the session was ended elsewhere.
export async function signOutEndedSession() {
  // The ended record has done its job; remove it so the list stays short.
  const user = auth.currentUser;
  const id = readSessionId();
  if (user && id) await deleteDoc(sessionRef(user.uid, id)).catch(() => {});
  writeSessionId("");
  await signOut(auth).catch(() => {});
  window.location.href = `Home.html?reason=${SESSION_ENDED_REASON}`;
}

// The signed-in admin's live sessions, newest activity first.
export async function listSessions() {
  const user = auth.currentUser;
  if (!user) return [];
  const snap = await getDocs(sessionsOf(user.uid));
  const current = readSessionId();
  const ms = (t) => (t?.toMillis ? t.toMillis() : 0);
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data(), current: d.id === current }))
    .filter((s) => !s.revoked)
    .sort((a, b) => (b.current - a.current) || (ms(b.lastActiveAt) - ms(a.lastActiveAt)));
}

// Ends one session on another device.
export async function endSession(id) {
  const user = auth.currentUser;
  if (!user) throw new Error("Your session has expired. Sign in again.");
  await updateDoc(sessionRef(user.uid, id), { revoked: true, revokedAt: serverTimestamp() });
}

// Ends every session except this one. Resolves to how many were ended.
export async function endOtherSessions() {
  const others = (await listSessions()).filter((s) => !s.current);
  if (!others.length) return 0;
  const batch = writeBatch(db);
  const uid = auth.currentUser.uid;
  others.forEach((s) => batch.update(sessionRef(uid, s.id), { revoked: true, revokedAt: serverTimestamp() }));
  await batch.commit();
  return others.length;
}
