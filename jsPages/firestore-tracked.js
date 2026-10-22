// firestore-tracked.js
// The Firestore SDK, for the pages and modules where an admin saves things,
// with one addition: every successful save (add, set, update, delete, or a
// batch) also records the time on the admin's own admins/{uid}.updatedAt.
// Settings > Last Updated (Setting.html, watchLastUpdated) shows the newest
// of those, so a save on any page counts.
//
// Import from here instead of the gstatic URL: everything else is the SDK
// itself, re-exported unchanged. Background writes that are not an admin
// saving something (login sessions, sign-in, chat, Analytics' history) keep
// importing the SDK directly, so they don't move the date.
//
// admins/{uid}.updatedAt is one of the fields an admin may write on their own
// record (firestore.rules), so no rule change is needed.

import * as sdk from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { auth, db } from './firebase-config.js';

export * from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// One write at most every few seconds: a batch of edits is one save.
const MIN_GAP_MS = 5000;
let lastMarked = 0;

export function markPortalSaved() {
  const uid = auth.currentUser?.uid;
  if (!uid || Date.now() - lastMarked < MIN_GAP_MS) return;
  lastMarked = Date.now();
  sdk.updateDoc(sdk.doc(db, 'admins', uid), { updatedAt: sdk.serverTimestamp() })
    .catch(() => { lastMarked = 0; });
}

const tracked = (write) => async (...args) => {
  const result = await write(...args);
  markPortalSaved();
  return result;
};

export const addDoc = tracked(sdk.addDoc);
export const setDoc = tracked(sdk.setDoc);
export const updateDoc = tracked(sdk.updateDoc);
export const deleteDoc = tracked(sdk.deleteDoc);

export function writeBatch(...args) {
  const batch = sdk.writeBatch(...args);
  const commit = batch.commit.bind(batch);
  batch.commit = async () => {
    const result = await commit();
    markPortalSaved();
    return result;
  };
  return batch;
}

export const runTransaction = async (...args) => {
  const result = await sdk.runTransaction(...args);
  markPortalSaved();
  return result;
};
