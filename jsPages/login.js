// login.js
import { auth, db } from "./firebase-config.js";
import {
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFunctions,
  httpsCallable
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
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
    message: "Please enter the admin Gmail on the login form. Password resets are only available for registered PeakPath administrators.",
    fields: ["email"]
  },
  forgotNeedsEmail: {
    variant: "warning",
    icon: "fa-envelope",
    eyebrow: "Password reset",
    title: "Enter your admin email first",
    message: "Type your admin email on the login form, then click Forgot Password. The verification code can only go to that email.",
    fields: ["email"]
  },
  resetCheckFailed: {
    variant: "warning",
    icon: "fa-wifi",
    eyebrow: "Password reset",
    title: "Couldn't check that email",
    message: "We couldn't confirm whether this is an admin email right now. Check your connection and try again."
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

/* ===== Forgot Password: an emailed 6-digit code =====
   Like Facebook's: the admin asks for a code, it arrives by email, and they
   type it into this window with the new password twice. The code is made,
   emailed and checked by the Cloud Functions in functions/index.js; the page
   never sees it, and the new password is set there with the Admin SDK. */
const functions = getFunctions(auth.app);
const requestResetCode = httpsCallable(functions, "requestPasswordResetCode");
const resetPasswordWithCode = httpsCallable(functions, "resetPasswordWithCode");

// Same minimum as Settings > Change Password and the Cloud Function.
const PASSWORD_MIN_LENGTH = 8;

let resendTimer = null;

// Messages for failures that don't come with one from the Cloud Function
// (it is unreachable, or not deployed yet). The SDK then sets the message
// to the bare error code ("internal"); an error the function itself threw
// keeps its own sentence, which is shown as is.
function callableErrorMessage(error, fallback) {
  const code = String(error?.code || "").replace("functions/", "");
  const bareCode = String(error?.message || "").trim().toLowerCase() === code;
  if (["internal", "unavailable", "unknown", "not-found"].includes(code) && bareCode) {
    return navigator.onLine
      ? "The password reset service isn't responding right now. Please try again in a moment."
      : "Network error. Check your connection and try again.";
  }
  return error?.message || fallback;
}

function setStatus(id, message, type = "") {
  const status = document.getElementById(id);
  status.textContent = message;
  status.className = "forgot-status" + (type ? ` ${type}` : "");
}

const setForgotStatus = (message, type) => setStatus("forgotStatus", message, type);
const setVerifyStatus = (message, type) => setStatus("verifyStatus", message, type);

function showForgotStep(step) {
  document.querySelectorAll("#forgotModal .forgot-step").forEach((section) => {
    section.hidden = section.dataset.step !== step;
  });
}

const codeDigits = () => [...document.querySelectorAll("#codeInputs .code-digit")];

function clearVerifyForm() {
  codeDigits().forEach((input) => { input.value = ""; });
  ["resetNewPassword", "resetConfirmPassword"].forEach((id) => {
    const input = document.getElementById(id);
    input.value = "";
    input.type = "password";
  });
  document.querySelectorAll("#verifyForm .password-toggle").forEach((toggle) => setToggleIcon(toggle, false));
  document.querySelectorAll("#verifyForm .invalid").forEach((el) => el.classList.remove("invalid"));
  setVerifyStatus("");
}

function markInvalid(target) {
  const box = target.id === "codeInputs" ? target : target.closest(".input-box");
  box.classList.add("invalid");
}

// "Resend code" stays disabled until the Cloud Function will accept another
// request, counting down the seconds it said to wait.
function startResendCountdown(seconds) {
  const button = document.getElementById("resendCode");
  clearInterval(resendTimer);
  let left = Math.max(0, Math.ceil(seconds));
  const tick = () => {
    if (left <= 0) {
      clearInterval(resendTimer);
      button.disabled = false;
      button.textContent = "Resend code";
      return;
    }
    button.disabled = true;
    button.textContent = `Resend in 0:${String(left).padStart(2, "0")}`;
    left -= 1;
  };
  tick();
  resendTimer = setInterval(tick, 1000);
}

function openForgotModal() {
  // The code only goes to the email already typed on the login form; the
  // field in the modal is read-only.
  const email = document.getElementById("email").value.trim();
  if (!email) {
    showErrorModal("forgotNeedsEmail");
    return;
  }
  document.getElementById("forgotEmail").value = email;
  setForgotStatus("");
  clearVerifyForm();
  showForgotStep("send");
  const submitBtn = document.getElementById("forgotSubmit");
  submitBtn.disabled = false;
  submitBtn.textContent = "Send Code";
  document.getElementById("forgotModal").classList.add("show");
  submitBtn.focus();
}

function closeForgotModal() {
  document.getElementById("forgotModal").classList.remove("show");
  clearInterval(resendTimer);
}

// Only registered admins can reset a password from this page. The email
// leads to its UID (adminEmails), and that UID must still be in admins/ --
// the same check the login itself makes -- so an admin who has been removed
// can no longer reset either. The Cloud Function checks this again; this
// early check just gives the clearer alert without a round trip.
async function isRegisteredAdminEmail(email) {
  const entry = await getDoc(adminEmailRef(email));
  const uid = entry.exists() ? entry.data().uid : null;
  return Boolean(uid) && (await getDoc(doc(db, "admins", uid))).exists();
}

function showNotAdminEmail() {
  // The email can only be fixed on the login form, so send them back there.
  closeForgotModal();
  showErrorModal("notAdminEmail");
}

// Step 1: check the address, then have the Cloud Function email a code.
async function sendResetCode() {
  const email = document.getElementById("forgotEmail").value.trim();
  const submitBtn = document.getElementById("forgotSubmit");

  if (!email) {
    closeForgotModal();
    showErrorModal("forgotNeedsEmail");
    return;
  }

  submitBtn.disabled = true;
  setForgotStatus("Checking...");

  let isAdminEmail = false;
  try {
    isAdminEmail = await isRegisteredAdminEmail(email);
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
    showNotAdminEmail();
    return;
  }

  setForgotStatus("Sending code...");
  try {
    const { data } = await requestResetCode({ email });
    setForgotStatus("");
    openVerifyStep(email, data.resendAfterSeconds);
  } catch (error) {
    console.error(error.code, error.message);
    if (error.details?.reason === "not-admin") {
      setForgotStatus("");
      showNotAdminEmail();
    } else if (error.details?.retryAfter) {
      // A code was sent under a minute ago; it is still good, so go and
      // enter it instead of waiting.
      setForgotStatus("");
      openVerifyStep(email, error.details.retryAfter);
      setVerifyStatus("A code was already sent a moment ago. Check your inbox and spam folder.", "success");
    } else {
      setForgotStatus(callableErrorMessage(error, "Could not send the code. Please try again."), "error");
    }
  } finally {
    submitBtn.disabled = false;
  }
}

// Step 2: the code, the new password, and the new password again.
function openVerifyStep(email, resendAfterSeconds) {
  document.getElementById("verifyEmail").textContent = email;
  clearVerifyForm();
  showForgotStep("verify");
  startResendCountdown(resendAfterSeconds ?? 60);
  codeDigits()[0].focus();
}

async function resendResetCode() {
  const email = document.getElementById("forgotEmail").value.trim();
  const button = document.getElementById("resendCode");
  button.disabled = true;
  setVerifyStatus("Sending a new code...");
  try {
    const { data } = await requestResetCode({ email });
    codeDigits().forEach((input) => { input.value = ""; });
    document.getElementById("codeInputs").classList.remove("invalid");
    setVerifyStatus("We sent a new code. Only the newest code works.", "success");
    startResendCountdown(data.resendAfterSeconds);
    codeDigits()[0].focus();
  } catch (error) {
    console.error(error.code, error.message);
    if (error.details?.reason === "not-admin") {
      showNotAdminEmail();
      return;
    }
    setVerifyStatus(callableErrorMessage(error, "Could not send a new code. Please try again."), "error");
    startResendCountdown(error.details?.retryAfter || 0);
  }
}

async function submitNewPassword() {
  const email = document.getElementById("forgotEmail").value.trim();
  const codeGroup = document.getElementById("codeInputs");
  const newInput = document.getElementById("resetNewPassword");
  const confirmInput = document.getElementById("resetConfirmPassword");
  const submitBtn = document.getElementById("verifySubmit");

  const code = codeDigits().map((input) => input.value).join("");
  const newPassword = newInput.value;
  const confirmPassword = confirmInput.value;

  document.querySelectorAll("#verifyForm .invalid").forEach((el) => el.classList.remove("invalid"));

  const fail = (message, target) => {
    setVerifyStatus(message, "error");
    markInvalid(target);
    (target === codeGroup ? codeDigits().find((input) => !input.value) || codeDigits()[0] : target).focus();
  };
  if (!/^\d{6}$/.test(code)) return fail("Enter the 6-digit code from the email.", codeGroup);
  if (newPassword.length < PASSWORD_MIN_LENGTH) {
    return fail(`New password must be at least ${PASSWORD_MIN_LENGTH} characters.`, newInput);
  }
  if (newPassword !== confirmPassword) return fail("The two passwords don't match.", confirmInput);

  submitBtn.disabled = true;
  submitBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Changing...';
  setVerifyStatus("");

  try {
    await resetPasswordWithCode({ email, code, newPassword });
    clearInterval(resendTimer);
    showForgotStep("done");
    document.getElementById("doneSignIn").focus();
  } catch (error) {
    console.error(error.code, error.message);
    const message = callableErrorMessage(error, "Could not change the password. Please try again.");
    if (error.details?.field === "code") {
      codeDigits().forEach((input) => { input.value = ""; });
      fail(message, codeGroup);
    } else if (error.details?.field === "password") {
      fail(message, newInput);
    } else {
      setVerifyStatus(message, "error");
      // The code is expired or used up; a new one can be sent right away.
      const reason = String(error.code || "").replace("functions/", "");
      if (["deadline-exceeded", "resource-exhausted", "failed-precondition"].includes(reason)) {
        startResendCountdown(0);
      }
    }
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Change Password";
  }
}

// Step 3: back on the login form with the email filled in, ready for the
// new password.
function finishPasswordReset() {
  closeForgotModal();
  const passwordInput = document.getElementById("password");
  passwordInput.value = "";
  passwordInput.focus();
}

// The six code boxes act as one field: typing moves to the next box,
// Backspace goes back, and pasting (or an autofilled code) fills them all.
function wireCodeInputs() {
  const digits = codeDigits();
  const fill = (text, from = 0) => {
    const chars = text.replace(/\D/g, "").slice(0, digits.length - from).split("");
    chars.forEach((char, i) => { digits[from + i].value = char; });
    const next = digits[Math.min(from + chars.length, digits.length - 1)];
    next.focus();
  };

  digits.forEach((input, index) => {
    input.addEventListener("input", () => {
      document.getElementById("codeInputs").classList.remove("invalid");
      const value = input.value.replace(/\D/g, "");
      if (value.length > 1) {
        fill(value, index);
        return;
      }
      input.value = value;
      if (value && index < digits.length - 1) digits[index + 1].focus();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Backspace" && !input.value && index > 0) {
        digits[index - 1].value = "";
        digits[index - 1].focus();
        event.preventDefault();
      } else if (event.key === "ArrowLeft" && index > 0) {
        digits[index - 1].focus();
        event.preventDefault();
      } else if (event.key === "ArrowRight" && index < digits.length - 1) {
        digits[index + 1].focus();
        event.preventDefault();
      }
    });
    input.addEventListener("paste", (event) => {
      event.preventDefault();
      fill(event.clipboardData.getData("text"), index);
    });
    input.addEventListener("focus", () => input.select());
  });
}

