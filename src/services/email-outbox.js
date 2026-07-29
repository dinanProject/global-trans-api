"use strict";

const { randomUUID } = require("crypto");

/**
 * Render {{variable}} or {{nested.variable}} placeholders.
 * HTML templates escape values by default. Triple braces {{{variable}}}
 * intentionally render raw values and should only be used for trusted content.
 */
function renderTemplate(template, payload = {}, options = {}) {
  const source =
    template === null || template === undefined ? "" : String(template);
  const escapeValues = options.escapeValues !== false;

  const rawRendered = source.replace(
    /\{\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}\}/g,
    (_, key) => {
      const value = getPayloadValue(payload, key);
      return value === null || value === undefined ? "" : String(value);
    },
  );

  return rawRendered.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, key) => {
    const value = getPayloadValue(payload, key);
    const normalized =
      value === null || value === undefined ? "" : String(value);
    return escapeValues ? escapeHtml(normalized) : normalized;
  });
}

function getPayloadValue(payload, key) {
  return String(key)
    .split(".")
    .reduce((value, part) => {
      if (value === null || value === undefined || typeof value !== "object") {
        return undefined;
      }

      return value[part];
    }, payload);
}

function extractTemplateVariables(...templates) {
  const variables = new Set();
  const pattern = /\{\{\{?\s*([a-zA-Z0-9_.]+)\s*\}\}\}?/g;

  templates.forEach((template) => {
    const source =
      template === null || template === undefined ? "" : String(template);
    let match;

    while ((match = pattern.exec(source)) !== null) {
      variables.add(match[1]);
    }
  });

  return Array.from(variables).sort();
}

async function getActiveTemplate(trx, templateCode) {
  return trx("emailTemplates")
    .where("code", normalizeCode(templateCode))
    .where("isActive", true)
    .whereNull("deletedAt")
    .first([
      "id",
      "uuid",
      "code",
      "name",
      "subjectTemplate",
      "htmlTemplate",
      "textTemplate",
    ]);
}

async function renderEmail(trx, templateCode, payload = {}) {
  const template = await getActiveTemplate(trx, templateCode);

  if (!template) {
    throw new Error(
      `Email template ${normalizeCode(templateCode)} tidak ditemukan atau tidak aktif.`,
    );
  }

  return {
    template,
    subject: renderTemplate(template.subjectTemplate, payload, {
      escapeValues: false,
    }),
    bodyHtml: renderTemplate(template.htmlTemplate, payload, {
      escapeValues: true,
    }),
    bodyText: renderTemplate(template.textTemplate, payload, {
      escapeValues: false,
    }),
  };
}

async function enqueueEmail(trx, options) {
  const payload =
    options.payload && typeof options.payload === "object"
      ? options.payload
      : {};
  const rendered = await renderEmail(trx, options.templateCode, payload);
  const now = trx.fn.now();

  const row = {
    uuid: randomUUID(),
    moduleCode: normalizeCode(options.moduleCode),
    referenceId: options.referenceId || null,
    referenceUuid: options.referenceUuid || null,
    contextCode: options.contextCode
      ? normalizeCode(options.contextCode)
      : null,
    contextId: options.contextId || null,
    recipientUserId: options.recipientUserId || null,
    templateCode: rendered.template.code,
    payload: JSON.stringify(payload),
    fromEmail: options.fromEmail || null,
    fromName: options.fromName || null,
    toEmail: normalizeRecipients(options.toEmail),
    ccEmail: normalizeRecipients(options.ccEmail),
    bccEmail: normalizeRecipients(options.bccEmail),
    subject: options.subject || rendered.subject,
    bodyHtml: options.bodyHtml || rendered.bodyHtml || null,
    bodyText: options.bodyText || rendered.bodyText || null,
    statusCode: "QUEUED",
    priority: Number.isFinite(Number(options.priority))
      ? Number(options.priority)
      : 100,
    attemptCount: 0,
    maxAttempt: Number.isFinite(Number(options.maxAttempt))
      ? Number(options.maxAttempt)
      : 3,
    scheduledAt: options.scheduledAt || null,
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

  if (!row.toEmail) {
    throw new Error("Recipient email wajib diisi.");
  }

  await trx("emailOutboxes").insert(row);

  return row;
}

async function enqueueMany(trx, items) {
  const results = [];

  for (const item of items) {
    results.push(await enqueueEmail(trx, item));
  }

  return results;
}

function normalizeRecipients(value) {
  if (Array.isArray(value)) {
    const recipients = value
      .map((item) => String(item || "").trim())
      .filter(Boolean);

    return recipients.length > 0 ? recipients.join(",") : null;
  }

  const normalized =
    value === null || value === undefined ? "" : String(value).trim();
  return normalized || null;
}

function normalizeCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

module.exports = {
  enqueueEmail,
  enqueueMany,
  extractTemplateVariables,
  getActiveTemplate,
  renderEmail,
  renderTemplate,
};
