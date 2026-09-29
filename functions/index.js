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

   Each deploy pins the secret versions current at that moment, and
   `firebase deploy` skips functions whose code is unchanged -- so after
   changing a secret, the functions keep the old value until the code
   changes and they are deployed again.
   ========================================================================== */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const crypto = require("node:crypto");
const nodemailer = require("nodemailer");

initializeApp();
const db = getFirestore();

const GMAIL_USER = defineSecret("GMAIL_USER");
const GMAIL_APP_PASSWORD = defineSecret("GMAIL_APP_PASSWORD");

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

async function sendCodeEmail(to, code) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_USER.value(), pass: GMAIL_APP_PASSWORD.value() }
  });
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
