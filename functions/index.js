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

async function advisoryRecipients(visibility) {
  const guidesOnly = visibility === "Guide";
  const snap = await db.collection("users").get();
  const emails = new Set();
  snap.forEach((userDoc) => {
    const user = userDoc.data() || {};
    const email = String(user.email || user.Email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
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
    for (let i = 0; i < recipients.length; i += BCC_BATCH) {
      const batch = recipients.slice(i, i + BCC_BATCH);
      await transporter.sendMail({
        ...message,
        from,
        replyTo,
        to: account,
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
