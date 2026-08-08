"use strict";

const express = require("express");
const { randomUUID } = require("crypto");

const router = express.Router();
const {
  authenticate: authentication,
  authorize: authorization,
} = require("../../modules/access/access.middleware");
const db = require("../../lib/db")();
const {
  extractTemplateVariables,
  renderTemplate,
} = require("../../services/email-outbox");

router.use(authentication);

router.get("/", authorization("EMAIL_TEMPLATE.VIEW"), async (req, res) => {
  try {
    const query = db("emailTemplates as template")
      .select([
        "template.id",
        "template.uuid",
        "template.code",
        "template.name",
        "template.description",
        "template.subjectTemplate",
        "template.htmlTemplate",
        "template.textTemplate",
        "template.isActive",
        "template.createdAt",
        "template.updatedAt",
      ])
      .whereNull("template.deletedAt");

    if (req.query.search) {
      const search = `%${String(req.query.search).trim()}%`;
      query.andWhere((builder) => {
        builder
          .where("template.code", "like", search)
          .orWhere("template.name", "like", search)
          .orWhere("template.description", "like", search);
      });
    }

    if (req.query.isActive !== undefined) {
      query.andWhere("template.isActive", parseBoolean(req.query.isActive));
    }

    const rows = await query.orderBy("template.code", "asc");
    return res.success(rows.map(normalizeTemplate));
  } catch (error) {
    console.error("GET /email-template error:", error);
    return res.fail(error.message || "Failed to load email templates.");
  }
});

router.get("/:uuid", authorization("EMAIL_TEMPLATE.VIEW"), async (req, res) => {
  try {
    const template = await findTemplateByUuid(req.params.uuid);

    if (!template) {
      return res.incomplete("Email template tidak ditemukan.");
    }

    return res.success(normalizeTemplate(template));
  } catch (error) {
    console.error("GET /email-template/:uuid error:", error);
    return res.fail(error.message || "Failed to load email template.");
  }
});

router.post("/", authorization("EMAIL_TEMPLATE.CREATE"), async (req, res) => {
  const trx = await db.transaction();

  try {
    const payload = normalizePayload(req.body);
    const validation = validatePayload(payload);

    if (!validation.valid) {
      await trx.rollback();
      return res.incomplete(validation.message);
    }

    const exists = await trx("emailTemplates")
      .where("code", payload.code)
      .whereNull("deletedAt")
      .first("id");

    if (exists) {
      await trx.rollback();
      return res.incomplete("Email template code sudah digunakan.");
    }

    const now = db.fn.now();
    const uuid = randomUUID();

    await trx("emailTemplates").insert({
      uuid,
      ...payload,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });

    await trx.commit();
    return res.success(normalizeTemplate(await findTemplateByUuid(uuid)));
  } catch (error) {
    await trx.rollback();
    console.error("POST /email-template error:", error);
    return res.fail(error.message || "Failed to create email template.");
  }
});

router.put(
  "/:uuid",
  authorization("EMAIL_TEMPLATE.UPDATE"),
  async (req, res) => {
    const trx = await db.transaction();

    try {
      const existing = await trx("emailTemplates")
        .where("uuid", req.params.uuid)
        .whereNull("deletedAt")
        .first();

      if (!existing) {
        await trx.rollback();
        return res.incomplete("Email template tidak ditemukan.");
      }

      const payload = normalizePayload(req.body, existing);
      const validation = validatePayload(payload);

      if (!validation.valid) {
        await trx.rollback();
        return res.incomplete(validation.message);
      }

      const duplicate = await trx("emailTemplates")
        .where("code", payload.code)
        .whereNot("id", existing.id)
        .whereNull("deletedAt")
        .first("id");

      if (duplicate) {
        await trx.rollback();
        return res.incomplete("Email template code sudah digunakan.");
      }

      await trx("emailTemplates")
        .where("id", existing.id)
        .update({ ...payload, updatedAt: db.fn.now() });

      await trx.commit();
      return res.success(
        normalizeTemplate(await findTemplateByUuid(req.params.uuid)),
      );
    } catch (error) {
      await trx.rollback();
      console.error("PUT /email-template/:uuid error:", error);
      return res.fail(error.message || "Failed to update email template.");
    }
  },
);

