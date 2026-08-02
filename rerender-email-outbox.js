"use strict";

require("dotenv").config();

const db = require("./src/lib/db")();
const {
  findActiveTemplates,
  renderEmail,
} = require("./src/services/email/template");

async function main() {
  const ids = process.argv.slice(2).map(Number).filter(Boolean);

  if (!ids.length) {
    throw new Error(
      "Masukkan emailOutbox IDs. Contoh: node rerender-email-outbox.js 1 2",
    );
  }

  const outboxes = await db("emailOutboxes")
    .whereIn("id", ids)
    .select(["id", "templateCode", "payload"]);

  const templates = await findActiveTemplates(
    db,
    outboxes.map((item) => item.templateCode),
  );

  for (const outbox of outboxes) {
    const rawPayload =
      typeof outbox.payload === "string"
        ? JSON.parse(outbox.payload)
        : outbox.payload;

    const payload = enrichPayload(rawPayload);

    const template = templates.get(outbox.templateCode);

    if (!template) {
      throw new Error(
        `Template ${outbox.templateCode} tidak ditemukan atau tidak aktif.`,
      );
    }

    const rendered = renderEmail(template, payload, {
      subject: "Notification",
      html: "",
      text: "",
    });

    await db("emailOutboxes")
      .where("id", outbox.id)
      .update({
        payload: JSON.stringify(payload),
        subject: rendered.subject,
        bodyHtml: rendered.html,
        bodyText: rendered.text,
        statusCode: "QUEUED",
        sentAt: null,
        failedAt: null,
        lastErrorMessage: null,
        providerMessageId: null,
        updatedAt: db.fn.now(),
      });

    console.log(`Rerendered outbox ${outbox.id}: ${rendered.subject}`);
  }

  await db.destroy();
}

function buildFrontendUrl(path) {
  const baseUrl = (
    process.env.APP_URL ||
    process.env.FRONTEND_URL ||
    process.env.APP_FRONTEND_URL ||
    ""
  ).replace(/\/$/, "");

  if (!path) return baseUrl;
  if (/^https?:\/\//i.test(path)) return path;

  return baseUrl
    ? `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`
    : path;
}

function enrichPayload(rawPayload = {}) {
  return {
    brandName: process.env.MAIL_COMPANY_NAME || "PT Global Trans Servindo",
    brandLogoUrl: process.env.MAIL_LOGO_URL || "",
    supportEmail:
      process.env.MAIL_SUPPORT_EMAIL || "support@globaltransgroup.id",
    currentYear: new Date().getFullYear(),

    ...rawPayload,

    approvalUrl: buildFrontendUrl("/main/equipment-request/approvals"),
    requestUrl: buildFrontendUrl("/main/equipment-request/requests"),
  };
}

main().catch(async (error) => {
  console.error(error);
  await db.destroy();
  process.exit(1);
});
