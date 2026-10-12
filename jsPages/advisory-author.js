import { auth, db } from './firebase-config.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// Use the signed-in account's registered name, never another account's cache.
export async function getAdvisoryAuthorName() {
  await auth.authStateReady();
  const user = auth.currentUser;
  if (!user) return 'Admin User';
  try {
    const snapshot = await getDoc(doc(db, 'admins', user.uid));
    const name = snapshot.exists() ? snapshot.data().name : '';
    if (typeof name === 'string' && name.trim()) return name.trim();
  } catch (error) {
    console.warn('Could not load the advisory author name:', error.message);
  }
  return user.displayName?.trim() || 'Admin User';
}
