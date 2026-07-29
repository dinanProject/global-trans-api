"use strict";
const { randomUUID } = require("crypto");

async function writeAudit(trx, data) {
  const now = trx.fn.now();
  const row = {
    uuid: randomUUID(),
    moduleCode: String(data.moduleCode || "").trim().toUpperCase(),
    referenceId: data.referenceId || null,
    referenceUuid: data.referenceUuid || null,
    actionCode: String(data.actionCode || "").trim().toUpperCase(),
    entityName: data.entityName || null,
    entityId: data.entityId || null,
    beforeData: serialize(data.beforeData),
    afterData: serialize(data.afterData),
    remarks: data.remarks || null,
    ipAddress: data.ipAddress || null,
    userAgent: data.userAgent || null,
    performedBy: data.performedBy || null,
    performedAt: now,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  await trx("auditLogs").insert(row);
  return row;
}
function serialize(value) { return value === undefined || value === null ? null : JSON.stringify(value); }
function requestMeta(req) { return { ipAddress: req.ip || req.connection?.remoteAddress || null, userAgent: req.get ? req.get("user-agent") : null }; }
module.exports = { requestMeta, writeAudit };
