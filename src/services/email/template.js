"use strict";

async function findActiveTemplates(trx, templateCodes) {
  const uniqueCodes = [...new Set((templateCodes || []).filter(Boolean))];

  if (uniqueCodes.length === 0) {
    return new Map();
  }

  const templates = await trx("emailTemplates")
    .whereIn("code", uniqueCodes)
    .where("isActive", 1)
    .whereNull("deletedAt")
    .select(["code", "subjectTemplate", "htmlTemplate", "textTemplate"]);

  return new Map(templates.map((template) => [template.code, template]));
}

function renderEmail(template, payload, fallback) {
  return {
    subject: renderString(template?.subjectTemplate || fallback.subject, payload),
    html: renderString(template?.htmlTemplate || fallback.html, payload),
    text: renderString(template?.textTemplate || fallback.text, payload),
  };
}

function renderString(template, payload) {
  return String(template || "").replace(/{{\s*([\w.]+)\s*}}/g, (_, key) => {
    const value = getPayloadValue(payload, key);
    return value === null || value === undefined ? "" : String(value);
  });
}

function getPayloadValue(payload, path) {
  return path.split(".").reduce((value, key) => {
    if (value === null || value === undefined) {
      return undefined;
    }

    return value[key];
  }, payload);
}

module.exports = {
  findActiveTemplates,
  renderEmail,
  renderString,
};
