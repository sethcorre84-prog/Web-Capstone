/* ==========================================================================
   PeakPath Cloud Functions — Forgot Password with an emailed 6-digit code.

   The login page cannot do this on its own: a signed-out browser has no way
   to change a Firebase Auth password, and a code that the browser generates
   or can read is no secret at all. So the two halves live here:

     requestPasswordResetCode({ email })
       Confirms the address belongs to a registered admin, then emails a
       fresh 6-digit code. Only a salted hash of the code is stored, in
       passwordResets/{uid}, which no client can read (see firestore.rules).

     resetPasswordWithCode({ email, code, newPassword })
       Checks the code and sets the new password with the Admin SDK. A code
       expires after 10 minutes and dies after 5 wrong tries, and a new one
       can be requested once a minute. A successful reset signs the admin
       out everywhere else, like Facebook's "log out of other devices".

   Email goes out through a Gmail account using an app password, kept in
   Secret Manager (never in this file):
     firebase functions:secrets:set GMAIL_USER
     firebase functions:secrets:set GMAIL_APP_PASSWORD
   GMAIL_APP_PASSWORD must be a Google *app password* (Google Account >
   Security > App passwords), not the Gmail password; Gmail refuses the
   real password with "534 Application-specific password required".

   Advisory emails can instead go out through the Gmail account of the admin
   who created the advisory, so recipients see that account as the sender.
   Each such account needs its own app password, kept together in one
   secret as JSON (addresses in lower case):
     firebase functions:secrets:set GMAIL_SENDERS
       {"uplbmcme@gmail.com":"abcd efgh ijkl mnop",
        "stotomascityenro@gmail.com":"qrst uvwx yzab cdef"}
   An admin with no entry there is sent through GMAIL_USER as before.

   Each deploy pins the secret versions current at that moment, and
   `firebase deploy` skips functions whose code is unchanged -- so after
   changing a secret, the functions keep the old value until the code
   changes and they are deployed again.
   ========================================================================== */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, Timestamp, FieldValue } = require("firebase-admin/firestore");
const crypto = require("node:crypto");
const nodemailer = require("nodemailer");
const dns = require("node:dns").promises;
const { ImapFlow } = require("imapflow");

initializeApp();
const db = getFirestore();

const GMAIL_USER = defineSecret("GMAIL_USER");
const GMAIL_APP_PASSWORD = defineSecret("GMAIL_APP_PASSWORD");
const GMAIL_SENDERS = defineSecret("GMAIL_SENDERS");

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
// Same minimum as Settings > Change Password.
const PASSWORD_MIN_LENGTH = 8;

const normalizeEmail = (raw) => {
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpsError("invalid-argument", "Enter a valid email address.");
  }
  return email;
};

// The same test the login page makes: the address maps to a UID in
// adminEmails, and that UID is still in admins.
async function findAdminUid(email) {
  const entry = await db.collection("adminEmails").doc(email).get();
  const uid = entry.exists ? entry.get("uid") : null;
  if (!uid) return null;
  const admin = await db.collection("admins").doc(uid).get();
  return admin.exists ? uid : null;
}

const hashCode = (code, salt) =>
  crypto.createHash("sha256").update(`${salt}:${code}`).digest("hex");

const codesMatch = (code, record) => {
  const given = Buffer.from(hashCode(code, record.salt), "hex");
  const stored = Buffer.from(record.codeHash, "hex");
  return given.length === stored.length && crypto.timingSafeEqual(given, stored);
};

const mailTransport = (user = GMAIL_USER.value(), pass = GMAIL_APP_PASSWORD.value()) =>
  nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass }
  });

// GMAIL_SENDERS as { "address": "app password" }. A missing or malformed
// secret means no per-admin accounts, not a failed send.
function senderPasswords() {
  try {
    const parsed = JSON.parse(GMAIL_SENDERS.value() || "{}");
    const out = {};
    for (const [address, pass] of Object.entries(parsed || {})) {
      if (typeof pass === "string" && pass.trim()) out[address.trim().toLowerCase()] = pass.trim();
    }
    return out;
  } catch (error) {
    logger.warn("GMAIL_SENDERS is not valid JSON; sending advisories through GMAIL_USER", error);
    return {};
  }
}

async function sendCodeEmail(to, code) {
  const transporter = mailTransport();
  const minutes = CODE_TTL_MS / 60000;
  const sender = GMAIL_USER.value();
  // Kept plain on purpose, to stay out of spam: a normal subject line (a
  // subject that opens with a bare number is a common spam signal), a real
  // Reply-To, a full HTML document with a matching plain-text part, and no
  // links, images or tricks such as widely spaced digits.
  await transporter.sendMail({
    from: { name: "PeakPath", address: sender },
    replyTo: sender,
    to,
    subject: "Your PeakPath password reset code",
    text:
      "Hello,\n\n" +
      "We received a request to reset the password for your PeakPath admin account.\n\n" +
      `Your verification code is: ${code}\n\n` +
      `Enter this code on the PeakPath login page. It expires in ${minutes} minutes.\n\n` +
      "If you didn't ask to reset your password, you can ignore this email and your password will stay the same.\n\n" +
      "PeakPath Admin Portal",
    html: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Your PeakPath password reset code</title></head>
<body style="margin:0;padding:0;background:#ffffff">
  <div style="font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:460px;margin:0 auto;padding:28px 24px;color:#1c231c">
    <h2 style="margin:0 0 16px;font-size:20px;color:#1f6b39">PeakPath</h2>
    <p style="margin:0 0 12px;font-size:14px">Hello,</p>
    <p style="margin:0 0 12px;font-size:14px">We received a request to reset the password for your PeakPath admin account. Your verification code is:</p>
    <p style="margin:0 0 20px;padding:14px;border-radius:10px;background:#e7f5eb;text-align:center;font-size:28px;font-weight:700;letter-spacing:4px;color:#1f6b39">${code}</p>
    <p style="margin:0 0 12px;font-size:14px">Enter this code on the PeakPath login page. It expires in ${minutes} minutes.</p>
    <p style="margin:0 0 20px;font-size:13px;color:#5b6b60">If you didn't ask to reset your password, you can ignore this email and your password will stay the same.</p>
    <p style="margin:0;font-size:12px;color:#93a199">PeakPath Admin Portal</p>
  </div>
</body>
</html>`
  });
}

exports.requestPasswordResetCode = onCall(
  { secrets: [GMAIL_USER, GMAIL_APP_PASSWORD] },
  async (request) => {
    const email = normalizeEmail(request.data?.email);
    const uid = await findAdminUid(email);
    if (!uid) {
      // `reason` tells the page this apart from a 404 for a function that
      // has not been deployed, which also arrives as "not-found".
      throw new HttpsError("not-found", "This email is not a registered PeakPath admin.", { reason: "not-admin" });
    }

    const ref = db.collection("passwordResets").doc(uid);
    const now = Date.now();
    const existing = await ref.get();
    if (existing.exists) {
      const wait = RESEND_COOLDOWN_MS - (now - existing.get("sentAt").toMillis());
      if (wait > 0) {
        const seconds = Math.ceil(wait / 1000);
        throw new HttpsError(
          "resource-exhausted",
          `Please wait ${seconds} seconds before requesting another code.`,
          { retryAfter: seconds }
        );
      }
    }

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    const salt = crypto.randomBytes(16).toString("hex");
    await ref.set({
      email,
      salt,
      codeHash: hashCode(code, salt),
      attempts: 0,
      sentAt: Timestamp.fromMillis(now),
      expiresAt: Timestamp.fromMillis(now + CODE_TTL_MS)
    });

    try {
      await sendCodeEmail(email, code);
    } catch (error) {
      logger.error("Could not send the reset code email", error);
      // Nothing was delivered, so don't make the admin wait out the cooldown.
      await ref.delete();
      throw new HttpsError("unavailable", "We couldn't send the code email. Please try again.");
    }

    return {
      expiresInSeconds: CODE_TTL_MS / 1000,
      resendAfterSeconds: RESEND_COOLDOWN_MS / 1000
    };
  }
);

exports.resetPasswordWithCode = onCall(async (request) => {
  const email = normalizeEmail(request.data?.email);
  const code = String(request.data?.code ?? "").trim();
  const newPassword = request.data?.newPassword;

  if (!/^\d{6}$/.test(code)) {
    throw new HttpsError("invalid-argument", "Enter the 6-digit code from the email.", { field: "code" });
  }
  if (typeof newPassword !== "string" || newPassword.length < PASSWORD_MIN_LENGTH) {
    throw new HttpsError(
      "invalid-argument",
      `New password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
      { field: "password" }
    );
  }

  const uid = await findAdminUid(email);
  if (!uid) {
    throw new HttpsError("failed-precondition", "There is no active code for this email. Request a new one.");
  }
  const ref = db.collection("passwordResets").doc(uid);

  // A transaction, so two quick guesses cannot both read the same attempt
  // count and slip past the limit.
  const outcome = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { status: "missing" };
    const record = snap.data();
    if (record.expiresAt.toMillis() < Date.now()) {
      tx.delete(ref);
      return { status: "expired" };
    }
    if (codesMatch(code, record)) return { status: "ok" };

    const attempts = record.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) tx.delete(ref);
    else tx.update(ref, { attempts });
    return { status: "wrong", remaining: MAX_ATTEMPTS - attempts };
  });

  switch (outcome.status) {
    case "missing":
      throw new HttpsError("failed-precondition", "There is no active code for this email. Request a new one.");
    case "expired":
      throw new HttpsError("deadline-exceeded", "This code has expired. Request a new one.");
    case "wrong":
      if (outcome.remaining <= 0) {
        throw new HttpsError("resource-exhausted", "Too many wrong codes. Request a new one.");
      }
      throw new HttpsError(
        "permission-denied",
        `That code is incorrect. ${outcome.remaining} ${outcome.remaining === 1 ? "try" : "tries"} left.`,
        { field: "code", remaining: outcome.remaining }
      );
  }

  try {
    await getAuth().updateUser(uid, { password: newPassword });
  } catch (error) {
    logger.error("Could not update the admin password", error);
    if (error.code === "auth/invalid-password") {
      throw new HttpsError("invalid-argument", "That password isn't allowed. Try a longer one.", { field: "password" });
    }
    throw new HttpsError("internal", "We couldn't change the password. Please try again.");
  }

  // The code is used up, and every other signed-in session ends.
  await ref.delete();
  await getAuth().revokeRefreshTokens(uid);
  return { ok: true };
});

