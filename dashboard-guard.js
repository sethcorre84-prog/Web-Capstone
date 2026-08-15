// dashboard-guard.js
import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const guardStyle = document.createElement("style");
guardStyle.id = "dashboard-guard-style";
guardStyle.textContent = `
  html {
    visibility: hidden;
    opacity: 0;
    background: #f1f5f9;
    transition: opacity 0.15s ease;
  }
  html.authorized {
    visibility: visible;
    opacity: 1;
  }
`;

document.head.appendChild(guardStyle);

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

  // User is a verified admin — safe to show the page
  console.log("Access granted:", user.email);
  document.documentElement.classList.add("authorized");
  document.body.classList.add("authorized");
});