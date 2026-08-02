const nodemailer = require("nodemailer");

function createTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE).toLowerCase() === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

async function sendEmail({
  fromEmail,
  fromName,
  toEmail,
  ccEmail,
  bccEmail,
  subject,
  bodyHtml,
  bodyText,
}) {
  const transporter = createTransporter();

  const fromAddress =
    fromEmail || process.env.MAIL_FROM_EMAIL || process.env.SMTP_USER;
  const senderName = fromName || process.env.MAIL_FROM_NAME || "Global Trans";

  return transporter.sendMail({
    from: `"${senderName}" <${fromAddress}>`,
    to: toEmail,
    cc: ccEmail || undefined,
    bcc: bccEmail || undefined,
    subject,
    html: bodyHtml || undefined,
    text: bodyText || undefined,
  });
}

module.exports = {
  sendEmail,
};