/* ---------- Email verification for User Management > Add User ----------
   An address is only proven to exist by mail reaching it, so before an admin
   can create an account, a 6-digit code is sent to the address and has to be
   typed back. Confirming it marks emailVerifications/{email} verified for
   VERIFIED_WINDOW_MS, and firestore.rules only let an admin create a
   users/{uid} profile whose email has such a record. The records are written
   here only (the rules deny clients), and hold a hash of the code, never the
   code itself. */
const VERIFIED_WINDOW_MS = 60 * 60 * 1000;

// Only a signed-in admin (admins/{uid} exists) may send or confirm codes.
async function requireAdmin(request) {
  const uid = request.auth?.uid;
  if (!uid || !(await db.collection("admins").doc(uid).get()).exists) {
    throw new HttpsError("permission-denied", "Only PeakPath admins can verify new users' emails.");
  }
  return uid;
}

async function sendSignupCodeEmail(to, code) {
  const transporter = mailTransport();
  const minutes = CODE_TTL_MS / 60000;
  const sender = GMAIL_USER.value();
  // Same plain format as the password reset email, to stay out of spam.
  await transporter.sendMail({
    from: { name: "PeakPath", address: sender },
    replyTo: sender,
    to,
    subject: "Your PeakPath email verification code",
    text:
      "Hello,\n\n" +
      "A PeakPath admin is creating an account for you with this email address.\n\n" +
      `Your verification code is: ${code}\n\n` +
      `Give this code to the admin to confirm your email. It expires in ${minutes} minutes.\n\n` +
      "If you didn't expect a PeakPath account, you can ignore this email and no account will be created.\n\n" +
      "PeakPath Admin Portal",
    html: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Your PeakPath email verification code</title></head>
<body style="margin:0;padding:0;background:#ffffff">
  <div style="font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:460px;margin:0 auto;padding:28px 24px;color:#1c231c">
    <h2 style="margin:0 0 16px;font-size:20px;color:#1f6b39">PeakPath</h2>
    <p style="margin:0 0 12px;font-size:14px">Hello,</p>
    <p style="margin:0 0 12px;font-size:14px">A PeakPath admin is creating an account for you with this email address. Your verification code is:</p>
    <p style="margin:0 0 20px;padding:14px;border-radius:10px;background:#e7f5eb;text-align:center;font-size:28px;font-weight:700;letter-spacing:4px;color:#1f6b39">${code}</p>
    <p style="margin:0 0 12px;font-size:14px">Give this code to the admin to confirm your email. It expires in ${minutes} minutes.</p>
    <p style="margin:0 0 20px;font-size:13px;color:#5b6b60">If you didn't expect a PeakPath account, you can ignore this email and no account will be created.</p>
    <p style="margin:0;font-size:12px;color:#93a199">PeakPath Admin Portal</p>
  </div>
</body>
</html>`
  });
}

/* Whether an address can exist, before and after the code is sent.
   1. Format: Gmail usernames are 6-30 letters, numbers and dots (a +tag is
      allowed after them).
   2. Domain: the part after @ must accept mail (MX records), which catches
      typos like gmial.com.
   3. Bounce: Gmail accepts a message to an address that does not exist and
      only then mails an "Address not found" bounce back to the sender, within
      seconds. So after sending, the sender's inbox is watched for that bounce
      for BOUNCE_WAIT_MS (IMAP, with the same app password). If IMAP cannot
      be reached, this step is skipped rather than blocking every send. */
const GMAIL_DOMAINS = ["gmail.com", "googlemail.com"];
const BOUNCE_WAIT_MS = 25 * 1000;
const BOUNCE_POLL_MS = 4 * 1000;

function checkAddressFormat(email) {
  const [local, domain] = email.split("@");
  if (GMAIL_DOMAINS.includes(domain)) {
    const name = local.split("+")[0].replace(/\./g, "");
    if (!/^[a-z0-9.+]+$/.test(local) || !/^[a-z0-9]{6,30}$/.test(name) || /^\.|\.$|\.\./.test(local.split("+")[0])) {
      throw new HttpsError("invalid-argument", "This isn't a valid Gmail address.", { reason: "invalid" });
    }
  }
}

async function checkDomainReceivesMail(email) {
  const domain = email.split("@")[1];
  if (GMAIL_DOMAINS.includes(domain)) return;
  try {
    const records = await dns.resolveMx(domain);
    if (records.length) return;
  } catch (error) {
    if (!["ENOTFOUND", "ENODATA", "ESERVFAIL", "ENOTIMP"].includes(error.code)) {
      logger.warn(`MX lookup for ${domain} failed; not blocking the send`, error);
      return;
    }
  }
  throw new HttpsError("not-found", "This email doesn't exist: its domain does not receive mail.", { reason: "not-existing" });
}

// True when Gmail bounced the message to `email` sent at `sentAt`.
async function bouncedSince(email, sentAt) {
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: GMAIL_USER.value(), pass: GMAIL_APP_PASSWORD.value() },
    logger: false
  });
  try {
    await client.connect();
    const deadline = Date.now() + BOUNCE_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, BOUNCE_POLL_MS));
      const lock = await client.getMailboxLock("INBOX");
      try {
        // Gmail's own search: delivery-failure notices that name the address.
        const uids = await client.search({ gmraw: `from:mailer-daemon newer_than:1d "${email}"` }, { uid: true });
        if (uids?.length) {
          for await (const message of client.fetch(uids, { envelope: true, internalDate: true }, { uid: true })) {
            const when = (message.internalDate || message.envelope?.date || new Date(0)).getTime();
            if (when >= sentAt - 5000) return true;
          }
        }
      } finally {
        lock.release();
      }
    }
    return false;
  } catch (error) {
    logger.warn("Could not check the inbox for a bounce; treating the address as deliverable", error);
    return false;
  } finally {
    await client.logout().catch(() => {});
  }
}

exports.sendSignupVerificationCode = onCall(
  { secrets: [GMAIL_USER, GMAIL_APP_PASSWORD], timeoutSeconds: 90 },
  async (request) => {
    const adminUid = await requireAdmin(request);
    const email = normalizeEmail(request.data?.email);
    checkAddressFormat(email);
    await checkDomainReceivesMail(email);

    // An address that already has an account cannot get a second one.
    try {
      await getAuth().getUserByEmail(email);
      throw new HttpsError("already-exists", "This email already has a PeakPath account.");
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      if (error.code !== "auth/user-not-found") throw error;
    }

    const ref = db.collection("emailVerifications").doc(email);
    const now = Date.now();
    const existing = await ref.get();
    if (existing.exists) {
      const wait = RESEND_COOLDOWN_MS - (now - existing.get("sentAt").toMillis());
      if (wait > 0) {
        const seconds = Math.ceil(wait / 1000);
        throw new HttpsError(
          "resource-exhausted",
          `Please wait ${seconds} seconds before sending another code.`,
          { retryAfter: seconds }
        );
      }
    }

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    const salt = crypto.randomBytes(16).toString("hex");
    await ref.set({
      email,
      salt,
      codeHash: hashCode(code, salt),
      attempts: 0,
      verified: false,
      requestedBy: adminUid,
      sentAt: Timestamp.fromMillis(now),
      expiresAt: Timestamp.fromMillis(now + CODE_TTL_MS)
    });

    try {
      await sendSignupCodeEmail(email, code);
    } catch (error) {
      logger.error("Could not send the email verification code", error);
      // Gmail refused it outright (e.g. a malformed or blocked address).
      await ref.delete();
      throw new HttpsError("unavailable", "We couldn't send a code to this email. Check the address and try again.");
    }

    // Gmail bounces mail for an address that does not exist a few seconds
    // later; if that happens, the code is withdrawn and the admin told.
    if (await bouncedSince(email, now)) {
      await ref.delete();
      throw new HttpsError("not-found", "This email address doesn't exist. Check it for typos.", { reason: "not-existing" });
    }

    return {
      expiresInSeconds: CODE_TTL_MS / 1000,
      resendAfterSeconds: RESEND_COOLDOWN_MS / 1000
    };
  }
);

exports.confirmSignupVerificationCode = onCall(async (request) => {
  await requireAdmin(request);
  const email = normalizeEmail(request.data?.email);
  const code = String(request.data?.code ?? "").trim();
  if (!/^\d{6}$/.test(code)) {
    throw new HttpsError("invalid-argument", "Enter the 6-digit code from the email.", { field: "code" });
  }

  const ref = db.collection("emailVerifications").doc(email);
  // A transaction, so two quick guesses cannot both slip past the limit.
  const outcome = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { status: "missing" };
    const record = snap.data();
    if (record.verified) return { status: "ok" };
    if (record.expiresAt.toMillis() < Date.now()) {
      tx.delete(ref);
      return { status: "expired" };
    }
    if (codesMatch(code, record)) {
      tx.update(ref, {
        verified: true,
        verifiedAt: FieldValue.serverTimestamp(),
        verifiedUntil: Timestamp.fromMillis(Date.now() + VERIFIED_WINDOW_MS),
        codeHash: FieldValue.delete(),
        salt: FieldValue.delete()
      });
      return { status: "ok" };
    }
    const attempts = record.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) tx.delete(ref);
    else tx.update(ref, { attempts });
    return { status: "wrong", remaining: MAX_ATTEMPTS - attempts };
  });

  switch (outcome.status) {
    case "missing":
      throw new HttpsError("failed-precondition", "There is no active code for this email. Send a new one.");
    case "expired":
      throw new HttpsError("deadline-exceeded", "This code has expired. Send a new one.");
    case "wrong":
      if (outcome.remaining <= 0) {
        throw new HttpsError("resource-exhausted", "Too many wrong codes. Send a new one.");
      }
      throw new HttpsError(
        "permission-denied",
        `That code is incorrect. ${outcome.remaining} ${outcome.remaining === 1 ? "try" : "tries"} left.`,
        { field: "code", remaining: outcome.remaining }
      );
  }
  return { verified: true, validForSeconds: VERIFIED_WINDOW_MS / 1000 };
});

/* ---------- Settings > Role & Permission Settings ----------
   Admin roles live on admins/{uid}.role (firestore.rules: adminRole()):
     Super Administrator  everything, and manages the other admins here
     Administrator        day-to-day operations
     Viewer               read-only
   An admin with no role has no access until a Super Administrator assigns
   one (it shows as "No role assigned" here). Only these functions add admins, remove them or change a
   role (the rules deny it to every client), and only for a Super
   Administrator. No one changes their own role or removes themself, and the
   last Super Administrator can never be demoted or removed, so the portal
   cannot be locked. Every change is written to adminRoleLog. */
const ADMIN_ROLES = ["Super Administrator", "Administrator", "Viewer"];
const SUPER_ROLE = "Super Administrator";
// The admin's role, or null when none is set (no access).
const roleOf = (data) => (ADMIN_ROLES.includes(data?.role) ? data.role : null);

async function requireSuperAdmin(request) {
  const uid = request.auth?.uid;
  const snap = uid ? await db.collection("admins").doc(uid).get() : null;
  if (!snap?.exists) {
    throw new HttpsError("permission-denied", "Only PeakPath admins can manage admin roles.");
  }
  if (roleOf(snap.data()) !== SUPER_ROLE) {
    throw new HttpsError("permission-denied", "Only a Super Administrator can manage admin roles.");
  }
  return { uid, name: snap.get("name") || request.auth.token?.name || request.auth.token?.email || "An admin" };
}

const checkRole = (role) => {
  if (!ADMIN_ROLES.includes(role)) {
    throw new HttpsError("invalid-argument", `Choose one of: ${ADMIN_ROLES.join(", ")}.`);
  }
  return role;
};

async function superAdminCount() {
  const all = await db.collection("admins").get();
  return all.docs.filter((d) => roleOf(d.data()) === SUPER_ROLE).length;
}

function logRoleChange(entry) {
  return db.collection("adminRoleLog").add({ ...entry, at: FieldValue.serverTimestamp() });
}

// The admin list for Role Management, with each admin's email and last
// sign-in from Firebase Auth (the admins records do not always hold them).
// Any admin may see it; only a Super Administrator may change it.
exports.listAdmins = onCall(async (request) => {
  const uid = request.auth?.uid;
  const caller = uid ? await db.collection("admins").doc(uid).get() : null;
  if (!caller?.exists || !roleOf(caller.data())) {
    throw new HttpsError("permission-denied", "Only PeakPath admins with a role can see the admin list.");
  }
  const snaps = await db.collection("admins").get();
  const ids = snaps.docs.map((d) => ({ uid: d.id }));
  const users = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const result = await getAuth().getUsers(ids.slice(i, i + 100));
    result.users.forEach((u) => users.set(u.uid, u));
  }
  return {
    me: uid,
    admins: snaps.docs.map((d) => {
      const data = d.data();
      const user = users.get(d.id);
      return {
        uid: d.id,
        name: data.name || user?.displayName || "",
        username: data.username || "",
        email: data.email || user?.email || "",
        role: roleOf(data),
        lastSignIn: user?.metadata?.lastSignInTime || null
      };
    }).sort((a, b) => (a.role ? ADMIN_ROLES.indexOf(a.role) : ADMIN_ROLES.length) - (b.role ? ADMIN_ROLES.indexOf(b.role) : ADMIN_ROLES.length) || a.name.localeCompare(b.name))
  };
});

// User Management > View user > Set Password: an admin types a new password
// for an app user and it takes effect at once, for a hiker who can't get at
// their email (at the ranger station, say). Super Administrators and
// Administrators only, never a Viewer; and never on an admin account, whose
// password only its owner changes (Forgot Password on the login page). The
// user is signed out everywhere, so the old password stops working at once.
exports.setUserPassword = onCall(async (request) => {
  const callerUid = request.auth?.uid;
  const caller = callerUid ? await db.collection("admins").doc(callerUid).get() : null;
  const callerRole = caller?.exists ? roleOf(caller.data()) : null;
  if (!callerRole || callerRole === "Viewer") {
    throw new HttpsError("permission-denied", "Only Super Administrators and Administrators can set a user's password.");
  }

  const uid = String(request.data?.uid || "");
  const newPassword = request.data?.newPassword;
  if (!uid) throw new HttpsError("invalid-argument", "Choose a user.");
  if (typeof newPassword !== "string" || newPassword.length < PASSWORD_MIN_LENGTH) {
    throw new HttpsError("invalid-argument", `The password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
  if ((await db.collection("admins").doc(uid).get()).exists) {
    throw new HttpsError("permission-denied", "An admin's password can only be changed by that admin.");
  }

  try {
    await getAuth().updateUser(uid, { password: newPassword });
  } catch (error) {
    if (error.code === "auth/user-not-found") {
      throw new HttpsError("not-found", "This user has no sign-in account.");
    }
    if (error.code === "auth/invalid-password") {
      throw new HttpsError("invalid-argument", "Firebase refused that password. Try a longer one.");
    }
    throw error;
  }
  await getAuth().revokeRefreshTokens(uid);
  // Who set it and when, on the user's record (never the password itself).
  await db.collection("users").doc(uid).update({
    passwordSetByAdminAt: FieldValue.serverTimestamp(),
    passwordSetByAdmin: callerUid
  }).catch((error) => logger.warn("Could not record the password change", error));
  return { ok: true };
});

exports.setAdminRole = onCall(async (request) => {
  const caller = await requireSuperAdmin(request);
  const uid = String(request.data?.uid || "");
  const role = checkRole(request.data?.role);
  if (!uid) throw new HttpsError("invalid-argument", "Choose an admin.");
  if (uid === caller.uid) {
    throw new HttpsError("failed-precondition", "You can't change your own role. Ask another Super Administrator.");
  }
  const ref = db.collection("admins").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "That admin no longer exists.");
  const from = roleOf(snap.data());
  if (from === role) return { role };
  if (from === SUPER_ROLE && (await superAdminCount()) <= 1) {
    throw new HttpsError("failed-precondition", "There must always be at least one Super Administrator.");
  }
  await ref.update({ role, roleUpdatedAt: FieldValue.serverTimestamp(), roleUpdatedBy: caller.uid });
  await logRoleChange({
    action: "role", targetUid: uid, targetName: snap.get("name") || "", targetEmail: snap.get("email") || "",
    from, to: role, byUid: caller.uid, byName: caller.name
  });
  return { role };
});

