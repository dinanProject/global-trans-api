"use strict";

const express = require("express");

const router = express.Router();
const authentication = require("../../lib/authentication");
const authorization = require("../../lib/authorization");
const db = require("../../lib/db")();

router.use(authentication);

router.get("/", authorization("EMAIL_OUTBOX.VIEW"), async (req, res) => {
  try {
    const query = baseQuery();

    if (req.query.search) {
      const search = `%${String(req.query.search).trim()}%`;
      query.andWhere((builder) => {
        builder
          .where("email.subject", "like", search)
          .orWhere("email.toEmail", "like", search)
          .orWhere("email.referenceUuid", "like", search)
          .orWhere("email.templateCode", "like", search);
      });
    }

    if (req.query.moduleCode)
      query.andWhere("email.moduleCode", normalizeCode(req.query.moduleCode));
    if (req.query.referenceId)
      query.andWhere("email.referenceId", Number(req.query.referenceId));
    if (req.query.referenceUuid)
      query.andWhere(
        "email.referenceUuid",
        String(req.query.referenceUuid).trim(),
      );
    if (req.query.templateCode)
      query.andWhere(
        "email.templateCode",
        normalizeCode(req.query.templateCode),
      );
    if (req.query.statusCode)
      query.andWhere("email.statusCode", normalizeCode(req.query.statusCode));

    const rows = await query.orderBy([
      { column: "email.createdAt", order: "desc" },
      { column: "email.id", order: "desc" },
    ]);

    return res.success(rows.map(normalizeOutbox));
  } catch (error) {
    console.error("GET /email-outbox error:", error);
    return res.fail(error.message || "Failed to load email outboxes.");
  }
});

router.get("/:uuid", authorization("EMAIL_OUTBOX.VIEW"), async (req, res) => {
  try {
    const row = await baseQuery().where("email.uuid", req.params.uuid).first();

    if (!row) return res.incomplete("Email outbox tidak ditemukan.");
    return res.success(normalizeOutbox(row));
  } catch (error) {
    console.error("GET /email-outbox/:uuid error:", error);
    return res.fail(error.message || "Failed to load email outbox.");
  }
});

router.post(
  "/:uuid/retry",
  authorization("EMAIL_OUTBOX.RETRY"),
  async (req, res) => {
    const trx = await db.transaction();

    try {
      const row = await trx("emailOutboxes")
        .where("uuid", req.params.uuid)
        .where("isActive", true)
        .whereNull("deletedAt")
        .first();

      if (!row) {
        await trx.rollback();
        return res.incomplete("Email outbox tidak ditemukan.");
      }

      if (!["FAILED", "CANCELLED"].includes(row.statusCode)) {
        await trx.rollback();
        return res.incomplete(
          "Hanya email FAILED atau CANCELLED yang dapat di-retry.",
        );
      }

      const now = db.fn.now();
      await trx("emailOutboxes")
        .where("id", row.id)
        .update({
          statusCode: "QUEUED",
          attemptCount: 0,
          queuedAt: now,
          scheduledAt:
            req.body && req.body.scheduledAt ? req.body.scheduledAt : null,
          lastAttemptAt: null,
          sentAt: null,
          failedAt: null,
          lastErrorMessage: null,
          providerMessageId: null,
          updatedAt: now,
        });

      await trx.commit();
      return res.success(
        normalizeOutbox(
          await baseQuery().where("email.uuid", req.params.uuid).first(),
        ),
      );
    } catch (error) {
      await trx.rollback();
      console.error("POST /email-outbox/:uuid/retry error:", error);
      return res.fail(error.message || "Failed to retry email outbox.");
    }
  },
);

router.post(
  "/:uuid/cancel",
  authorization("EMAIL_OUTBOX.CANCEL"),
  async (req, res) => {
    const trx = await db.transaction();

    try {
      const row = await trx("emailOutboxes")
        .where("uuid", req.params.uuid)
        .where("isActive", true)
        .whereNull("deletedAt")
        .first();

      if (!row) {
        await trx.rollback();
        return res.incomplete("Email outbox tidak ditemukan.");
      }

      if (!["DRAFT", "QUEUED", "FAILED"].includes(row.statusCode)) {
        await trx.rollback();
        return res.incomplete(
          "Email dengan status tersebut tidak dapat dibatalkan.",
        );
      }

      await trx("emailOutboxes")
        .where("id", row.id)
        .update({
          statusCode: "CANCELLED",
          lastErrorMessage:
            req.body && req.body.remarks
              ? String(req.body.remarks).trim()
              : row.lastErrorMessage,
          updatedAt: db.fn.now(),
        });

      await trx.commit();
      return res.success(
        normalizeOutbox(
          await baseQuery().where("email.uuid", req.params.uuid).first(),
        ),
      );
    } catch (error) {
      await trx.rollback();
      console.error("POST /email-outbox/:uuid/cancel error:", error);
      return res.fail(error.message || "Failed to cancel email outbox.");
    }
  },
);

function baseQuery() {
  return db("emailOutboxes as email")
    .leftJoin("users as recipient", "recipient.id", "email.recipientUserId")
    .select([
      "email.id",
      "email.uuid",
      "email.moduleCode",
      "email.referenceId",
      "email.referenceUuid",
      "email.contextCode",
      "email.contextId",
      "email.recipientUserId",
      "recipient.uuid as recipientUserUuid",
      "recipient.fullName as recipientUserName",
      "email.templateCode",
      "email.payload",
      "email.fromEmail",
      "email.fromName",
      "email.toEmail",
      "email.ccEmail",
      "email.bccEmail",
      "email.subject",
      "email.bodyHtml",
      "email.bodyText",
      "email.statusCode",
      "email.priority",
      "email.attemptCount",
      "email.maxAttempt",
      "email.scheduledAt",
      "email.queuedAt",
      "email.lastAttemptAt",
      "email.sentAt",
      "email.failedAt",
      "email.lastErrorMessage",
      "email.providerMessageId",
      "email.isActive",
      "email.createdAt",
      "email.updatedAt",
    ])
    .where("email.isActive", true)
    .whereNull("email.deletedAt");
}

function normalizeOutbox(row) {
  let payload = row.payload;
  if (typeof payload === "string" && payload) {
    try {
      payload = JSON.parse(payload);
    } catch (_) {
      payload = row.payload;
    }
  }
  return { ...row, payload, isActive: Boolean(row.isActive) };
}

function normalizeCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

module.exports = router;
