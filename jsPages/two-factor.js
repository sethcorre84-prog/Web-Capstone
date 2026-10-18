// two-factor.js
// Two-factor sign-in by SMS, for admins who turn it on in Settings > Two-Factor
// Authentication. On a device not yet recognised, signing in also needs a
// 6-digit code texted to the phone number on the admin's profile.
//
//   login.js           asks for the code after the password (requireTwoFactor)
//   dashboard-guard.js signs out a browser that skipped it (guardTwoFactor)
//   Setting.html       turns it on (with a code, so a wrong number cannot lock
//                      the admin out) and off
//
// The code is sent and checked by Firebase's own phone verification, in a
// second Firebase app so the admin's sign-in is never touched. Its result is
// confirmed by the checkTwoFactor / confirmTwoFactor / disableTwoFactor Cloud
// Functions (functions/index.js), which keep the recognised devices where no
// browser can write them. Needs the Phone sign-in method turned on in
// Firebase Console > Authentication, and the site's domain listed under its
// authorized domains.

import { auth, firebaseConfig } from './firebase-config.js';
import { describeDevice } from './admin-sessions.js';
import { getApp, getApps, initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  RecaptchaVerifier, getAuth, signInWithPhoneNumber, signOut
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js';

const DEVICE_KEY = 'peakpath-device-id';
const PASSED_KEY = (uid) => `peakpath-2fa-ok:${uid}`;
const RESEND_SECONDS = 60;

const call = (name, data) => httpsCallable(getFunctions(auth.app), name)(data).then((result) => result.data);

/* This browser's id, kept across sign-ins (logging out does not clear it), so
   a device stays recognised. Clearing the site's data makes it a new device. */
export function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = (crypto.randomUUID?.() || `${Date.now()}${Math.random()}`).replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    // Storage blocked: recognised for this page only.
    deviceId.fallback ||= `tmp${Date.now()}${Math.floor(Math.random() * 1e9)}`;
    return deviceId.fallback;
  }
}

const deviceLabel = async () => {
  const { browser, os } = await describeDevice();
  return `${browser} on ${os}`;
};

export const checkTwoFactor = () => call('checkTwoFactor', { deviceId: deviceId() });

/* ---- The code pop-up ---- */

const CSS = `
.tf-overlay { position:fixed; inset:0; z-index:5000; display:none; align-items:center; justify-content:center;
  padding:16px; background:rgba(15,28,18,.55); font-family:inherit; }
.tf-overlay.open { display:flex; }
.tf-box { width:min(400px,100%); padding:26px 24px 22px; border-radius:16px; background:var(--card-bg,#fff);
  color:var(--text-primary,#1c231c); box-shadow:0 20px 50px rgba(0,0,0,.3); text-align:center; }
.tf-icon { display:grid; place-items:center; width:52px; height:52px; margin:0 auto 12px; border-radius:50%;
  background:#e7f5eb; color:#2f8f4e; font-size:22px; }
.tf-box h3 { margin:0 0 6px; font-size:19px; }
.tf-box p { margin:0 0 16px; font-size:13px; line-height:1.5; color:var(--text-secondary,#5b6b60); }
.tf-box p strong { color:var(--text-primary,#1c231c); }
.tf-code { width:100%; padding:12px; border:1px solid var(--border,#dfe5df); border-radius:10px; font:inherit;
  font-size:24px; font-weight:700; letter-spacing:10px; text-align:center; background:var(--dm-surface-2,#fbfcfa);
  color:var(--text-primary,#1c231c); }
.tf-code:focus { outline:none; border-color:#2f8f4e; box-shadow:0 0 0 3px rgba(47,143,78,.15); }
.tf-error { min-height:18px; margin:8px 0 4px; font-size:12.5px; color:#c8402f; }
.tf-actions { display:flex; gap:10px; margin-top:8px; }
.tf-actions button { flex:1; padding:11px; border-radius:10px; font:inherit; font-size:14px; font-weight:700; cursor:pointer; }
.tf-cancel { border:1px solid var(--border,#dfe5df); background:var(--dm-surface-2,#f3f5f2); color:var(--text-primary,#1c231c); }
.tf-primary { border:0; background:#2f8f4e; color:#fff; }
.tf-primary:disabled, .tf-resend:disabled { opacity:.55; cursor:not-allowed; }
.tf-resend { margin-top:12px; border:0; background:none; font:inherit; font-size:12.5px; font-weight:700;
  color:#2f8f4e; cursor:pointer; }
.tf-code-step[hidden], .tf-send-step[hidden] { display:none; }
`;

