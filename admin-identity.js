// admin-identity.js
// Puts the signed-in admin's own name, role and initials into the sidebar
// account chip and the top-bar avatar on every admin page, in place of the
// "Admin User" / "AU" placeholders baked into the markup.
//
// Name comes from Settings > Profile Information, saved to admins/{uid}.name
// and mirrored to the Firebase Auth displayName. If neither is set yet, the
// placeholder text is left alone, so nothing changes until a name is saved.

import { auth, db } from './firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// What every page's markup already shows, so an admin doc with no `role`
// reads the same in the Profile dialog as in the sidebar.
export const DEFAULT_ADMIN_ROLE = 'Super Administrator';

export function adminInitials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'AU';
  return words.slice(0, 2).map((word) => word[0].toUpperCase()).join('');
}

// Settings calls this straight after a save so the current page updates
// without waiting for a reload; every other page runs it on sign-in below.
export function renderAdminIdentity({ name, role } = {}) {
  const cleanName = String(name || '').trim();
  const cleanRole = String(role || '').trim();

  if (cleanName) {
    document.querySelectorAll('.user-chip .name').forEach((el) => { el.textContent = cleanName; });
    document.querySelectorAll('.user-chip .avatar, .admin-mini .avatar').forEach((el) => {
      el.textContent = adminInitials(cleanName);
      el.title = cleanName;
    });
  }
  if (cleanRole) {
    document.querySelectorAll('.user-chip .role').forEach((el) => { el.textContent = cleanRole; });
  }
}

onAuthStateChanged(auth, async (user) => {
  if (!user) return; // The page's own guard handles signed-out visitors.

  // Auth's displayName is already in hand, so show it right away; the admin
  // doc (which also carries the role) follows once it has loaded.
  renderAdminIdentity({ name: user.displayName });

  try {
    const snap = await getDoc(doc(db, 'admins', user.uid));
    if (!snap.exists()) return;
    const data = snap.data();
    renderAdminIdentity({ name: data.name || user.displayName, role: data.role });
  } catch (error) {
    console.warn('Could not load the admin profile for the account chip:', error.message);
  }
});