exports.addAdmin = onCall({ secrets: [GMAIL_USER, GMAIL_APP_PASSWORD] }, async (request) => {
  const caller = await requireSuperAdmin(request);
  const email = normalizeEmail(request.data?.email);
  const role = checkRole(request.data?.role);
  const name = String(request.data?.name || "").trim().slice(0, 80);

  // An existing sign-in account is promoted; otherwise one is created and
  // the new admin is emailed a link to choose their password.
  let user;
  let created = false;
  try {
    user = await getAuth().getUserByEmail(email);
  } catch (error) {
    if (error.code !== "auth/user-not-found") throw error;
    user = await getAuth().createUser({ email, displayName: name || undefined });
    created = true;
  }
  const ref = db.collection("admins").doc(user.uid);
  if ((await ref.get()).exists) {
    throw new HttpsError("already-exists", "This email is already a PeakPath admin.");
  }
  await ref.set({
    name: name || user.displayName || "",
    email,
    role,
    createdAt: FieldValue.serverTimestamp(),
    addedBy: caller.uid
  });
  await db.collection("adminEmails").doc(email).set({ uid: user.uid, email, updatedAt: FieldValue.serverTimestamp() });

  let emailed = false;
  if (created) {
    try {
      const link = await getAuth().generatePasswordResetLink(email);
      const sender = GMAIL_USER.value();
      await mailTransport().sendMail({
        from: { name: "PeakPath", address: sender },
        replyTo: sender,
        to: email,
        subject: "You've been added as a PeakPath admin",
        text:
          `Hello${name ? ` ${name}` : ""},\n\n` +
          `${caller.name} added you to the PeakPath Admin Portal as ${role}.\n\n` +
          `Choose your password here: ${link}\n\nThen sign in at the PeakPath Admin Portal with this email.\n\nPeakPath Admin Portal`,
        html: `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>PeakPath admin access</title></head>
<body style="margin:0;padding:0;background:#ffffff"><div style="font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:460px;margin:0 auto;padding:28px 24px;color:#1c231c">
<h2 style="margin:0 0 16px;font-size:20px;color:#1f6b39">PeakPath</h2>
<p style="margin:0 0 12px;font-size:14px">Hello${name ? ` ${escapeHtml(name)}` : ""},</p>
<p style="margin:0 0 12px;font-size:14px">${escapeHtml(caller.name)} added you to the PeakPath Admin Portal as <strong>${escapeHtml(role)}</strong>.</p>
<p style="margin:0 0 20px;font-size:14px"><a href="${link}" style="color:#1f6b39;font-weight:700">Choose your password</a>, then sign in with this email.</p>
<p style="margin:0;font-size:12px;color:#93a199">PeakPath Admin Portal</p></div></body></html>`
      });
      emailed = true;
    } catch (error) {
      logger.error("Could not email the new admin their password link", error);
    }
  }

  await logRoleChange({
    action: "add", targetUid: user.uid, targetName: name || user.displayName || "", targetEmail: email,
    from: null, to: role, byUid: caller.uid, byName: caller.name
  });
  return { uid: user.uid, created, emailed };
});

