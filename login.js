// login.js
import { auth, db } from "./firebase-config.js";
import {
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc,
  getDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

function showErrorModal(message, title = "Login Failed") {
  document.getElementById("errorModalTitle").textContent = title;
  document.getElementById("errorModalMessage").textContent = message;
  document.getElementById("errorModal").classList.add("show");
}

function login() {
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;

  if (!email || !password) {
    showErrorModal("Please enter both email and password.", "Missing Info");
    return;
  }

  signInWithEmailAndPassword(auth, email, password)
    .then(async (userCredential) => {
      const user = userCredential.user;

      // Check if this user's UID exists in the "admins" collection
      const adminDocRef = doc(db, "admins", user.uid);
      const adminDocSnap = await getDoc(adminDocRef);

      if (adminDocSnap.exists()) {
        // User is a verified admin — proceed
        console.log("Admin verified:", user.email);
        window.location.href = "dashboard.html";
      } else {
        // Not an admin — sign them out immediately
        await signOut(auth);
        showErrorModal("This account is not authorized as an admin.", "Access Denied");
      }
    })
    .catch((error) => {
      console.error(error.code, error.message);
      handleLoginError(error.code);
    });
}

function handleLoginError(code) {
  let message = "Something went wrong. Please try again.";

  switch (code) {
    case "auth/invalid-email":
      message = "That email address looks invalid.";
      break;
    case "auth/user-not-found":
    case "auth/invalid-credential":
    case "auth/wrong-password":
      message = "Wrong email or password.";
      break;
    case "auth/too-many-requests":
      message = "Too many attempts. Please wait and try again.";
      break;
  }

  showErrorModal(message, "Login Failed");
}

// Close modal on button click
document.addEventListener("DOMContentLoaded", () => {
  const closeBtn = document.getElementById("errorModalClose");
  const overlay = document.getElementById("errorModal");
  const loginForm = document.getElementById("loginForm");
  const emailInput = document.getElementById("email");
  const passwordInput = document.getElementById("password");
  const passwordToggle = document.querySelector(".password-toggle");

  if (passwordToggle && passwordInput) {
    passwordToggle.addEventListener("click", () => {
      const isPasswordHidden = passwordInput.type === "password";
      passwordInput.type = isPasswordHidden ? "text" : "password";
      const toggleIcon = passwordToggle.querySelector("i");

      passwordToggle.setAttribute("aria-label", isPasswordHidden ? "Hide password" : "Show password");
      passwordToggle.title = isPasswordHidden ? "Hide password" : "Show password";

      toggleIcon.classList.toggle("fa-eye", !isPasswordHidden);
      toggleIcon.classList.toggle("fa-eye-slash", isPasswordHidden);
    });
  }

  if (loginForm) {
    loginForm.addEventListener("submit", (event) => {
      event.preventDefault();
      login();
    });
  }

  [emailInput, passwordInput].forEach((input) => {
    if (!input) return;

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.keyCode === 13) {
        event.preventDefault();
        login();
      }
    });
  });

  document.addEventListener("keydown", (event) => {
    const active = document.activeElement;
    if ((event.key === "Enter" || event.keyCode === 13) && active && (active.id === "email" || active.id === "password")) {
      event.preventDefault();
      login();
    }
  });

  closeBtn.addEventListener("click", () => {
    overlay.classList.remove("show");
  });

  // Also close if clicking outside the box
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      overlay.classList.remove("show");
    }
  });
});

window.login = login;