function setToggleIcon(toggle, visible) {
  const icon = toggle.querySelector("i");
  toggle.setAttribute("aria-label", visible ? "Hide password" : "Show password");
  toggle.title = visible ? "Hide password" : "Show password";
  icon.classList.toggle("fa-eye", !visible);
  icon.classList.toggle("fa-eye-slash", visible);
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
  const passwordToggle = document.querySelector("#loginForm .password-toggle");

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
    sendResetCode();
  });

  document.getElementById("forgotCancel").addEventListener("click", closeForgotModal);

  const verifyForm = document.getElementById("verifyForm");
  verifyForm.addEventListener("submit", (event) => {
    event.preventDefault();
    submitNewPassword();
  });
  document.getElementById("verifyBack").addEventListener("click", () => {
    clearInterval(resendTimer);
    showForgotStep("send");
    document.getElementById("forgotSubmit").focus();
  });
  document.getElementById("resendCode").addEventListener("click", resendResetCode);
  document.getElementById("doneSignIn").addEventListener("click", finishPasswordReset);
  wireCodeInputs();

  // Show/hide eyes on the new-password fields.
  verifyForm.querySelectorAll(".password-toggle").forEach((toggle) => {
    toggle.addEventListener("click", () => {
      const input = document.getElementById(toggle.dataset.target);
      const reveal = input.type === "password";
      input.type = reveal ? "text" : "password";
      setToggleIcon(toggle, reveal);
    });
  });
  ["resetNewPassword", "resetConfirmPassword"].forEach((id) => {
    const input = document.getElementById(id);
    input.addEventListener("input", () => {
      input.closest(".input-box").classList.remove("invalid");
    });
  });

  // A click outside only closes the first step. Once a code is on its way,
  // a stray click must not throw away what the admin has typed; Back,
  // Escape or Back to Sign In still close it.
  forgotModal.addEventListener("click", (e) => {
    if (e.target !== forgotModal) return;
    const step = forgotModal.querySelector(".forgot-step:not([hidden])")?.dataset.step;
    if (step === "send") closeForgotModal();
    else if (step === "done") finishPasswordReset();
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