exports.removeAdmin = onCall(async (request) => {
  const caller = await requireSuperAdmin(request);
  const uid = String(request.data?.uid || "");
  if (!uid) throw new HttpsError("invalid-argument", "Choose an admin.");
  if (uid === caller.uid) {
    throw new HttpsError("failed-precondition", "You can't remove your own admin access.");
  }
  const ref = db.collection("admins").doc(uid);
  const snap = await ref.get();
  if (!snap.exists) return { removed: false };
  const from = roleOf(snap.data());
  if (from === SUPER_ROLE && (await superAdminCount()) <= 1) {
    throw new HttpsError("failed-precondition", "There must always be at least one Super Administrator.");
  }
  // Their sign-in account stays (it may also be a hiker's); it just stops
  // being an admin, and any open portal session is signed out.
  await ref.delete();
  const email = String(snap.get("email") || "").toLowerCase();
  if (email) await db.collection("adminEmails").doc(email).delete().catch(() => {});
  await getAuth().revokeRefreshTokens(uid).catch(() => {});
  await logRoleChange({
    action: "remove", targetUid: uid, targetName: snap.get("name") || "", targetEmail: email,
    from, to: null, byUid: caller.uid, byName: caller.name
  });
  return { removed: true };
});

/* ==========================================================================
   Advisories & Announcements — the "Email" channel.

   When an admin saves an advisory with Email ticked, it is emailed to every
   registered user in `users` (only guides when Visibility is "Guide").
   Progress is written back onto the advisory as an `email` map, which the
   A&A page shows under Channels:
     email.status      "scheduled" | "sending" | "sent" | "failed"
     email.sentAt      when it went out
     email.recipients  how many addresses it went to

   Each advisory is emailed once. Editing it later does not send it again;
   re-accepting an expired one (A&A sets `restoredAt`) does, like the in-app
   notification. An advisory whose Effective date is still ahead is marked
   "scheduled" and sent by emailDueAdvisories once that date arrives.

   Advisories that already existed before this was deployed are never
   emailed unless someone saves them again with Email ticked.
   ========================================================================== */

