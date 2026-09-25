// account-status.js
// User Management > Deactivate User sets a person's record in `users` to
// Inactive. This is what makes that status actually count on the admin
// portal: login.js refuses to sign a deactivated account in, and
// dashboard-guard.js signs one out, both on page load and the moment another
// admin deactivates it while it is signed in.
//
// Hikers sign in through the PeakPath mobile app, which lives outside this
// repo; it has to make the same check for deactivation to reach them.

import { db } from './firebase-config.js';
import {
  collection, doc, getDoc, getDocs, limit, onSnapshot, query, where
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// "Pending" is deliberately not here: it means not yet approved, which is a
// different decision from being switched off.
export const BLOCKED_STATUSES = ['inactive', 'suspended', 'blocked', 'deactivated', 'disabled', 'banned'];

export const isBlockedStatus = (status) =>
  BLOCKED_STATUSES.includes(String(status ?? '').trim().toLowerCase());

const statusOf = (data) => data?.status ?? data?.Status;

/* ---------------------------------------------------------------------------
   Timed suspensions

   User Management > Suspend sets, on the `users` record:

     status          "Suspended"
     suspendedUntil  Timestamp   when it lifts (absent/null = no end date)
     suspendedAt     Timestamp   when it started
     suspendedBy     string      the admin's uid
     suspensionDays  number      what the admin typed
     suspensionReason string     optional, shown to the hiker

   A suspension ends by itself: nothing has to run on the hour. Every check
   compares suspendedUntil with the clock, so the moment it passes the account
   reads as active again, whether or not anyone has opened the admin portal.
   The portal writes `status` back to Active the next time it sees the record,
   which is tidying up, not what makes the account work again.
   --------------------------------------------------------------------------- */

// Firestore Timestamp | Date | ISO string | epoch ms -> Date | null
export const toDateValue = (value) => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value?.toDate === 'function') return value.toDate();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'object' && typeof value.seconds === 'number') return new Date(value.seconds * 1000);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

/* What a record's suspension amounts to right now.
     active  -> still serving it, so the account is blocked
     expired -> the end date has passed; the stored status is just stale
   A "Suspended" record with no end date is treated as active (indefinite),
   which is what picking Suspended in Edit User without a date means. */
export function suspensionState(data, now = new Date()) {
  const suspended = String(statusOf(data) ?? '').trim().toLowerCase() === 'suspended';
  if (!suspended) return { suspended: false, active: false, expired: false, until: null };

  const until = toDateValue(data?.suspendedUntil ?? data?.suspendedTill ?? data?.suspensionEndsAt);
  if (!until) return { suspended: true, active: true, expired: false, until: null };

  const expired = until.getTime() <= now.getTime();
  return { suspended: true, active: !expired, expired, until };
}

/* The one rule both clients follow. Every blocked status locks the account,
   except a suspension whose end date has already passed. */
export function isRecordBlocked(data, now = new Date()) {
  const state = suspensionState(data, now);
  if (state.suspended) return state.active;
  return isBlockedStatus(statusOf(data));
}

/* Finds the `users` record behind a sign-in account. App sign-ups are keyed
   by the Firebase uid; records added from the portal get a random id, so
   those are matched by their `uid` field or, failing that, their email.
   Resolves to a DocumentReference, or null when there is no record. */
export async function findUserRecord(authUser) {
  const byId = doc(db, 'users', authUser.uid);
  if ((await getDoc(byId)).exists()) return byId;

  const email = String(authUser.email || '');
  const lookups = [['uid', authUser.uid], ['email', email], ['email', email.toLowerCase()]];
  const tried = new Set();
  for (const [field, value] of lookups) {
    const key = `${field}:${value}`;
    if (!value || tried.has(key)) continue;
    tried.add(key);
    const snap = await getDocs(query(collection(db, 'users'), where(field, '==', value), limit(1)));
    if (!snap.empty) return snap.docs[0].ref;
  }
  return null;
}

// One-off check, for sign-in and page load.
export async function isAccountBlocked(authUser) {
  const ref = await findUserRecord(authUser);
  if (!ref) return false; // no users record, so nothing has marked it inactive
  const snap = await getDoc(ref);
  return snap.exists() && isRecordBlocked(snap.data());
}

/* Live watch for a signed-in session: calls onBlocked once, as soon as the
   record flips to a blocked status. Resolves to an unsubscribe function. */
export async function watchAccountStatus(authUser, onBlocked) {
  const ref = await findUserRecord(authUser);
  if (!ref) return () => {};
  let fired = false;
  return onSnapshot(ref, (snap) => {
    if (fired || !snap.exists() || !isRecordBlocked(snap.data())) return;
    fired = true;
    onBlocked();
  }, (error) => {
    console.warn('Could not watch account status:', error.message);
  });
}
