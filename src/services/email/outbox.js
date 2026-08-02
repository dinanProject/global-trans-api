"use strict";

const { randomUUID } = require("crypto");

const { findActiveTemplates, renderEmail } = require("./template");

const DEFAULT_FROM_EMAIL = process.env.MAIL_FROM_EMAIL || "noreply@globaltransgroup.id";
const DEFAULT_FROM_NAME = process.env.MAIL_FROM_NAME || "Global Trans Reservation";
const OUTBOX_STATUS_QUEUED = "QUEUED";

async function enqueueManyEmails(trx, messages, options = {}) {
  const validMessages = (messages || []).filter((message) => Boolean(message.toEmail));

  if (validMessages.length === 0) {
    return;
  }

  const templateCodes = validMessages.map((message) => message.templateCode);
  const templateMap = await findActiveTemplates(trx, templateCodes);
  const now = trx.fn.now();

  await trx("emailOutboxes").insert(
    validMessages.map((message) => {
      const template = templateMap.get(message.templateCode);
      const fallback =
        typeof options.buildFallbackTemplate === "function"
          ? options.buildFallbackTemplate(message.templateCode, message.payload || {})
          : buildDefaultFallbackTemplate(message.templateCode, message.payload || {});
      const rendered = renderEmail(template, message.payload || {}, fallback);

      return {
        uuid: randomUUID(),
        moduleCode: message.moduleCode,
        referenceId: message.referenceId,
        referenceUuid: message.referenceUuid,
        contextCode: message.contextCode,
        contextId: message.contextId,
        recipientUserId: message.recipientUserId || null,
        templateCode: message.templateCode,
        payload: JSON.stringify(message.payload || {}),
        fromEmail: message.fromEmail || DEFAULT_FROM_EMAIL,
        fromName: message.fromName || DEFAULT_FROM_NAME,
        toEmail: message.toEmail,
        ccEmail: message.ccEmail || null,
        bccEmail: message.bccEmail || null,
        subject: rendered.subject,
        bodyHtml: rendered.html,
        bodyText: rendered.text,
        statusCode: message.statusCode || OUTBOX_STATUS_QUEUED,
        priority: message.priority || 5,
        attemptCount: 0,
        maxAttempt: message.maxAttempt || 3,
        scheduledAt: message.scheduledAt || now,
        queuedAt: now,
        lastAttemptAt: null,
        sentAt: null,
        failedAt: null,
        lastErrorMessage: null,
        providerMessageId: null,
        isActive: true,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
    }),
  );
}

function buildDefaultFallbackTemplate(templateCode) {
  return {
    subject: `Notification: ${templateCode}`,
    html: "<!doctype html><html><body><p>You have a new notification.</p></body></html>",
    text: "You have a new notification.",
  };
}

module.exports = {
  enqueueManyEmails,
  OUTBOX_STATUS_QUEUED,
};