// Firestore triggers must run where the database lives.
const FIRESTORE_REGION = "asia-southeast1";
// Recipients go in Bcc, so no user sees another's address; Gmail accepts up
// to 100 per message. A normal Gmail account can send to about 500 people a
// day in total.
const BCC_BATCH = 90;
// A claim older than this is from a run that crashed, and may be retried.
const EMAIL_STALE_MS = 10 * 60 * 1000;
const EMAIL_RETRY_MS = 10 * 60 * 1000;
const EMAIL_MAX_ATTEMPTS = 3;

const toMillis = (value) => {
  if (!value) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
};

// What to do with an advisory's email right now: "send", "schedule" (the
// Effective date is still ahead) or null (nothing).
function advisoryEmailAction(advisory, now = Date.now()) {
  if (!advisory || advisory.visible === false) return null;
  if (!Array.isArray(advisory.channels) || !advisory.channels.includes("Email")) return null;
  const status = String(advisory.status || "").toLowerCase();
  if (status !== "active" && status !== "scheduled") return null;
  const expires = toMillis(advisory.expiresAt);
  if (expires && expires <= now) return null;

  const email = advisory.email || {};
  const sentAt = toMillis(email.sentAt);
  const restoredAt = toMillis(advisory.restoredAt);
  if (sentAt && !(restoredAt && restoredAt > sentAt)) return null;
  if (email.status === "sending" && now - (toMillis(email.claimedAt) || 0) < EMAIL_STALE_MS) return null;
  if (email.status === "failed") {
    if ((email.attempts || 0) >= EMAIL_MAX_ATTEMPTS) return null;
    if (now - (toMillis(email.failedAt) || 0) < EMAIL_RETRY_MS) return null;
  }

  const starts = toMillis(advisory.effectiveDate || advisory.publishedAt);
  return starts && starts > now ? "schedule" : "send";
}

// Marks the advisory as being sent, inside a transaction, so the trigger and
// the scheduled sweep can never both send the same one.
function claimAdvisoryEmail(ref) {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const advisory = snap.exists ? snap.data() : null;
    if (advisoryEmailAction(advisory) !== "send") return null;
    tx.update(ref, {
      "email.status": "sending",
      "email.claimedAt": FieldValue.serverTimestamp()
    });
    return advisory;
  });
}

// Every UID in `admins` and every address that belongs to one (their Auth
// email and any adminEmails entry pointing at them). Admins publish the
// advisories, so they are never on the mailing list themselves.
async function adminIdentities() {
  const uids = new Set((await db.collection("admins").get()).docs.map((adminDoc) => adminDoc.id));
  const emails = new Set();
  const entries = await db.collection("adminEmails").get();
  entries.forEach((entry) => {
    if (uids.has(entry.get("uid"))) emails.add(entry.id.trim().toLowerCase());
  });
  const ids = [...uids].map((uid) => ({ uid }));
  for (let i = 0; i < ids.length; i += 100) {
    try {
      const { users } = await getAuth().getUsers(ids.slice(i, i + 100));
      users.forEach((user) => user.email && emails.add(user.email.trim().toLowerCase()));
    } catch (error) {
      logger.warn("Could not look up admin accounts in Auth", error);
    }
  }
  return { uids, emails };
}

async function advisoryRecipients(visibility) {
  const guidesOnly = visibility === "Guide";
  const [snap, admins] = await Promise.all([db.collection("users").get(), adminIdentities()]);
  const emails = new Set();
  snap.forEach((userDoc) => {
    if (admins.uids.has(userDoc.id)) return;
    const user = userDoc.data() || {};
    const email = String(user.email || user.Email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
    if (admins.emails.has(email)) return;
    if (String(user.role || user.Role || "").toLowerCase() === "admin") return;
    // Suspended hikers still get safety advisories; only deactivated
    // accounts are left out.
    if (String(user.status || user.Status || "").toLowerCase() === "deactivated") return;
    if (guidesOnly && !String(user.role || user.Role || "").toLowerCase().includes("guide")) return;
    emails.add(email);
  });
  return [...emails];
}

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

const formatManila = (value) => {
  const ms = toMillis(value);
  if (!ms) return null;
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(ms));
};

const RISK_COLORS = {
  high: { bg: "#fbe9e7", text: "#c8402f" },
  moderate: { bg: "#fbf1e2", text: "#b9791b" },
  low: { bg: "#e7f5eb", text: "#2f8f4e" }
};

