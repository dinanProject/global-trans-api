"use strict";

const db = require("../lib/db")();
const { sendEmail } = require("../services/email-sender");

const BATCH_SIZE = Number(process.env.EMAIL_WORKER_BATCH_SIZE || 10);
const POLL_INTERVAL_MS = Number(
  process.env.EMAIL_WORKER_POLL_INTERVAL_MS || 5000,
);
const STUCK_MINUTES = Number(process.env.EMAIL_WORKER_STUCK_MINUTES || 15);
let running = false;
let timer = null;

async function recoverStuckEmails() {
  const threshold = new Date(Date.now() - STUCK_MINUTES * 60 * 1000);
  await db("emailOutboxes")
    .where("statusCode", "SENDING")
    .where("isActive", true)
    .whereNull("deletedAt")
    .where("lastAttemptAt", "<", threshold)
    .update({
      statusCode: "QUEUED",
      lastErrorMessage: "Recovered automatically from stale SENDING state.",
      updatedAt: db.fn.now(),
    });
}

async function claimNextEmail() {
  const trx = await db.transaction();
  try {
    const now = new Date();
    const row = await trx("emailOutboxes")
      .where("statusCode", "QUEUED")
      .where("isActive", true)
      .whereNull("deletedAt")
      .where((builder) =>
        builder.whereNull("scheduledAt").orWhere("scheduledAt", "<=", now),
      )
      .whereRaw("attemptCount < maxAttempt")
      .orderBy([
        { column: "priority", order: "asc" },
        { column: "createdAt", order: "asc" },
      ])
      .forUpdate()
      .first();

    if (!row) {
      await trx.commit();
      return null;
    }

    const updated = await trx("emailOutboxes")
      .where("id", row.id)
      .where("statusCode", "QUEUED")
      .update({
        statusCode: "SENDING",
        attemptCount: Number(row.attemptCount || 0) + 1,
        lastAttemptAt: trx.fn.now(),
        lastErrorMessage: null,
        updatedAt: trx.fn.now(),
      });

    await trx.commit();
    return updated
      ? { ...row, attemptCount: Number(row.attemptCount || 0) + 1 }
      : null;
  } catch (error) {
    await trx.rollback();
    throw error;
  }
}

async function processEmail(email) {
  try {
    const result = await sendEmail(email);
    await db("emailOutboxes")
      .where("id", email.id)
      .where("statusCode", "SENDING")
      .update({
        statusCode: "SENT",
        sentAt: db.fn.now(),
        failedAt: null,
        lastErrorMessage: null,
        providerMessageId: result.providerMessageId,
        updatedAt: db.fn.now(),
      });
    return { id: email.id, statusCode: "SENT" };
  } catch (error) {
    const finalFailure = Number(email.attemptCount) >= Number(email.maxAttempt);
    await db("emailOutboxes")
      .where("id", email.id)
      .where("statusCode", "SENDING")
      .update({
        statusCode: finalFailure ? "FAILED" : "QUEUED",
        failedAt: finalFailure ? db.fn.now() : null,
        lastErrorMessage: String(error.message || error).slice(0, 1000),
        updatedAt: db.fn.now(),
      });
    return {
      id: email.id,
      statusCode: finalFailure ? "FAILED" : "QUEUED",
      error: error.message,
    };
  }
}

async function runOnce() {
  if (running) return [];
  running = true;
  const results = [];
  try {
    await recoverStuckEmails();
    for (let index = 0; index < BATCH_SIZE; index += 1) {
      const email = await claimNextEmail();
      if (!email) break;
      results.push(await processEmail(email));
    }
    return results;
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  runOnce().catch((error) => console.error("Email worker error:", error));
  timer = setInterval(
    () =>
      runOnce().catch((error) => console.error("Email worker error:", error)),
    POLL_INTERVAL_MS,
  );
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

if (require.main === module) {
  start();
  process.on("SIGTERM", () => {
    stop();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    stop();
    process.exit(0);
  });
}

module.exports = {
  claimNextEmail,
  processEmail,
  recoverStuckEmails,
  runOnce,
  start,
  stop,
};
