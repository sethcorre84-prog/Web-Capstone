// admin-identity.js
// Puts the signed-in admin's own name, role and initials into the sidebar
// account chip and the top-bar avatar on every admin page, in place of the
// "Admin User" / "AU" placeholders baked into the markup.
//
// Name comes from Settings > Profile Information, saved to admins/{uid}.name
// and mirrored to the Firebase Auth displayName. The markup leaves the name
// blank so no placeholder flashes between pages; if no name is saved at all,
// "Admin User" is filled in once the admin doc has loaded.
//
// It also makes the PeakPath logo beside the notification bell open the
// signed-in admin's Profile page (profile.html: name, role, username,
// email, phone, gender, and their Community posts).

import { auth, db } from './firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { doc, getDoc, serverTimestamp, setDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// An admin record with no valid `role` has no access: the page guard and the
// login page sign it out, and firestore.rules (isAdmin()) refuse it. A Super
// Administrator assigns the role in Role Management. This is what such an
// account's role reads as wherever it is shown.
export const NO_ROLE_LABEL = 'No role assigned';

export function adminInitials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'AU';
  return words.slice(0, 2).map((word) => word[0].toUpperCase()).join('');
}

// The last name/role shown is kept in this browser so the next page can show
// it straight away, instead of a blank chip until Firebase has signed in.
const IDENTITY_KEY = 'peakpath-admin-identity';
const FALLBACK_NAME = 'Admin User';

const readCachedIdentity = () => {
  try { return JSON.parse(localStorage.getItem(IDENTITY_KEY)) || {}; } catch { return {}; }
};

const cacheIdentity = (changes) => {
  try { localStorage.setItem(IDENTITY_KEY, JSON.stringify({ ...readCachedIdentity(), ...changes })); } catch { /* storage blocked */ }
};

// Settings calls this straight after a save so the current page updates
// without waiting for a reload; every other page runs it on sign-in below.
export function renderAdminIdentity({ name, role } = {}) {
  const cleanName = String(name || '').trim();
  const cleanRole = String(role || '').trim();

  if (cleanName) cacheIdentity({ name: cleanName });
  if (cleanRole) cacheIdentity({ role: cleanRole });
  applyIdentity(cleanName, cleanRole);
}

function applyIdentity(cleanName, cleanRole) {
  if (cleanName) {
    // The Dashboard greeting addresses the admin by first name.
    document.dispatchEvent(new CustomEvent('peakpath:admin-name', { detail: { name: cleanName } }));
    document.querySelectorAll('.user-chip .name').forEach((el) => { el.textContent = cleanName; });
    // Avatars that show the PeakPath logo keep it; writing initials into one
    // would replace the logo image with text ("MR").
    document.querySelectorAll('.user-chip .avatar:not(.avatar-logo), .admin-mini .avatar:not(.avatar-logo)').forEach((el) => {
      el.textContent = adminInitials(cleanName);
      el.title = cleanName;
    });
    document.querySelectorAll('.user-chip .avatar-logo').forEach((el) => { el.title = cleanName; });
  }
  if (cleanRole) {
    document.querySelectorAll('.user-chip .role').forEach((el) => { el.textContent = cleanRole; });
  }
}

/* ---------- Profile ---------- */

// The signed-in admin as the Profile page shows them. Filled on sign-in;
// Settings updates it after a save.
const profile = { uid: '', name: '', role: '', username: '', email: '', phone: '', gender: '' };
const profileListeners = new Set();

export function updateAdminProfile(changes = {}) {
  Object.assign(profile, changes);
  profileListeners.forEach((listener) => listener({ ...profile }));
}

// Calls `listener` with the profile now and on every change; returns a
// function that stops it.
export function watchAdminProfile(listener) {
  profileListeners.add(listener);
  listener({ ...profile });
  return () => profileListeners.delete(listener);
}

// The logo beside the bell (in .topbar-right, or loose with .topbar-logo)
// opens the Profile page.
document.querySelectorAll('.topbar-right .avatar-logo, .avatar-logo.topbar-logo').forEach((logo) => {
  logo.classList.add('profile-trigger');
  const open = () => { window.location.href = 'profile.html'; };
  logo.setAttribute('role', 'link');
  logo.setAttribute('tabindex', '0');
  logo.setAttribute('aria-label', 'View your profile');
  logo.title = 'View your profile';
  logo.addEventListener('click', (event) => {
    event.stopPropagation();
    open();
  });
  logo.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    open();
  });
});

/* ---- Admin roles (Settings > Role & Permission Settings) ----
   Super Administrator and Administrator can change things; a Viewer can only
   look. firestore.rules enforce that (isEditor()); this makes the pages say
   so: a "view-only" banner, and the buttons that change data dimmed and
   inert, so a Viewer is not left clicking buttons that will be refused.
   The role is put on <html data-admin-role> and announced with a
   "peakpath:admin-role" event for any page that wants it. */
export const ADMIN_ROLES = ['Super Administrator', 'Administrator', 'Viewer'];
// The role if it is one of ADMIN_ROLES, otherwise '' (no role: no access).
export const roleOf = (role) => (ADMIN_ROLES.includes(role) ? role : '');
export const hasAdminRole = (role) => ADMIN_ROLES.includes(role);

