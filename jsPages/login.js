// login.js
import { auth, db } from "./firebase-config.js";
import {
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc,
  getDoc,
  serverTimestamp,
  setDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { isAccountBlocked } from "./account-status.js";

// Remember me: the last admin email is kept in this browser and filled in
// the next time the login page opens. Only the email, never the password.
const REMEMBER_KEY = "peakpath-remembered-email";

const readRememberedEmail = () => {
  try { return localStorage.getItem(REMEMBER_KEY) || ""; } catch { return ""; }
};

const saveRememberedEmail = (email, remember) => {
  try {
    if (remember) localStorage.setItem(REMEMBER_KEY, email);
    else localStorage.removeItem(REMEMBER_KEY);
  } catch { /* storage blocked: the checkbox just has no effect */ }
};

/* adminEmails/{lowercase email} maps each admin's sign-in address to their
   Auth UID, so Forgot Password can find the UID for an address before anyone
   is signed in and then confirm admins/{uid} exists. The rules allow reading
   one address at a time, never listing them, and an admin can only add their
   own address. Each admin's entry is written when they sign in (see login()
   below). */
const adminEmailRef = (email) => doc(db, "adminEmails", email.trim().toLowerCase());

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
  notAdminEmail: {
    variant: "danger",
    icon: "fa-user-shield",
    eyebrow: "Password reset",
    title: "This account is not a registered admin",
    message: "Please enter the admin Gmail. Password resets are only available for registered PeakPath administrators.",
    fields: ["forgotEmail"]
  },
  resetCheckFailed: {
    variant: "warning",
    icon: "fa-wifi",
    eyebrow: "Password reset",
    title: "Couldn't check that email",
    message: "We couldn't confirm whether this is an admin email right now. Check your connection and try again.",
    fields: ["forgotEmail"]
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
  ["email", "password", "forgotEmail"].forEach((id) => {
    document.getElementById(id)?.closest(".input-box").classList.toggle("invalid", ids.includes(id));
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
        saveRememberedEmail(email, document.getElementById("rememberMe").checked);

        // Registers this admin's address for Forgot Password. A failure only
        // means the reset check misses them until the next sign-in, so it
        // never holds up the login.
        if (user.email) {
          await setDoc(adminEmailRef(user.email), { uid: user.uid, email: user.email.toLowerCase(), updatedAt: serverTimestamp() })
            .catch((error) => console.warn("Could not register the admin email for password resets:", error.message));
        }

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

const RESET_SENT_MESSAGE =
  "A reset link has been sent to this admin email. Check your inbox and spam folder.";

function setForgotStatus(message, type = "") {
  const status = document.getElementById("forgotStatus");
  status.textContent = message;
  status.className = "forgot-status" + (type ? ` ${type}` : "");
}

function openForgotModal() {
  const forgotEmail = document.getElementById("forgotEmail");
  const submitBtn = document.getElementById("forgotSubmit");
  // The reset always goes to the email on the login form; the field here is
  // read-only, so a different address has to be typed there first.
  const email = document.getElementById("email").value.trim();
  forgotEmail.value = email;
  // The field can't be typed in, so its red mark from a previous attempt
  // would never clear on its own.
  forgotEmail.closest(".input-box").classList.remove("invalid");
  if (email) {
    setForgotStatus("");
    submitBtn.disabled = false;
  } else {
    setForgotStatus("Type your admin email on the login form first, then click Forgot Password again.", "error");
    submitBtn.disabled = true;
  }
  document.getElementById("forgotModal").classList.add("show");
  (email ? submitBtn : document.getElementById("forgotCancel")).focus();
}

function closeForgotModal() {
  document.getElementById("forgotModal").classList.remove("show");
}

async function sendResetLink() {
  // Read from the login form, not the modal field, so the address can't be
  // swapped by editing the read-only input in dev tools.
  const email = document.getElementById("email").value.trim();
  const submitBtn = document.getElementById("forgotSubmit");

  if (!email) {
    setForgotStatus("Please enter your email address.", "error");
    return;
  }

  submitBtn.disabled = true;
  setForgotStatus("Checking...");

  // Only registered admins can reset a password from this page. The email
  // leads to its UID (adminEmails), and that UID must still be in admins/ --
  // the same check the login itself makes -- so an admin who has been
  // removed can no longer reset either.
  let isAdminEmail = false;
  try {
    const entry = await getDoc(adminEmailRef(email));
    const uid = entry.exists() ? entry.data().uid : null;
    isAdminEmail = Boolean(uid) && (await getDoc(doc(db, "admins", uid))).exists();
  } catch (error) {
    console.error("Could not check the admin email:", error.code, error.message);
    setForgotStatus("");
    submitBtn.disabled = false;
    showErrorModal("resetCheckFailed");
    return;
  }
  if (!isAdminEmail) {
    setForgotStatus("");
    submitBtn.disabled = false;
    showErrorModal("notAdminEmail");
    return;
  }

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
        message = "No sign-in account was found for this admin email.";
        break;
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

  // Remember me: fill in the remembered admin email and go straight to the
  // password field.
  const rememberedEmail = readRememberedEmail();
  if (rememberedEmail) {
    document.getElementById("email").value = rememberedEmail;
    document.getElementById("rememberMe").checked = true;
    document.getElementById("password").focus();
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
  [emailInput, passwordInput, document.getElementById("forgotEmail")].forEach((input) => {
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
    // The alert can sit on top of the reset window, so it closes first.
    if (overlay.classList.contains("show")) {
      closeErrorModal();
    } else if (forgotModal.classList.contains("show")) {
      closeForgotModal();
    }
  });
});

window.login = login;