// `images` are the photos already downloaded by loadAdvisoryImages.
function advisoryMessage(advisory, images = []) {
  const videos = advisoryMedia(advisory, "video");
  const type = advisory.type || "Advisory";
  const title = advisory.title || "Untitled";
  const risk = advisory.riskLevel || "";
  const riskColor = RISK_COLORS[risk.toLowerCase()] || RISK_COLORS.moderate;
  const trail = advisory.target || "All Trails";
  const effective = formatManila(advisory.effectiveDate || advisory.publishedAt);
  const expires = formatManila(advisory.expiresAt);
  const desc = advisory.desc || "";
  const actions = Array.isArray(advisory.recommendedActions) ? advisory.recommendedActions : [];
  const publishedBy = advisory.publishedBy || "PeakPath Admin";

  const details = [
    ["Trail", trail],
    risk && ["Risk level", risk],
    effective && ["Effective", effective],
    expires && ["Until", expires]
  ].filter(Boolean);

  const text = [
    `PeakPath ${type}: ${title}`,
    "",
    ...details.map(([label, value]) => `${label}: ${value}`),
    "",
    desc,
    images.length ? `\n${images.length} photo${images.length === 1 ? "" : "s"} attached.` : "",
    ...videos.map((video) => `Video: ${video.url}`),
    actions.length ? "\nRecommended actions:" : "",
    ...actions.map((action) => `- ${action}`),
    "",
    `Published by ${publishedBy}`,
    "You are receiving this because you have a PeakPath account."
  ].join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#ffffff">
  <div style="font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:28px 24px;color:#1c231c">
    <p style="margin:0 0 4px;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#1f6b39">PeakPath ${escapeHtml(type)}</p>
    <h2 style="margin:0 0 14px;font-size:21px;line-height:1.3;color:#1c231c">${escapeHtml(title)}</h2>
    ${risk ? `<p style="margin:0 0 16px"><span style="display:inline-block;padding:3px 12px;border-radius:999px;background:${riskColor.bg};color:${riskColor.text};font-size:12px;font-weight:700">${escapeHtml(risk)} risk</span></p>` : ""}
    <table style="margin:0 0 18px;border-collapse:collapse;font-size:13.5px">
      ${details.filter(([label]) => label !== "Risk level").map(([label, value]) =>
        `<tr><td style="padding:3px 16px 3px 0;color:#5b6b60">${escapeHtml(label)}</td><td style="padding:3px 0;font-weight:600">${escapeHtml(value)}</td></tr>`).join("")}
    </table>
    ${desc ? `<p style="margin:0 0 18px;font-size:14.5px;line-height:1.6;white-space:pre-line">${escapeHtml(desc)}</p>` : ""}
    ${images.map((image) =>
      `<p style="margin:0 0 12px"><img src="cid:${image.cid}" alt="${escapeHtml(image.filename)}" style="display:block;max-width:100%;height:auto;border-radius:10px"></p>`).join("")}
    ${videos.map((video) =>
      `<p style="margin:0 0 12px;font-size:14px"><a href="${escapeHtml(video.url)}" style="color:#1f6b39;font-weight:700">&#9654; Watch video${video.name ? `: ${escapeHtml(video.name)}` : ""}</a></p>`).join("")}
    ${actions.length ? `<p style="margin:${images.length || videos.length ? "18px" : "0"} 0 6px;font-size:14px;font-weight:700;color:#1f6b39">Recommended actions</p>
    <ul style="margin:0 0 18px;padding-left:20px;font-size:14px;line-height:1.6">${actions.map((action) => `<li>${escapeHtml(action)}</li>`).join("")}</ul>` : ""}
    <p style="margin:24px 0 0;padding-top:14px;border-top:1px solid #e4e7e1;font-size:12px;color:#93a199">Published by ${escapeHtml(publishedBy)} · You are receiving this because you have a PeakPath account.</p>
  </div>
</body>
</html>`;

  return { subject: `PeakPath ${type}: ${title}`, text, html, attachments: images };
}

/* ---- Photos and videos in the email ----
   The advisory's photos travel inside the email (inline attachments shown by
   "cid:" in the HTML), so they appear even where remote images are blocked.
   They were already shrunk by the A&A page before upload. Videos are far too
   large to attach, so each gets a link to watch it instead. */
const MEDIA_URL_PREFIX = "https://firebasestorage.googleapis.com/";
const MAX_EMAIL_IMAGES = 6;
const MAX_EMAIL_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_EXTENSIONS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

// Only files in this project's Storage are fetched or linked, whatever the
// advisory document says.
const advisoryMedia = (advisory, kind) =>
  (Array.isArray(advisory.media) ? advisory.media : []).filter(
    (item) => item && item.type === kind && typeof item.url === "string" && item.url.startsWith(MEDIA_URL_PREFIX)
  );

// Downloads the photos once, so every Bcc batch reuses the same bytes. One
// that cannot be fetched is left out rather than failing the whole email.
async function loadAdvisoryImages(advisory) {
  const images = [];
  for (const [index, item] of advisoryMedia(advisory, "image").slice(0, MAX_EMAIL_IMAGES).entries()) {
    try {
      const response = await fetch(item.url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const content = Buffer.from(await response.arrayBuffer());
      if (content.length > MAX_EMAIL_IMAGE_BYTES) continue;
      const contentType = item.contentType || response.headers.get("content-type") || "image/jpeg";
      images.push({
        filename: `photo-${index + 1}.${IMAGE_EXTENSIONS[contentType] || "jpg"}`,
        content,
        contentType,
        cid: `photo${index + 1}@peakpath`
      });
    } catch (error) {
      logger.warn(`Could not attach photo ${index + 1} of an advisory`, error);
    }
  }
  return images;
}

/* The email comes from the admin who saved the advisory (sentByEmail, set by
   the A&A page and the dashboard's quick action), and replies go to them.

   Gmail puts the account that logged in back in From, so the creator's
   address only shows as the sender when the email is sent through the
   creator's own account: one listed in GMAIL_SENDERS. Anyone else is sent
   through GMAIL_USER, still with their name and Reply-To, so replies reach
   them either way. */
function advisorySender(advisory) {
  const fallback = GMAIL_USER.value();
  const admin = String(advisory.sentByEmail || "").trim().toLowerCase();
  const address = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(admin) ? admin : fallback;
  const publisher = String(advisory.publishedBy || "").trim();
  const name = publisher && publisher !== "Admin User" ? `${publisher} (PeakPath)` : "PeakPath Admin";
  const ownPassword = senderPasswords()[address];
  const account = ownPassword ? address : fallback;
  const transporter = ownPassword ? mailTransport(address, ownPassword) : mailTransport();
  return { from: { name, address }, replyTo: address, account, transporter };
}

async function sendAdvisoryEmail(ref, advisory) {
  const recipients = await advisoryRecipients(advisory.visibility);
  const { from, replyTo, account, transporter } = advisorySender(advisory);
  const message = advisoryMessage(advisory, await loadAdvisoryImages(advisory));
  let sent = 0;
  try {
    // Bcc only: putting the sending account in To would drop a copy into
    // the publishing admin's own inbox.
    for (let i = 0; i < recipients.length; i += BCC_BATCH) {
      const batch = recipients.slice(i, i + BCC_BATCH);
      await transporter.sendMail({
        ...message,
        from,
        replyTo,
        bcc: batch
      });
      sent += batch.length;
    }
    await ref.update({
      "email.status": "sent",
      "email.sentAt": FieldValue.serverTimestamp(),
      "email.recipients": sent,
      "email.error": FieldValue.delete()
    });
    logger.info(`Advisory ${ref.id} emailed to ${sent} users through ${account}`);
  } catch (error) {
    logger.error(`Could not email advisory ${ref.id}`, error);
    await ref.update({
      "email.status": "failed",
      "email.failedAt": FieldValue.serverTimestamp(),
      "email.recipients": sent,
      "email.error": String(error.message || error).slice(0, 300),
      "email.attempts": FieldValue.increment(1)
    });
  }
}

async function processAdvisory(ref, advisory) {
  const action = advisoryEmailAction(advisory);
  if (action === "schedule") {
    if (advisory.email?.status !== "scheduled") await ref.update({ "email.status": "scheduled" });
    return;
  }
  if (action !== "send") return;
  const claimed = await claimAdvisoryEmail(ref);
  if (claimed) await sendAdvisoryEmail(ref, claimed);
}

// Runs on every save of an advisory. Its own writes to `email` land here too,
// and advisoryEmailAction lets those pass without sending anything.
exports.emailAdvisory = onDocumentWritten(
  { document: "Advisory/{advisoryId}", region: FIRESTORE_REGION, secrets: [GMAIL_USER, GMAIL_APP_PASSWORD, GMAIL_SENDERS] },
  async (event) => {
    const after = event.data?.after;
    if (!after?.exists) return;
    await processAdvisory(after.ref, after.data());
  }
);

// Sends scheduled advisories once their Effective date arrives, and retries
// failed sends (up to 3 tries, 10 minutes apart).
exports.emailDueAdvisories = onSchedule(
  {
    schedule: "every 15 minutes",
    timeZone: "Asia/Manila",
    region: FIRESTORE_REGION,
    secrets: [GMAIL_USER, GMAIL_APP_PASSWORD, GMAIL_SENDERS]
  },
  async () => {
    const pending = await db
      .collection("Advisory")
      .where("email.status", "in", ["scheduled", "failed", "sending"])
      .get();
    for (const advisoryDoc of pending.docs) {
      await processAdvisory(advisoryDoc.ref, advisoryDoc.data());
    }
  }
);

// =====================================================================
// User Reports > Contact Reported User
// =====================================================================

/* Emails the reported user from the admin who is signed in, straight from
   the portal, and records the contact on the report (once per report, the
   page's rule). The email goes out through the admin's own Gmail when it has
   an app password in GMAIL_SENDERS, so it arrives from that account; anyone
   else is sent through GMAIL_USER with their name and Reply-To, so replies
   still reach them. Super Administrators and Administrators only. */
exports.emailReportedUser = onCall(
  { secrets: [GMAIL_USER, GMAIL_APP_PASSWORD, GMAIL_SENDERS] },
  async (request) => {
    const callerUid = request.auth?.uid;
    const caller = callerUid ? await db.collection("admins").doc(callerUid).get() : null;
    const callerRole = caller?.exists ? roleOf(caller.data()) : null;
    if (!callerRole || callerRole === "Viewer") {
      throw new HttpsError("permission-denied", "Only Super Administrators and Administrators can email users.");
    }

    const reportId = String(request.data?.reportId || "");
    const to = normalizeEmail(request.data?.to);
    const name = String(request.data?.name || "").trim().slice(0, 120) || to;
    const subject = String(request.data?.subject || "").trim().slice(0, 200);
    const message = String(request.data?.message || "").trim().slice(0, 5000);
    if (!reportId) throw new HttpsError("invalid-argument", "Choose a report.");
    if (!subject || !message) throw new HttpsError("invalid-argument", "Write a subject and a message.");

    const reportRef = db.collection("reportedUser").doc(reportId);
    const report = await reportRef.get();
    if (!report.exists) throw new HttpsError("not-found", "That report no longer exists.");
    if (report.get("lastContactedAt")) {
      throw new HttpsError("already-exists", "This user was already contacted about this report.");
    }

    // The signed-in admin: their address and name.
    let adminEmail = String(caller.get("email") || request.auth.token?.email || "").trim().toLowerCase();
    if (!adminEmail) adminEmail = String((await getAuth().getUser(callerUid)).email || "").toLowerCase();
    const adminName = String(caller.get("name") || request.auth.token?.name || "PeakPath Admin").trim();
    const fallback = GMAIL_USER.value();
    const ownPassword = senderPasswords()[adminEmail];
    const transporter = ownPassword ? mailTransport(adminEmail, ownPassword) : mailTransport();
    const sentFrom = ownPassword ? adminEmail : fallback;

    try {
      await transporter.sendMail({
        from: { name: `${adminName} (PeakPath)`, address: adminEmail || fallback },
        replyTo: adminEmail || fallback,
        to,
        subject,
        text: message,
        html: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#1c231c">${
          escapeHtml(message).replace(/\n/g, "<br>")}</div>`
      });
    } catch (error) {
      logger.error(`Could not email the reported user on report ${reportId}`, error);
      throw new HttpsError("unavailable", "The email could not be sent. Please try again.");
    }

    // Recorded once it is sent, in the same shape the page writes.
    const at = new Date().toISOString();
    await reportRef.update({
      lastContactedAt: at,
      actionLog: FieldValue.arrayUnion({
        type: "contact",
        title: `Contacted ${name}`,
        note: `${subject} (sent to ${to} from ${sentFrom})`,
        by: adminName,
        at
      })
    });
    logger.info(`Report ${reportId}: emailed ${to} through ${sentFrom}`);
    return { sentFrom, to };
  }
);

