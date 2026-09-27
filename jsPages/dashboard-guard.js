// dashboard-guard.js
import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { isAccountBlocked, watchAccountStatus } from "./account-status.js";

// Signs a deactivated admin out and tells them why on the login page.
const signOutDeactivated = async () => {
  await signOut(auth);
  window.location.href = "Home.html?reason=deactivated";
};

// Logout confirmation. Every Logout control (sidebar button, profile menu)
// asks first. The listener runs in the capture phase so it wins over any
// page's own logout handler, and the modal is built on first use so no page
// needs extra markup; its styles live in pages.css (.logout-modal-*).
const LOGOUT_SELECTOR = '.logout-btn, #dropdownLogoutBtn, .profile-menu a[href="Home.html"]';
let logoutModal = null;
let logoutReturnFocus = null;

function buildLogoutModal() {
  const backdrop = document.createElement("div");
  backdrop.className = "logout-modal-backdrop";
  backdrop.innerHTML = `
    <div class="logout-modal" role="dialog" aria-modal="true" aria-labelledby="logoutModalTitle" aria-describedby="logoutModalText">
      <div class="logout-modal-icon" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/></svg>
      </div>
      <h3 id="logoutModalTitle">Log out?</h3>
      <p id="logoutModalText">You'll need to sign in again to access the admin portal.</p>
      <div class="logout-modal-error" role="alert"></div>
      <div class="logout-modal-actions">
        <button type="button" class="logout-modal-cancel">Cancel</button>
        <button type="button" class="logout-modal-confirm">Log out</button>
      </div>
    </div>`;

  const confirmBtn = backdrop.querySelector(".logout-modal-confirm");
  const errorBox = backdrop.querySelector(".logout-modal-error");

  backdrop.querySelector(".logout-modal-cancel").addEventListener("click", closeLogoutModal);
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) closeLogoutModal();
  });
  confirmBtn.addEventListener("click", async () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Logging out...";
    errorBox.textContent = "";
    try {
      await signOut(auth);
      window.location.href = "Home.html";
    } catch (error) {
      console.error("Logout failed:", error);
      errorBox.textContent = "Couldn't log out. Please try again.";
      confirmBtn.disabled = false;
      confirmBtn.textContent = "Log out";
    }
  });

  document.body.appendChild(backdrop);
  return backdrop;
}

function openLogoutModal(trigger) {
  if (!logoutModal) logoutModal = buildLogoutModal();
  logoutReturnFocus = trigger;
  logoutModal.querySelector(".logout-modal-error").textContent = "";
  logoutModal.classList.add("open");
  logoutModal.querySelector(".logout-modal-cancel").focus();
}

function closeLogoutModal() {
  if (!logoutModal) return;
  logoutModal.classList.remove("open");
  logoutReturnFocus?.focus();
  logoutReturnFocus = null;
}

document.addEventListener("click", (event) => {
  const trigger = event.target.closest?.(LOGOUT_SELECTOR);
  if (!trigger) return;
  event.preventDefault();
  event.stopPropagation(); // keep a page's own handler from signing out directly
  document.getElementById("profileMenu")?.classList.remove("open");
  openLogoutModal(trigger);
}, true);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && logoutModal?.classList.contains("open")) closeLogoutModal();
});

// Show page immediately (no splash or fade)
document.documentElement.style.visibility = "visible";
document.documentElement.style.opacity = "1";
document.body.style.visibility = "visible";
document.body.style.opacity = "1";

// Runs on every page load / refresh of protected pages
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    // Not signed in at all — bounce to login immediately
    window.location.href = "Home.html";
    return;
  }

  // Signed in — but are they actually an admin?
  const adminDocRef = doc(db, "admins", user.uid);
  const adminDocSnap = await getDoc(adminDocRef);

  if (!adminDocSnap.exists()) {
    // Not an admin — sign out and bounce
    await signOut(auth);
    window.location.href = "Home.html";
    return;
  }

  // An admin, but one that User Management may have deactivated.
  // If the users collection cannot be read, fall through rather than lock
  // every admin out: the admins check above is still the gate.
  try {
    if (await isAccountBlocked(user)) {
      await signOutDeactivated();
      return;
    }
  } catch (error) {
    console.warn("Could not check account status:", error.message);
  }

  // User is a verified admin — safe to show the page
  console.log("Access granted:", user.email);

  // Deactivated by another admin while this page is open: sign out now,
  // not on the next page load.
  watchAccountStatus(user, signOutDeactivated).catch((error) => {
    console.warn("Could not watch account status:", error.message);
  });
});