let overlay = null;
function buildOverlay() {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  overlay = document.createElement('div');
  overlay.className = 'tf-overlay';
  overlay.innerHTML = `
    <div class="tf-box" role="dialog" aria-modal="true" aria-labelledby="tfTitle">
      <div class="tf-icon"><i class="fa-solid fa-shield-halved" aria-hidden="true"></i></div>
      <h3 id="tfTitle">Two-factor verification</h3>
      <p class="tf-text"></p>
      <div class="tf-send-step">
        <div class="tf-error" role="alert"></div>
        <div class="tf-actions">
          <button type="button" class="tf-cancel">Cancel</button>
          <button type="button" class="tf-primary tf-send" id="tfSendBtn">Send code</button>
        </div>
      </div>
      <form class="tf-code-step" hidden>
        <input class="tf-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••" aria-label="6-digit code">
        <div class="tf-error" role="alert"></div>
        <div class="tf-actions">
          <button type="button" class="tf-cancel">Cancel</button>
          <button type="submit" class="tf-primary tf-verify">Verify</button>
        </div>
        <button type="button" class="tf-resend" disabled>Resend code</button>
      </form>
      <div id="tfRecaptcha"></div>
    </div>`;
  document.body.appendChild(overlay);
}

// What a Firebase phone-verification error means, in words.
function explain(error) {
  switch (error?.code) {
    case 'auth/invalid-verification-code': return 'That code is not right. Check the SMS and try again.';
    case 'auth/code-expired': return 'That code has expired. Send a new one.';
    case 'auth/too-many-requests': return 'Too many attempts. Wait a while, then try again.';
    case 'auth/invalid-phone-number':
    case 'auth/missing-phone-number': return 'The phone number on your profile is not valid. Fix it in Settings > Profile.';
    case 'auth/quota-exceeded': return 'The SMS limit for today has been reached. Try again later.';
    case 'auth/operation-not-allowed': return 'SMS sign-in is not turned on for this project (Firebase Console > Authentication > Phone).';
    case 'auth/unauthorized-domain':
      return `${location.hostname} is not an authorized domain for SMS codes. Add exactly "${location.hostname}" in Firebase Console > Authentication > Settings > Authorized domains.`;
    case 'auth/captcha-check-failed':
      return `The reCAPTCHA check for ${location.hostname} failed (auth/captcha-check-failed). Make sure "${location.hostname}" is in Authorized domains, then reload the page and try again.`;
    case 'auth/invalid-app-credential':
      return 'Firebase rejected the reCAPTCHA check (auth/invalid-app-credential). Reload the page and try again; if it keeps happening, check reCAPTCHA / App Check settings for Phone sign-in.';
    case 'functions/permission-denied':
    case 'functions/deadline-exceeded':
    case 'functions/failed-precondition':
    case 'functions/unauthenticated': return error.message;
    case 'functions/internal': return 'Could not reach the verification service. It may not be deployed yet.';
    default: return `${error?.message || 'Something went wrong. Try again.'}${error?.code ? ` (${error.code})` : ''}`;
  }
}

/* Sends a code to `phone` and waits for it. Resolves true once the code is
   confirmed (this device is then recognised; with `enable`, two-factor is
   turned on), false if cancelled. */
