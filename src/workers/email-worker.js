"use strict";

require("dotenv").config();

const nodemailer = require("nodemailer");
const db = require("../lib/db")();

const WORKER_INTERVAL_MS = Number(
  process.env.EMAIL_WORKER_INTERVAL_MS || 30000,
);
const WORKER_BATCH_SIZE = Number(process.env.EMAIL_WORKER_BATCH_SIZE || 10);

let isRunning = false;

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

function buildFrom(outbox) {
  const fromEmail =
    outbox.fromEmail || process.env.MAIL_FROM_EMAIL || process.env.SMTP_USER;

  const fromName =
    outbox.fromName || process.env.MAIL_FROM_NAME || "Global Trans";

  return `"${fromName}" <${fromEmail}>`;
}

async function getPendingEmailOutboxes() {
  return db("emailOutboxes")
    .where("isActive", true)
    .whereNull("deletedAt")
    .where((builder) => {
      builder.where("statusCode", "QUEUED").orWhere(function () {
        this.where("statusCode", "FAILED").whereRaw(
          "attemptCount < maxAttempt",
        );
      });
    })
    .where((builder) => {
      builder
        .whereNull("scheduledAt")
        .orWhere("scheduledAt", "<=", db.fn.now());
    })
    .orderBy("priority", "desc")
    .orderBy("id", "asc")
    .limit(WORKER_BATCH_SIZE)
    .select([
      "id",
      "uuid",
      "toEmail",
      "ccEmail",
      "bccEmail",
      "fromEmail",
      "fromName",
      "subject",
      "bodyHtml",
      "bodyText",
      "statusCode",
      "attemptCount",
      "maxAttempt",
    ]);
}

async function markProcessing(outbox) {
  await db("emailOutboxes")
    .where("id", outbox.id)
    .update({
      statusCode: "PROCESSING",
      attemptCount: Number(outbox.attemptCount || 0) + 1,
      lastAttemptAt: db.fn.now(),
      updatedAt: db.fn.now(),
    });
}

async function markSent(outboxId, result) {
  await db("emailOutboxes")
    .where("id", outboxId)
    .update({
      statusCode: "SENT",
      sentAt: db.fn.now(),
      failedAt: null,
      lastErrorMessage: null,
      providerMessageId: result?.messageId || null,
      updatedAt: db.fn.now(),
    });
}

async function markFailed(outbox, error) {
  const nextAttemptCount = Number(outbox.attemptCount || 0) + 1;
  const maxAttempt = Number(outbox.maxAttempt || 3);
  const finalStatus = nextAttemptCount >= maxAttempt ? "FAILED" : "QUEUED";

  await db("emailOutboxes")
    .where("id", outbox.id)
    .update({
      statusCode: finalStatus,
      failedAt: finalStatus === "FAILED" ? db.fn.now() : null,
      lastErrorMessage: error?.message || String(error),
      updatedAt: db.fn.now(),
    });
}

async function processEmailOutbox(transporter, outbox) {
  try {
    await markProcessing(outbox);

    const result = await transporter.sendMail({
      from: buildFrom(outbox),
      to: outbox.toEmail,
      cc: outbox.ccEmail || undefined,
      bcc: outbox.bccEmail || undefined,
      subject: outbox.subject,
      html: outbox.bodyHtml || undefined,
      text: outbox.bodyText || undefined,
    });

    await markSent(outbox.id, result);

    console.log(
      `[email-worker] SENT outboxId=${outbox.id}, to=${outbox.toEmail}, messageId=${result?.messageId}`,
    );
  } catch (error) {
    await markFailed(outbox, error);

    console.error(
      `[email-worker] FAILED outboxId=${outbox.id}, to=${outbox.toEmail}`,
      error,
    );
  }
}

async function runEmailWorkerOnce() {
  if (isRunning) {
    return;
  }

  isRunning = true;

  try {
    const transporter = createTransporter();
    const outboxes = await getPendingEmailOutboxes();

    if (!outboxes.length) {
      console.log("[email-worker] No pending emails.");
      return;
    }

    console.log(`[email-worker] Processing ${outboxes.length} email(s).`);

    for (const outbox of outboxes) {
      await processEmailOutbox(transporter, outbox);
    }
  } catch (error) {
    console.error("[email-worker] Worker error:", error);
  } finally {
    isRunning = false;
  }
}

function startEmailWorker() {
  console.log(
    `[email-worker] Started. interval=${WORKER_INTERVAL_MS}ms batch=${WORKER_BATCH_SIZE}`,
  );

  runEmailWorkerOnce();

  setInterval(() => {
    runEmailWorkerOnce();
  }, WORKER_INTERVAL_MS);
}

if (require.main === module) {
  startEmailWorker();
}

module.exports = {
  startEmailWorker,
  runEmailWorkerOnce,
};
