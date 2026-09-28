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
// It also makes the PeakPath logo beside the notification bell open a small
// profile card for the signed-in admin (name, role, username, email, phone,
// gender), with a link to Settings > Profile Information to edit it.

import { auth, db } from './firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { doc, getDoc, serverTimestamp, setDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// What every page's markup already shows, so an admin doc with no `role`
// reads the same in the Profile dialog as in the sidebar.
export const DEFAULT_ADMIN_ROLE = 'Super Administrator';

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

/* ---------- Profile card ---------- */

// What the card shows. Filled on sign-in; Settings updates it after a save.
const profile = { name: '', role: DEFAULT_ADMIN_ROLE, username: '', email: '', phone: '', gender: '' };

export function updateAdminProfile(changes = {}) {
  Object.assign(profile, changes);
  if (document.getElementById('adminProfileOverlay')?.classList.contains('open')) fillProfileCard();
}

const escapeText = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const PROFILE_ROWS = [
  ['username', 'Username', 'fa-at'],
  ['email', 'Email', 'fa-envelope'],
  ['phone', 'Phone Number', 'fa-phone'],
  ['gender', 'Gender', 'fa-venus-mars']
];

function fillProfileCard() {
  document.getElementById('adminProfileName').textContent = profile.name || 'Admin';
  document.getElementById('adminProfileRole').textContent = profile.role || DEFAULT_ADMIN_ROLE;
  document.getElementById('adminProfileRows').innerHTML = PROFILE_ROWS.map(([key, label, icon]) => `
    <div class="admin-profile-row">
      <span class="admin-profile-row-icon"><i class="fa-solid ${icon}" aria-hidden="true"></i></span>
      <span class="admin-profile-row-label">${label}</span>
      <span class="admin-profile-row-value${profile[key] ? '' : ' empty'}">${escapeText(profile[key] || 'Not set')}</span>
    </div>`).join('');
}

function buildProfileCard() {
  const overlay = document.createElement('div');
  overlay.id = 'adminProfileOverlay';
  overlay.className = 'admin-profile-overlay';
  overlay.innerHTML = `
    <div class="admin-profile-card" role="dialog" aria-modal="true" aria-labelledby="adminProfileName">
      <button type="button" class="admin-profile-close" aria-label="Close profile"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
      <div class="admin-profile-banner"></div>
      <div class="admin-profile-avatar"><img src="../assets/images/logo.png" alt="PeakPath logo"></div>
      <h3 class="admin-profile-name" id="adminProfileName">Admin</h3>
      <span class="admin-profile-role" id="adminProfileRole"></span>
      <div class="admin-profile-rows" id="adminProfileRows"></div>
      <div class="admin-profile-actions">
        <a class="admin-profile-edit" href="Setting.html?open=profile"><i class="fa-solid fa-pen" aria-hidden="true"></i>Edit Profile</a>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay || event.target.closest('.admin-profile-close')) closeProfileCard();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && overlay.classList.contains('open')) closeProfileCard();
  });
  return overlay;
}

let lastTrigger = null;

function openProfileCard(trigger) {
  const overlay = document.getElementById('adminProfileOverlay') || buildProfileCard();
  fillProfileCard();
  lastTrigger = trigger;
  overlay.classList.add('open');
  overlay.querySelector('.admin-profile-close').focus();
}

function closeProfileCard() {
  document.getElementById('adminProfileOverlay')?.classList.remove('open');
  lastTrigger?.focus();
}

// The logo beside the bell (in .topbar-right, or loose with .topbar-logo).
document.querySelectorAll('.topbar-right .avatar-logo, .avatar-logo.topbar-logo').forEach((logo) => {
  logo.classList.add('profile-trigger');
  logo.setAttribute('role', 'button');
  logo.setAttribute('tabindex', '0');
  logo.setAttribute('aria-label', 'View admin profile');
  logo.title = 'View admin profile';
  logo.addEventListener('click', (event) => {
    event.stopPropagation();
    openProfileCard(logo);
  });
  logo.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openProfileCard(logo);
  });
});

// Show the cached name before sign-in resolves. It is only trusted for the
// admin who saved it; a different account overwrites it below.
{
  const cached = readCachedIdentity();
  applyIdentity(cached.name || '', cached.role || '');
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
  updateAdminProfile({ name: user.displayName || '', email: user.email || '' });

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
    renderAdminIdentity({ name: data.name || user.displayName, role: data.role });
    showFallbackName();
    updateAdminProfile({
      name: data.name || user.displayName || '',
      role: data.role || DEFAULT_ADMIN_ROLE,
      username: data.username || '',
      phone: data.phone || '',
      gender: data.gender || ''
    });
  } catch (error) {
    console.warn('Could not load the admin profile for the account chip:', error.message);
    showFallbackName();
  }
});
