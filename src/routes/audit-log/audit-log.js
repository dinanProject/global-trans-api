"use strict";
const express = require("express");
const router = express.Router();
const authentication = require("../../lib/authentication");
const authorization = require("../../lib/authorization");
const db = require("../../lib/db")();
router.use(authentication);
router.get("/", authorization("AUDIT_LOG.VIEW"), async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page || 1), 1);
    const pageSize = Math.min(Math.max(Number(req.query.pageSize || 25), 1), 200);
    const query = db("auditLogs as audit").leftJoin("users as actor", "actor.id", "audit.performedBy")
      .where("audit.isActive", true).whereNull("audit.deletedAt");
    if (req.query.moduleCode) query.where("audit.moduleCode", String(req.query.moduleCode).toUpperCase());
    if (req.query.referenceUuid) query.where("audit.referenceUuid", req.query.referenceUuid);
    if (req.query.actionCode) query.where("audit.actionCode", String(req.query.actionCode).toUpperCase());
    if (req.query.dateFrom) query.where("audit.performedAt", ">=", req.query.dateFrom);
    if (req.query.dateTo) query.where("audit.performedAt", "<=", req.query.dateTo);
    const countRow = await query.clone().clearSelect().clearOrder().count({ total: "audit.id" }).first();
    const rows = await query.select(["audit.*", "actor.uuid as performedByUuid", "actor.fullName as performedByName"])
      .orderBy([{ column: "audit.performedAt", order: "desc" }, { column: "audit.id", order: "desc" }])
      .limit(pageSize).offset((page - 1) * pageSize);
    return res.success({ rows: rows.map(normalize), pagination: { page, pageSize, total: Number(countRow?.total || 0) } });
  } catch (error) { console.error("GET /audit-log error:", error); return res.fail(error.message || "Failed to load audit logs."); }
});
router.get("/:uuid", authorization("AUDIT_LOG.VIEW"), async (req, res) => {
  try { const row = await db("auditLogs").where({ uuid: req.params.uuid, isActive: true }).whereNull("deletedAt").first(); return row ? res.success(normalize(row)) : res.incomplete("Audit log tidak ditemukan."); }
  catch (error) { return res.fail(error.message || "Failed to load audit log."); }
});
function normalize(row) { for (const key of ["beforeData", "afterData"]) if (typeof row[key] === "string") { try { row[key] = JSON.parse(row[key]); } catch (_) {} } return { ...row, isActive: Boolean(row.isActive) }; }
module.exports = router;