// =====================================================================
// Two-factor sign-in by SMS (Settings > Two-Factor Authentication)
// =====================================================================

/* An admin who turns it on (admins/{uid}.twoFactor) is asked, on any device
   not yet recognised, for a code texted to the phone number on their profile
   (admins/{uid}.phone). The page sends and checks the code with Firebase's
   own phone verification, in a separate throwaway sign-in, and hands the
   resulting ID token here: it proves that phone number was reached. These
   functions check it against the profile and remember the device in
   admins/{uid}/trustedDevices/{deviceId}, which no client can read or write
   (no firestore.rules block), so a browser cannot mark itself recognised.

   The number that passed a code is kept (admins/{uid}.twoFactorPhone, which
   admins cannot write: see firestore.rules), so turning two-factor back on
   later only needs the admin's password (enableTwoFactorWithPassword), not
   another code -- unless the profile phone has changed since.

   A recognised device is tied to the number its code went to: once the
   profile phone is different, every device needs a code to the new number.
   Settings asks for that code before it saves a new number while two-factor
   is on (confirmTwoFactor with `newPhone` saves it). */

// A profile phone ("0917 123 4567", "+63 917...", "9171234567") in E.164.
function toE164(raw) {
  const value = String(raw || "").trim();
  const digits = value.replace(/\D/g, "");
  if (!digits) return "";
  if (value.startsWith("+")) return `+${digits}`;
  if (digits.startsWith("63") && digits.length === 12) return `+${digits}`;
  if (digits.startsWith("0") && digits.length === 11) return `+63${digits.slice(1)}`;
  if (digits.startsWith("9") && digits.length === 10) return `+63${digits}`;
  return `+${digits}`;
}

const maskPhone = (e164) => (e164.length > 6
  ? `${e164.slice(0, e164.length - 7)} ••• ••${e164.slice(-2)}`
  : e164);

const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/;

async function signedInAdmin(request) {
  const uid = request.auth?.uid;
  const snap = uid ? await db.collection("admins").doc(uid).get() : null;
  if (!snap?.exists || !roleOf(snap.data())) {
    throw new HttpsError("permission-denied", "Only PeakPath admins can use two-factor sign-in.");
  }
  return { uid, ref: snap.ref, data: snap.data() };
}

const deviceIdOf = (request) => {
  const id = String(request.data?.deviceId || "");
  if (!DEVICE_ID.test(id)) throw new HttpsError("invalid-argument", "This browser could not be identified.");
  return id;
};

// Whether this device must pass the SMS check now, and where the code goes.
exports.checkTwoFactor = onCall(async (request) => {
  const admin = await signedInAdmin(request);
  const deviceId = deviceIdOf(request);
  const phone = toE164(admin.data.phone);
  const enabled = admin.data.twoFactor === true;
  let trusted = false;
  if (enabled) {
    // Recognised only for the number its code went to: a changed profile
    // phone must be confirmed again on every device.
    const device = await admin.ref.collection("trustedDevices").doc(deviceId).get();
    trusted = device.exists && device.data().phone === phone;
  }
  // Turned on before the confirmed number was kept: a recognised device
  // stores the number its code went to, which proves it the same way.
  let verifiedPhone = admin.data.twoFactorPhone || "";
  if (!verifiedPhone && phone) {
    const proven = await admin.ref.collection("trustedDevices").where("phone", "==", phone).limit(1).get();
    if (!proven.empty) {
      verifiedPhone = phone;
      await admin.ref.update({ twoFactorPhone: phone });
    }
  }
  return {
    enabled,
    required: enabled && !trusted,
    phone,
    masked: phone ? maskPhone(phone) : "",
    // This number already passed a code: turning it on needs the password.
    phoneVerified: Boolean(phone) && verifiedPhone === phone
  };
});

/* The SMS code was right: `phoneToken` is the ID token of the phone sign-in
   it produced. With `enable`, this also turns two-factor on. */
exports.confirmTwoFactor = onCall(async (request) => {
  const admin = await signedInAdmin(request);
  const deviceId = deviceIdOf(request);
  // Settings > Profile Information changing the number while two-factor is
  // on: the code went to the new number, which is saved once it is confirmed.
  const newPhoneRaw = String(request.data?.newPhone || "").trim().replace(/\s+/g, " ");
  if (newPhoneRaw && (!/^\+?[\d\s()-]+$/.test(newPhoneRaw) || !/^\d{7,15}$/.test(newPhoneRaw.replace(/\D/g, "")))) {
    throw new HttpsError("invalid-argument", "Enter a valid phone number.");
  }
  const profilePhone = toE164(newPhoneRaw || admin.data.phone);
  if (!profilePhone) {
    throw new HttpsError("failed-precondition", "Add a phone number to your profile first.");
  }

  let decoded;
  try {
    decoded = await getAuth().verifyIdToken(String(request.data?.phoneToken || ""));
  } catch (error) {
    throw new HttpsError("unauthenticated", "The code check could not be confirmed. Try again.");
  }
  if (decoded.phone_number !== profilePhone) {
    throw new HttpsError("permission-denied", "That code was not sent to the phone number on your profile.");
  }
  // Fresh only: a token from an earlier check cannot be replayed.
  if (Date.now() / 1000 - Number(decoded.auth_time || 0) > 10 * 60) {
    throw new HttpsError("deadline-exceeded", "That code check is too old. Request a new code.");
  }

  const device = String(request.data?.device || "").slice(0, 80);
  await admin.ref.collection("trustedDevices").doc(deviceId).set({
    device,
    phone: profilePhone,
    trustedAt: FieldValue.serverTimestamp()
  });
  // The number is proven: remembered, so turning it on again needs only the
  // password.
  await admin.ref.update({
    twoFactorPhone: profilePhone,
    twoFactorPhoneVerifiedAt: FieldValue.serverTimestamp(),
    ...(newPhoneRaw ? { phone: newPhoneRaw, updatedAt: FieldValue.serverTimestamp() } : {}),
    ...(request.data?.enable === true
      ? { twoFactor: true, twoFactorEnabledAt: FieldValue.serverTimestamp() }
      : {})
  });

  // The throwaway phone sign-in made an Auth account for the number; remove
  // it unless it is someone's real account (an admin or an app user).
  if (decoded.uid !== admin.uid) {
    try {
      const phoneUser = await getAuth().getUser(decoded.uid);
      const onlyPhone = phoneUser.providerData.every((p) => p.providerId === "phone") && !phoneUser.email;
      const [isAdmin, isAppUser] = await Promise.all([
        db.collection("admins").doc(decoded.uid).get().then((s) => s.exists),
        db.collection("users").doc(decoded.uid).get().then((s) => s.exists)
      ]);
      if (onlyPhone && !isAdmin && !isAppUser) await getAuth().deleteUser(decoded.uid);
    } catch (error) {
      logger.warn("Could not tidy the two-factor phone sign-in", error);
    }
  }
  return { ok: true };
});

