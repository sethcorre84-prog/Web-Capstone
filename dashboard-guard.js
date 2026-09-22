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