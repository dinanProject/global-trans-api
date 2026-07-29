"use strict";

let nodemailer;
try {
  nodemailer = require("nodemailer");
} catch (_) {
  nodemailer = null;
}

let transporter;

function getTransporter() {
  if (!nodemailer)
    throw new Error(
      "Dependency nodemailer belum terpasang. Jalankan: npm install nodemailer",
    );
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure:
        String(process.env.SMTP_SECURE || "false").toLowerCase() === "true",
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
        : undefined,
      tls:
        String(process.env.SMTP_REJECT_UNAUTHORIZED || "true").toLowerCase() ===
        "false"
          ? { rejectUnauthorized: false }
          : undefined,
    });
  }
  return transporter;
}

async function sendEmail(email) {
  const sender = getTransporter();
  const result = await sender.sendMail({
    from: email.fromEmail
      ? email.fromName
        ? `"${String(email.fromName).replaceAll('"', "")}" <${email.fromEmail}>`
        : email.fromEmail
      : process.env.SMTP_FROM_EMAIL,
    to: email.toEmail,
    cc: email.ccEmail || undefined,
    bcc: email.bccEmail || undefined,
    subject: email.subject,
    html: email.bodyHtml || undefined,
    text: email.bodyText || undefined,
  });
  return {
    providerMessageId: result.messageId || null,
    response: result.response || null,
  };
}

module.exports = { sendEmail };
