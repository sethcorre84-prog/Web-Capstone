// login.js
import { auth, db } from "./firebase-config.js";
import {
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc,
  getDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { isAccountBlocked } from "./account-status.js";

const DEACTIVATED_MESSAGE =
  "This account has been deactivated. Ask another administrator to reactivate it in User Management.";

// Each kind of failure gets its own look and guidance. `fields` names the
// inputs to mark red; `reset` offers the forgot-password flow from the alert.
const ALERTS = {
  missing: {
    variant: "warning",
    icon: "fa-pen-to-square",
    eyebrow: "Incomplete form",
    title: "A few details are missing",
    message: "Enter both your email address and password to sign in."
  },
  invalidEmail: {
    variant: "warning",
    icon: "fa-at",
    eyebrow: "Check your email",
    title: "That email doesn't look right",
    message: "Use the full address for your admin account, for example admin@peakpath.com.",
    fields: ["email"]
  },
  wrongCredentials: {
    variant: "danger",
    icon: "fa-lock",
    eyebrow: "Sign-in failed",
    title: "Incorrect email or password",
    message: "The details you entered don't match an admin account.",
    hint: "Passwords are case-sensitive. Check that Caps Lock is off.",
    // Password first: that's where the cursor goes after the alert closes.
    fields: ["password", "email"],
    reset: true
  },
  tooManyRequests: {
    variant: "warning",
    icon: "fa-hourglass-half",
    eyebrow: "Temporarily locked",
    title: "Too many attempts",
    message: "Sign-in has been paused for this account after several failed tries. Wait a few minutes and try again.",
    hint: "You can reset your password now to regain access right away.",
    reset: true
  },
  network: {
    variant: "warning",
    icon: "fa-wifi",
    eyebrow: "Connection problem",
    title: "Couldn't reach PeakPath",
    message: "Check your internet connection and try again."
  },
  notAdmin: {
    variant: "danger",
    icon: "fa-user-shield",
    eyebrow: "Access denied",
    title: "This account isn't an admin",
    message: "Only PeakPath administrators can sign in here. Hikers should use the PeakPath mobile app."
  },
  deactivated: {
    variant: "danger",
    icon: "fa-user-lock",
    eyebrow: "Account deactivated",
    title: "Your access has been turned off",
    message: DEACTIVATED_MESSAGE
  },
  signedOut: {
    variant: "danger",
    icon: "fa-user-lock",
    eyebrow: "Signed out",
    title: "Your access has been turned off",
    message: DEACTIVATED_MESSAGE
  },
  unknown: {
    variant: "danger",
    icon: "fa-triangle-exclamation",
    eyebrow: "Sign-in error",
    title: "Something went wrong",
    message: "We couldn't sign you in. Please try again in a moment."
  }
};

let alertFocusTarget = null;

function showErrorModal(kind, fields) {
  const alert = ALERTS[kind] || ALERTS.unknown;
  fields = fields || alert.fields || [];
  const box = document.querySelector("#errorModal .alert-box");

  box.dataset.variant = alert.variant;
  document.getElementById("errorModalIcon").className = `fa-solid ${alert.icon}`;
  document.getElementById("errorModalEyebrow").textContent = alert.eyebrow;
  document.getElementById("errorModalTitle").textContent = alert.title;
  document.getElementById("errorModalMessage").textContent = alert.message;

  const hint = document.getElementById("errorModalHint");
  hint.hidden = !alert.hint;
  document.getElementById("errorModalHintText").textContent = alert.hint || "";
  document.getElementById("errorModalReset").hidden = !alert.reset;

  markInvalidFields(fields);
  shakeCard();

  // After closing, put the cursor where the admin needs to fix things.
  alertFocusTarget = fields[0] || null;

  document.getElementById("errorModal").classList.add("show");
  document.getElementById("errorModalClose").focus();
}

function closeErrorModal() {
  document.getElementById("errorModal").classList.remove("show");
  if (alertFocusTarget) {
    const input = document.getElementById(alertFocusTarget);
    input.focus();
    input.select();
  }
}

function markInvalidFields(ids) {
  ["email", "password"].forEach((id) => {
    document.getElementById(id).closest(".input-box").classList.toggle("invalid", ids.includes(id));
  });
}

function shakeCard() {
  const card = document.querySelector(".login-card");
  card.classList.remove("shake");
  void card.offsetWidth; // restart the animation if it is already applied
  card.classList.add("shake");
}

let signingIn = false;

function setSigningIn(active) {
  signingIn = active;
  const button = document.querySelector('#loginForm button[type="submit"]');
  button.disabled = active;
  button.innerHTML = active
    ? '<i class="fa-solid fa-circle-notch fa-spin"></i> Signing in...'
    : '<i class="fa-solid fa-right-to-bracket"></i> Sign In';
}

function login() {
  if (signingIn) return;

  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;

  if (!email || !password) {
    showErrorModal("missing", [!email && "email", !password && "password"].filter(Boolean));
    return;
  }

  setSigningIn(true);

  signInWithEmailAndPassword(auth, email, password)
    .then(async (userCredential) => {
      const user = userCredential.user;

      // Check if this user's UID exists in the "admins" collection
      const adminDocRef = doc(db, "admins", user.uid);
      const adminDocSnap = await getDoc(adminDocRef);

      if (adminDocSnap.exists()) {
        // An admin — but not one that User Management has deactivated.
        // A failed status read lets them through; the admins check above
        // is still the gate, and one flaky read should not lock everyone out.
        const blocked = await isAccountBlocked(user).catch((error) => {
          console.warn("Could not check account status:", error.message);
          return false;
        });
        if (blocked) {
          await signOut(auth);
          setSigningIn(false);
          showErrorModal("deactivated");
          return;
        }

        // User is a verified admin — proceed
        console.log("Admin verified:", user.email);
        window.location.href = "dashboard.html";
      } else {
        // Not an admin — sign them out immediately
        await signOut(auth);
        setSigningIn(false);
        showErrorModal("notAdmin");
      }
    })
    .catch((error) => {
      console.error(error.code, error.message);
      setSigningIn(false);
      handleLoginError(error.code);
    });
}

function handleLoginError(code) {
  switch (code) {
    case "auth/invalid-email":
      showErrorModal("invalidEmail");
      break;
    case "auth/user-not-found":
    case "auth/invalid-credential":
    case "auth/wrong-password":
      showErrorModal("wrongCredentials");
      break;
    case "auth/too-many-requests":
      showErrorModal("tooManyRequests");
      break;
    case "auth/network-request-failed":
      showErrorModal("network");
      break;
    default:
      showErrorModal("unknown");
  }
}

// Same message whether or not the account exists, so the form can't be
// used to discover which emails are registered.
const RESET_SENT_MESSAGE =
  "If an account exists for that email, a reset link has been sent. Check your inbox and spam folder.";

function setForgotStatus(message, type = "") {
  const status = document.getElementById("forgotStatus");
  status.textContent = message;
  status.className = "forgot-status" + (type ? ` ${type}` : "");
}

function openForgotModal() {
  const forgotEmail = document.getElementById("forgotEmail");
  // Carry over whatever the admin already typed on the login form.
  forgotEmail.value = document.getElementById("email").value.trim();
  setForgotStatus("");
  document.getElementById("forgotSubmit").disabled = false;
  document.getElementById("forgotModal").classList.add("show");
  forgotEmail.focus();
}

function closeForgotModal() {
  document.getElementById("forgotModal").classList.remove("show");
}

async function sendResetLink() {
  const email = document.getElementById("forgotEmail").value.trim();
  const submitBtn = document.getElementById("forgotSubmit");

  if (!email) {
    setForgotStatus("Please enter your email address.", "error");
    return;
  }

  submitBtn.disabled = true;
  setForgotStatus("Sending...");

  try {
    await sendPasswordResetEmail(auth, email);
    setForgotStatus(RESET_SENT_MESSAGE, "success");
  } catch (error) {
    console.error(error.code, error.message);
    let message = "Could not send the reset link. Please try again.";
    switch (error.code) {
      case "auth/invalid-email":
        message = "That email address looks invalid.";
        break;
      case "auth/user-not-found":
        setForgotStatus(RESET_SENT_MESSAGE, "success");
        return;
      case "auth/too-many-requests":
        message = "Too many requests. Please wait and try again.";
        break;
      case "auth/network-request-failed":
        message = "Network error. Check your connection and try again.";
        break;
    }
    setForgotStatus(message, "error");
    submitBtn.disabled = false;
  }
}

// Close modal on button click
document.addEventListener("DOMContentLoaded", () => {
  // dashboard-guard.js sends a deactivated admin here; say why, once.
  const params = new URLSearchParams(window.location.search);
  if (params.get("reason") === "deactivated") {
    showErrorModal("signedOut");
    params.delete("reason");
    const query = params.toString();
    history.replaceState(null, "", window.location.pathname + (query ? `?${query}` : "") + window.location.hash);
  }

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

  closeBtn.addEventListener("click", closeErrorModal);
  document.getElementById("errorModalDismiss").addEventListener("click", closeErrorModal);

  document.getElementById("errorModalReset").addEventListener("click", () => {
    alertFocusTarget = null;
    closeErrorModal();
    openForgotModal();
  });

  // Also close if clicking outside the box
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      closeErrorModal();
    }
  });

  // The red highlight clears as soon as the admin starts fixing the field.
  [emailInput, passwordInput].forEach((input) => {
    input.addEventListener("input", () => {
      input.closest(".input-box").classList.remove("invalid");
    });
  });

  const forgotLink = document.getElementById("forgotPasswordLink");
  const forgotModal = document.getElementById("forgotModal");
  const forgotForm = document.getElementById("forgotForm");

  forgotLink.addEventListener("click", (event) => {
    event.preventDefault();
    openForgotModal();
  });

  forgotForm.addEventListener("submit", (event) => {
    event.preventDefault();
    sendResetLink();
  });

  document.getElementById("forgotCancel").addEventListener("click", closeForgotModal);

  forgotModal.addEventListener("click", (e) => {
    if (e.target === forgotModal) {
      closeForgotModal();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (forgotModal.classList.contains("show")) {
      closeForgotModal();
    } else if (overlay.classList.contains("show")) {
      closeErrorModal();
    }
  });
});

window.login = login;