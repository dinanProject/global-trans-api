"use strict";

const express = require("express");

const router = express.Router();

const {
  authenticate: authentication,
  authorize: authorization,
} = require("../../modules/access/access.middleware");

const db = require("../../lib/db")();

router.use(authentication);

router.get("/", authorization("EMAIL_OUTBOX.VIEW"), async (req, res) => {
  try {
    const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(
      Math.max(Number.parseInt(req.query.limit, 10) || 20, 1),
      100,
    );
    const offset = (page - 1) * limit;
    const search = String(req.query.search || "").trim();
    const status = String(req.query.status || "")
      .trim()
      .toUpperCase();
    const dateFrom = String(req.query.dateFrom || "").trim();
    const dateTo = String(req.query.dateTo || "").trim();

    const applyFilters = (query) => {
      query.whereNull("outbox.deletedAt");

      if (search) {
        const keyword = `%${search}%`;

        query.andWhere((builder) => {
          builder
            .where("outbox.toEmail", "like", keyword)
            .orWhere("outbox.ccEmail", "like", keyword)
            .orWhere("outbox.bccEmail", "like", keyword)
            .orWhere("outbox.subject", "like", keyword)
            .orWhere("outbox.moduleCode", "like", keyword)
            .orWhere("outbox.referenceUuid", "like", keyword)
            .orWhere("outbox.templateCode", "like", keyword)
            .orWhere("outbox.lastErrorMessage", "like", keyword);
        });
      }

      if (status) {
        query.andWhere("outbox.statusCode", status);
      }

      if (dateFrom) {
        query.andWhere("outbox.createdAt", ">=", `${dateFrom} 00:00:00`);
      }

      if (dateTo) {
        query.andWhere("outbox.createdAt", "<=", `${dateTo} 23:59:59`);
      }
    };

    const dataQuery = db("emailOutboxes as outbox").select([
      "outbox.uuid",
      "outbox.moduleCode",
      "outbox.referenceUuid",
      "outbox.contextCode",
      "outbox.templateCode",
      "outbox.fromEmail",
      "outbox.fromName",
      "outbox.toEmail",
      "outbox.ccEmail",
      "outbox.bccEmail",
      "outbox.subject",
      "outbox.statusCode",
      "outbox.priority",
      "outbox.attemptCount",
      "outbox.maxAttempt",
      "outbox.scheduledAt",
      "outbox.queuedAt",
      "outbox.lastAttemptAt",
      "outbox.sentAt",
      "outbox.failedAt",
      "outbox.lastErrorMessage",
      "outbox.providerMessageId",
      "outbox.isActive",
      "outbox.createdAt",
      "outbox.updatedAt",
    ]);

    applyFilters(dataQuery);

    const countQuery = db("emailOutboxes as outbox").count({
      total: "outbox.id",
    });
    applyFilters(countQuery);

    const [rows, countResult] = await Promise.all([
      dataQuery
        .orderBy("outbox.createdAt", "desc")
        .orderBy("outbox.id", "desc")
        .limit(limit)
        .offset(offset),
      countQuery.first(),
    ]);

    const total = Number(countResult?.total || 0);

    return res.success({
      data: rows.map((row) => ({
        ...row,
        priority: Number(row.priority || 0),
        attemptCount: Number(row.attemptCount || 0),
        maxAttempt: Number(row.maxAttempt || 0),
        isActive: Boolean(row.isActive),
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("GET /email error:", error);

    return res.fail(error.message || "Failed to load email outboxes.");
  }
});

router.get("/:uuid", authorization("EMAIL_OUTBOX.VIEW"), async (req, res) => {
  try {
    const outbox = await db("emailOutboxes")
      .where("uuid", req.params.uuid)
      .whereNull("deletedAt")
      .first();

    if (!outbox) {
      return res.incomplete("Email outbox tidak ditemukan.");
    }

    return res.success({
      ...outbox,
      priority: Number(outbox.priority || 0),
      attemptCount: Number(outbox.attemptCount || 0),
      maxAttempt: Number(outbox.maxAttempt || 0),
      isActive: Boolean(outbox.isActive),
    });
  } catch (error) {
    console.error("GET /email/:uuid error:", error);

    return res.fail(error.message || "Failed to load email outbox detail.");
  }
});

router.post(
  "/:uuid/retry",
  authorization("EMAIL_OUTBOX.RETRY"),
  async (req, res) => {
    const trx = await db.transaction();

    try {
      const outbox = await trx("emailOutboxes")
        .where("uuid", req.params.uuid)
        .whereNull("deletedAt")
        .first()
        .forUpdate();

      if (!outbox) {
        await trx.rollback();

        return res.incomplete("Email outbox tidak ditemukan.");
      }

      if (
        !["QUEUED", "SENT", "FAILED", "CANCELLED"].includes(outbox.statusCode)
      ) {
        await trx.rollback();

        return res.incomplete(
          "Email yang sedang diproses tidak dapat di-retry.",
        );
      }

      const toEmail = String(req.body?.toEmail ?? outbox.toEmail).trim();
      const ccEmail = String(req.body?.ccEmail ?? outbox.ccEmail ?? "").trim();
      const bccEmail = String(
        req.body?.bccEmail ?? outbox.bccEmail ?? "",
      ).trim();

      if (!toEmail) {
        await trx.rollback();

        return res.incomplete("To email wajib diisi.");
      }

      const updated = await trx("emailOutboxes")
        .where("id", outbox.id)
        .whereIn("statusCode", ["QUEUED", "SENT", "FAILED", "CANCELLED"])
        .update({
          toEmail,
          ccEmail: ccEmail || null,
          bccEmail: bccEmail || null,
          statusCode: "QUEUED",
          attemptCount: 0,
          scheduledAt: trx.fn.now(),
          queuedAt: trx.fn.now(),
          lastAttemptAt: null,
          sentAt: null,
          failedAt: null,
          lastErrorMessage: null,
          providerMessageId: null,
          isActive: true,
          updatedAt: trx.fn.now(),
        });

      if (!updated) {
        await trx.rollback();

        return res.incomplete(
          "Status email berubah. Refresh data lalu coba lagi.",
        );
      }

      await trx.commit();

      return res.success({
        uuid: outbox.uuid,
        statusCode: "QUEUED",
      });
    } catch (error) {
      await trx.rollback();

      console.error("POST /email/:uuid/retry error:", error);

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
      const outbox = await trx("emailOutboxes")
        .where("uuid", req.params.uuid)
        .whereNull("deletedAt")
        .first(["id", "uuid", "statusCode"])
        .forUpdate();

      if (!outbox) {
        await trx.rollback();

        return res.incomplete("Email outbox tidak ditemukan.");
      }

      if (outbox.statusCode !== "QUEUED") {
        await trx.rollback();

        return res.incomplete("Hanya email QUEUED yang dapat dibatalkan.");
      }

      const updated = await trx("emailOutboxes")
        .where("id", outbox.id)
        .where("statusCode", "QUEUED")
        .update({
          statusCode: "CANCELLED",
          isActive: false,
          updatedAt: trx.fn.now(),
        });

      if (!updated) {
        await trx.rollback();

        return res.incomplete(
          "Status email berubah. Refresh data lalu coba lagi.",
        );
      }

      await trx.commit();

      return res.success({
        uuid: outbox.uuid,
        statusCode: "CANCELLED",
      });
    } catch (error) {
      await trx.rollback();

      console.error("POST /email/:uuid/cancel error:", error);

      return res.fail(error.message || "Failed to cancel email outbox.");
    }
  },
);

module.exports = router;