// Buttons and links that change data, across the portal.
const EDIT_CONTROLS = [
  // Dashboard quick actions
  '[data-quick-action]', 'a[href*="add=checkpoint"]',
  // Trail Management
  '#addTrailBtn', '#editTrailBtn', '#deleteTrailBtn', '#addCheckpointBtn', '#addCampsiteBtn',
  '#addSuggestedCheckpointsBtn', '.visibility-btn', '.more-btn', '.st-save-btn', '[data-se]', '.tp-popup button',
  '#addFeaturedBtn', '.featured-remove',
  // Hazard Reports
  '.btn-verify', '.btn-resolve', '.btn-reject', '#archiveSelectedBtn', '#archiveResolvedBtn',
  // Advisories & Announcements
  '#createBtn', '#editBtn', '#endBtn', '.row-actions .icon-btn',
  // Emergency Monitoring
  '#emRespondBtn', '#emResolveBtn', '#alertBannerButton',
  // User Management / User Reports
  '#addUserBtn', '#resetPasswordBtn', '#suspendUserBtn', '#deactivateUserBtn',
  '#warnUserBtn', '#resolveReportBtn',
  // Settings: archives (profile and password stay the admin's own)
  '#archiveDetailUnarchiveBtn', '#deleteArchiveConfirmBtn', '#unarchiveModalConfirmBtn', '#unarchiveAdvisoryConfirmBtn'
];

function applyAdminRole(role) {
  const clean = roleOf(role);
  const root = document.documentElement;
  if (root.dataset.adminRole === clean) return;
  root.dataset.adminRole = clean;
  window.dispatchEvent(new CustomEvent('peakpath:admin-role', { detail: { role: clean } }));
  if (clean === 'Viewer') enterViewOnly();
  else document.getElementById('viewOnlyBanner')?.remove();
}

let viewOnlyReady = false;
function enterViewOnly() {
  if (!viewOnlyReady) {
    viewOnlyReady = true;
    const list = EDIT_CONTROLS.join(',');
    document.head.appendChild(Object.assign(document.createElement('style'), {
      textContent: `
html[data-admin-role="Viewer"] :is(${list}) { opacity:.45 !important; cursor:not-allowed !important; }
.view-only-banner { display:flex; align-items:center; gap:10px; margin:0 0 16px; padding:10px 14px; border-radius:10px;
  border:1px solid #e3d3a8; background:#fdf6e3; color:#6b5413; font-size:13px; line-height:1.45; }
.view-only-banner i { color:#b9791b; }`
    }));
    // Clicks (and Enter/Space on a focused control) on those are stopped.
    document.addEventListener('click', (event) => {
      if (document.documentElement.dataset.adminRole !== 'Viewer') return;
      const control = event.target.closest?.(list);
      if (!control) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  }
  if (!document.getElementById('viewOnlyBanner')) {
    const main = document.querySelector('main, .main, .main-panel');
    if (!main) return;
    const banner = document.createElement('div');
    banner.id = 'viewOnlyBanner';
    banner.className = 'view-only-banner';
    banner.setAttribute('role', 'status');
    banner.innerHTML = '<i class="fa-solid fa-eye" aria-hidden="true"></i><span><strong>View-only access.</strong> Your role is Viewer: you can see everything, but changes are turned off. A Super Administrator can change your role in Settings.</span>';
    const header = main.querySelector('.top-bar, .topbar');
    if (header) header.after(banner);
    else main.prepend(banner);
  }
}

// Show the cached name before sign-in resolves. It is only trusted for the
// admin who saved it; a different account overwrites it below.
{
  const cached = readCachedIdentity();
  applyIdentity(cached.name || '', cached.role || '');
  if (cached.role) applyAdminRole(cached.role);
}

// No name anywhere (a brand-new admin): fall back to the old placeholder
// rather than leaving the chip blank.
const showFallbackName = () => {
  document.querySelectorAll('.user-chip .name').forEach((el) => {
    if (!el.textContent.trim()) el.textContent = FALLBACK_NAME;
  });
};

onAuthStateChanged(auth, async (user) => {
  if (!user) return; // The page's own guard handles signed-out visitors.

  const cached = readCachedIdentity();
  if (cached.uid !== user.uid) {
    try { localStorage.setItem(IDENTITY_KEY, JSON.stringify({ uid: user.uid })); } catch { /* storage blocked */ }
    if (cached.name) {
      document.querySelectorAll('.user-chip .name').forEach((el) => { el.textContent = ''; });
    }
  }

  // Auth's displayName is already in hand, so show it right away; the admin
  // doc (which also carries the role) follows once it has loaded.
  renderAdminIdentity({ name: user.displayName });
  updateAdminProfile({ uid: user.uid, name: user.displayName || '', email: user.email || '' });

  try {
    const snap = await getDoc(doc(db, 'admins', user.uid));
    if (!snap.exists()) { showFallbackName(); return; }
    const data = snap.data();

    // Keep this admin's adminEmails entry (email -> UID) in place, which is
    // what Forgot Password on the login page checks. Done here as well as at
    // login so an admin who stays signed in is registered too.
    if (user.email) {
      setDoc(doc(db, 'adminEmails', user.email.toLowerCase()), { uid: user.uid, email: user.email.toLowerCase(), updatedAt: serverTimestamp() })
        .catch((error) => console.warn('Could not register the admin email for password resets:', error.message));
    }
    renderAdminIdentity({ name: data.name || user.displayName, role: roleOf(data.role) });
    applyAdminRole(data.role);
    showFallbackName();
    updateAdminProfile({
      name: data.name || user.displayName || '',
      role: roleOf(data.role),
      username: data.username || '',
      phone: data.phone || '',
      gender: data.gender || ''
    });
  } catch (error) {
    console.warn('Could not load the admin profile for the account chip:', error.message);
    showFallbackName();
  }
});