router.delete(
  "/:uuid",
  authorization("EMAIL_TEMPLATE.DELETE"),
  async (req, res) => {
    const trx = await db.transaction();

    try {
      const existing = await trx("emailTemplates")
        .where("uuid", req.params.uuid)
        .whereNull("deletedAt")
        .first(["id", "code"]);

      if (!existing) {
        await trx.rollback();
        return res.incomplete("Email template tidak ditemukan.");
      }

      const now = db.fn.now();
      await trx("emailTemplates").where("id", existing.id).update({
        isActive: false,
        deletedAt: now,
        updatedAt: now,
      });

      await trx.commit();
      return res.success({ uuid: req.params.uuid, code: existing.code });
    } catch (error) {
      await trx.rollback();
      console.error("DELETE /email-template/:uuid error:", error);
      return res.fail(error.message || "Failed to delete email template.");
    }
  },
);

router.post(
  "/:uuid/preview",
  authorization("EMAIL_TEMPLATE.VIEW"),
  async (req, res) => {
    try {
      const template = await findTemplateByUuid(req.params.uuid);

      if (!template) {
        return res.incomplete("Email template tidak ditemukan.");
      }

      const payload =
        req.body && typeof req.body.payload === "object"
          ? req.body.payload
          : {};

      return res.success({
        templateCode: template.code,
        payload,
        subject: renderTemplate(template.subjectTemplate, payload, {
          escapeValues: false,
        }),
        bodyHtml: renderTemplate(template.htmlTemplate, payload, {
          escapeValues: true,
        }),
        bodyText: renderTemplate(template.textTemplate, payload, {
          escapeValues: false,
        }),
        variables: extractTemplateVariables(
          template.subjectTemplate,
          template.htmlTemplate,
          template.textTemplate,
        ),
      });
    } catch (error) {
      console.error("POST /email-template/:uuid/preview error:", error);
      return res.fail(error.message || "Failed to preview email template.");
    }
  },
);

async function findTemplateByUuid(uuid) {
  return db("emailTemplates")
    .where("uuid", String(uuid || "").trim())
    .whereNull("deletedAt")
    .first();
}

function normalizePayload(body = {}, fallback = {}) {
  return {
    code: normalizeCode(body.code !== undefined ? body.code : fallback.code),
    name: normalizeString(body.name !== undefined ? body.name : fallback.name),
    description: normalizeNullable(
      body.description !== undefined ? body.description : fallback.description,
    ),
    subjectTemplate: normalizeString(
      body.subjectTemplate !== undefined
        ? body.subjectTemplate
        : fallback.subjectTemplate,
    ),
    htmlTemplate: normalizeString(
      body.htmlTemplate !== undefined
        ? body.htmlTemplate
        : fallback.htmlTemplate,
    ),
    textTemplate: normalizeNullable(
      body.textTemplate !== undefined
        ? body.textTemplate
        : fallback.textTemplate,
    ),
    isActive:
      body.isActive !== undefined
        ? Boolean(body.isActive)
        : fallback.isActive !== undefined
          ? Boolean(fallback.isActive)
          : true,
  };
}

function validatePayload(payload) {
  if (!payload.code) return { valid: false, message: "Code wajib diisi." };
  if (!payload.name) return { valid: false, message: "Name wajib diisi." };
  if (!payload.subjectTemplate)
    return { valid: false, message: "Subject template wajib diisi." };
  if (!payload.htmlTemplate)
    return { valid: false, message: "HTML template wajib diisi." };
  return { valid: true };
}

function normalizeTemplate(row) {
  return {
    ...row,
    isActive: Boolean(row.isActive),
    variables: extractTemplateVariables(
      row.subjectTemplate,
      row.htmlTemplate,
      row.textTemplate,
    ),
  };
}

function normalizeCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}
function normalizeString(value) {
  return String(value || "").trim();
}
function normalizeNullable(value) {
  const result =
    value === null || value === undefined ? "" : String(value).trim();
  return result || null;
}
function parseBoolean(value) {
  return ["1", "true", "yes", "y"].includes(String(value).trim().toLowerCase());
}

module.exports = router;