function smsChallenge({ phone, masked, title, intro, enable = false }) {
  if (!overlay) buildOverlay();
  const $ = (selector) => overlay.querySelector(selector);
  const sendStep = $('.tf-send-step');
  const codeStep = $('.tf-code-step');
  const codeInput = $('.tf-code');
  const sendBtn = $('.tf-send');
  const verifyBtn = $('.tf-verify');
  const resendBtn = $('.tf-resend');
  const errors = overlay.querySelectorAll('.tf-error');

  $('#tfTitle').textContent = title;
  $('.tf-text').innerHTML = `${intro} We'll text a 6-digit code to <strong>${masked}</strong>, the phone number on your profile.`;
  sendStep.hidden = false;
  codeStep.hidden = true;
  codeInput.value = '';
  errors.forEach((el) => { el.textContent = ''; });
  sendBtn.disabled = false;
  sendBtn.textContent = 'Send code';
  overlay.classList.add('open');
  sendBtn.focus();

  // The SMS is sent by a separate Firebase app, so the admin stays signed in.
  const smsApp = getApps().find((a) => a.name === 'peakpath-2fa') || initializeApp(firebaseConfig, 'peakpath-2fa');
  const smsAuth = getAuth(smsApp);
  smsAuth.languageCode = 'en';
  let verifier = null;
  let confirmation = null;
  let timer = null;

  return new Promise((resolve) => {
    const showError = (message) => errors.forEach((el) => { el.textContent = message; });

    const finish = (ok) => {
      clearInterval(timer);
      verifier?.clear?.();
      signOut(smsAuth).catch(() => {});
      overlay.classList.remove('open');
      overlay.querySelectorAll('.tf-cancel').forEach((b) => { b.onclick = null; });
      sendBtn.onclick = null;
      resendBtn.onclick = null;
      codeStep.onsubmit = null;
      document.removeEventListener('keydown', onKey);
      resolve(ok);
    };
    const onKey = (event) => { if (event.key === 'Escape') finish(false); };
    document.addEventListener('keydown', onKey);
    overlay.querySelectorAll('.tf-cancel').forEach((b) => { b.onclick = () => finish(false); });

    const countdown = () => {
      let left = RESEND_SECONDS;
      resendBtn.disabled = true;
      resendBtn.textContent = `Resend code in ${left}s`;
      clearInterval(timer);
      timer = setInterval(() => {
        left -= 1;
        if (left <= 0) {
          clearInterval(timer);
          resendBtn.disabled = false;
          resendBtn.textContent = 'Resend code';
        } else {
          resendBtn.textContent = `Resend code in ${left}s`;
        }
      }, 1000);
    };

    const send = async () => {
      showError('');
      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending...';
      try {
        verifier?.clear?.();
        $('#tfRecaptcha').innerHTML = '<div></div>';
        verifier = new RecaptchaVerifier(smsAuth, $('#tfRecaptcha').firstChild, { size: 'invisible' });
        confirmation = await signInWithPhoneNumber(smsAuth, phone, verifier);
        sendStep.hidden = true;
        codeStep.hidden = false;
        codeInput.focus();
        countdown();
      } catch (error) {
        console.error('Could not send the two-factor code:', error);
        showError(explain(error));
      } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send code';
      }
    };
    sendBtn.onclick = send;
    resendBtn.onclick = () => { sendStep.hidden = false; codeStep.hidden = true; send(); };

    codeStep.onsubmit = async (event) => {
      event.preventDefault();
      const code = codeInput.value.replace(/\D/g, '');
      if (code.length !== 6) {
        showError('Enter the 6-digit code from the SMS.');
        return;
      }
      verifyBtn.disabled = true;
      verifyBtn.textContent = 'Checking...';
      showError('');
      try {
        const result = await confirmation.confirm(code);
        const phoneToken = await result.user.getIdToken();
        await call('confirmTwoFactor', { deviceId: deviceId(), device: await deviceLabel(), phoneToken, enable });
        try { sessionStorage.setItem(PASSED_KEY(auth.currentUser?.uid), '1'); } catch { /* fine */ }
        finish(true);
      } catch (error) {
        console.error('Two-factor code check failed:', error);
        showError(explain(error));
      } finally {
        verifyBtn.disabled = false;
        verifyBtn.textContent = 'Verify';
      }
    };
  });
}

/* ---- For the pages ---- */

/* After the password, at the login page. Resolves { ok: true } when the
   device may go on (two-factor off, device recognised, or code confirmed),
   or { ok: false, message } to refuse the sign-in. */
export async function requireTwoFactor() {
  let status;
  try {
    status = await checkTwoFactor();
  } catch (error) {
    // Not deployed or unreachable: the sign-in is not held up by it.
    console.warn('Could not check two-factor sign-in:', error.message);
    return { ok: true };
  }
  if (!status.required) return { ok: true };
  if (!status.phone) {
    return { ok: false, message: 'Two-factor sign-in is on, but your profile has no phone number. Ask another admin to help you.' };
  }
  const passed = await smsChallenge({
    phone: status.phone,
    masked: status.masked,
    title: 'Verify it\'s you',
    intro: 'This device has not been used with your account before.'
  });
  return passed ? { ok: true } : { ok: false, message: 'Sign-in cancelled: the two-factor code was not entered.' };
}

/* On every protected page: false when this browser still owes the code (it
   signed in and closed the login page before entering it). Checked once per
   browser session; a failed check lets the page through. */
export async function guardTwoFactor(user) {
  try {
    if (sessionStorage.getItem(PASSED_KEY(user.uid))) return true;
  } catch { /* storage blocked: check every time */ }
  try {
    const status = await checkTwoFactor();
    if (status.required) return false;
    try { sessionStorage.setItem(PASSED_KEY(user.uid), '1'); } catch { /* fine */ }
    return true;
  } catch (error) {
    console.warn('Could not check two-factor sign-in:', error.message);
    return true;
  }
}

/* Settings: turns it on after a code to the profile phone (so the number is
   known to work), and recognises this device. Resolves true when on. */
export async function enableTwoFactor() {
  const status = await checkTwoFactor();
  if (!status.phone) throw new Error('Add your phone number in Settings > Profile Information first.');
  return smsChallenge({
    phone: status.phone,
    masked: status.masked,
    title: 'Turn on two-factor sign-in',
    intro: 'Confirm your phone number first.',
    enable: true
  });
}

export const disableTwoFactor = () => call('disableTwoFactor', {});