/* Turns two-factor back on with the admin's password instead of a code:
   allowed when the phone on the profile is the one that already passed a
   code (twoFactorPhone), and the page has just re-entered the password
   (reauthenticateWithCredential), which makes the ID token's auth_time
   fresh. This device is recognised, as after a code. */
exports.enableTwoFactorWithPassword = onCall(async (request) => {
  const admin = await signedInAdmin(request);
  const deviceId = deviceIdOf(request);
  const phone = toE164(admin.data.phone);
  if (!phone) {
    throw new HttpsError("failed-precondition", "Add a phone number to your profile first.");
  }
  if (admin.data.twoFactorPhone !== phone) {
    throw new HttpsError("failed-precondition", "Your phone number has not been confirmed yet. Turn it on with a code instead.");
  }
  const authTime = Number(request.auth.token?.auth_time || 0);
  if (Date.now() / 1000 - authTime > 5 * 60) {
    throw new HttpsError("unauthenticated", "Enter your password again to turn on two-factor sign-in.");
  }
  await admin.ref.collection("trustedDevices").doc(deviceId).set({
    device: String(request.data?.device || "").slice(0, 80),
    phone,
    trustedAt: FieldValue.serverTimestamp()
  });
  await admin.ref.update({ twoFactor: true, twoFactorEnabledAt: FieldValue.serverTimestamp() });
  return { ok: true };
});

// Turns two-factor off and forgets every recognised device. The confirmed
// number (twoFactorPhone) is kept, so turning it back on needs the password.
exports.disableTwoFactor = onCall(async (request) => {
  const admin = await signedInAdmin(request);
  const devices = await admin.ref.collection("trustedDevices").get();
  const batch = db.batch();
  devices.docs.forEach((item) => batch.delete(item.ref));
  batch.update(admin.ref, { twoFactor: false, twoFactorEnabledAt: FieldValue.delete() });
  await batch.commit();
  return { ok: true };
});

// =====================================================================
// User Management > reactivation requests
// =====================================================================

/* Emails a deactivated user the decision on their reactivation request
   (reactivationRequests/{uid}, sent from the app's "Account deactivated"
   screen), once User Management has recorded it as approved or declined.
   Sent through the deciding admin's own Gmail when it has an app password in
   GMAIL_SENDERS, otherwise through GMAIL_USER with their name and Reply-To.
   Super Administrators and Administrators only. */
exports.emailReactivationDecision = onCall(
  { secrets: [GMAIL_USER, GMAIL_APP_PASSWORD, GMAIL_SENDERS] },
  async (request) => {
    const callerUid = request.auth?.uid;
    const caller = callerUid ? await db.collection("admins").doc(callerUid).get() : null;
    const callerRole = caller?.exists ? roleOf(caller.data()) : null;
    if (!callerRole || callerRole === "Viewer") {
      throw new HttpsError("permission-denied", "Only Super Administrators and Administrators can answer requests.");
    }

    const uid = String(request.data?.uid || "");
    const ref = db.collection("reactivationRequests").doc(uid);
    const snap = uid ? await ref.get() : null;
    if (!snap?.exists) throw new HttpsError("not-found", "That request no longer exists.");
    const data = snap.data();
    if (!["approved", "declined"].includes(data.status)) {
      throw new HttpsError("failed-precondition", "Decide the request before emailing it.");
    }
    const to = normalizeEmail(data.email);
    const approved = data.status === "approved";
    const first = String(data.name || "").trim().split(/\s+/)[0] || "there";
    const note = String(data.note || "").trim();

    const message = approved
      ? `Hi ${first},\n\nGood news: your PeakPath account has been reactivated. You can sign in to the app again with your usual username and password.`
        + `${note ? `\n\nNote from the admin: ${note}` : ""}\n\nSee you on the trails,\nThe PeakPath team`
      : `Hi ${first},\n\nWe reviewed your request to reactivate your PeakPath account, and it was not approved this time.`
        + `${note ? `\n\nNote from the admin: ${note}` : ""}`
        + "\n\nIf you have more details to share, you can send a new request from the app or reply to this email.\n\nThe PeakPath team";

    let adminEmail = String(caller.get("email") || request.auth.token?.email || "").trim().toLowerCase();
    if (!adminEmail) adminEmail = String((await getAuth().getUser(callerUid)).email || "").toLowerCase();
    const adminName = String(caller.get("name") || request.auth.token?.name || "PeakPath Admin").trim();
    const ownPassword = senderPasswords()[adminEmail];
    const transporter = ownPassword ? mailTransport(adminEmail, ownPassword) : mailTransport();
    const fallback = GMAIL_USER.value();

    try {
      await transporter.sendMail({
        from: { name: `${adminName} (PeakPath)`, address: adminEmail || fallback },
        replyTo: adminEmail || fallback,
        to,
        subject: approved ? "Your PeakPath account has been reactivated" : "Your PeakPath reactivation request",
        text: message,
        html: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#1c231c">${
          escapeHtml(message).replace(/\n/g, "<br>")}</div>`
      });
    } catch (error) {
      logger.error(`Could not email the reactivation decision to ${uid}`, error);
      throw new HttpsError("unavailable", "The email could not be sent. Please try again.");
    }
    await ref.update({ emailedAt: FieldValue.serverTimestamp() });
    return { ok: true };
  }
);

// =====================================================================
// User Management > Contact User > Email
// =====================================================================

/* An email from the signed-in admin to one user, written in the portal.
   Only to the address on that user's own profile (users/{uid}), so this
   cannot be used to mail anyone else. Sent through the admin's own Gmail
   when it has an app password in GMAIL_SENDERS, otherwise through GMAIL_USER
   with their name and Reply-To. Super Administrators and Administrators. */
exports.emailUser = onCall(
  { secrets: [GMAIL_USER, GMAIL_APP_PASSWORD, GMAIL_SENDERS] },
  async (request) => {
    const callerUid = request.auth?.uid;
    const caller = callerUid ? await db.collection("admins").doc(callerUid).get() : null;
    const callerRole = caller?.exists ? roleOf(caller.data()) : null;
    if (!callerRole || callerRole === "Viewer") {
      throw new HttpsError("permission-denied", "Only Super Administrators and Administrators can email users.");
    }

    const uid = String(request.data?.uid || "");
    const to = normalizeEmail(request.data?.to);
    const subject = String(request.data?.subject || "").trim().slice(0, 200);
    const message = String(request.data?.message || "").trim().slice(0, 5000);
    if (!uid) throw new HttpsError("invalid-argument", "Choose a user.");
    if (!subject || !message) throw new HttpsError("invalid-argument", "Write a subject and a message.");

    const profile = await db.collection("users").doc(uid).get();
    if (!profile.exists) throw new HttpsError("not-found", "That user no longer exists.");
    const onFile = [profile.get("email"), profile.get("Email")]
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean);
    if (!onFile.includes(to)) {
      throw new HttpsError("permission-denied", "That is not the email address on this user's profile.");
    }

    let adminEmail = String(caller.get("email") || request.auth.token?.email || "").trim().toLowerCase();
    if (!adminEmail) adminEmail = String((await getAuth().getUser(callerUid)).email || "").toLowerCase();
    const adminName = String(caller.get("name") || request.auth.token?.name || "PeakPath Admin").trim();
    const ownPassword = senderPasswords()[adminEmail];
    const transporter = ownPassword ? mailTransport(adminEmail, ownPassword) : mailTransport();
    const fallback = GMAIL_USER.value();
    const sentFrom = ownPassword ? adminEmail : fallback;

    try {
      await transporter.sendMail({
        from: { name: `${adminName} (PeakPath)`, address: adminEmail || fallback },
        replyTo: adminEmail || fallback,
        to,
        subject,
        text: message,
        html: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#1c231c">${
          escapeHtml(message).replace(/\n/g, "<br>")}</div>`
      });
    } catch (error) {
      logger.error(`Could not email user ${uid}`, error);
      throw new HttpsError("unavailable", "The email could not be sent. Please try again.");
    }
    logger.info(`Emailed user ${uid} (${to}) through ${sentFrom}`);
    return { sentFrom, to };
  }
);
