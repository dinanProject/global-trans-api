"use strict";

const ACTIVE_STATUSES = ["ASSIGNED", "IN_OPERATION"];

async function validateQuantity(
  trx,
  requestDetailId,
  requestedQuantity,
  excludeAssignmentId = null,
) {
  const query = trx("equipmentAssignments")
    .where("requestDetailId", requestDetailId)
    .where("isActive", true)
    .whereNull("deletedAt")
    .whereIn("statusCode", ACTIVE_STATUSES);
  if (excludeAssignmentId) query.whereNot("id", excludeAssignmentId);
  const result = await query.count({ total: "id" }).first();
  const active = Number((result && result.total) || 0);
  return active < Number(requestedQuantity)
    ? { valid: true, activeAssignments: active }
    : {
        valid: false,
        activeAssignments: active,
        message: `Jumlah assignment aktif sudah mencapai quantity request (${requestedQuantity}).`,
      };
}

async function validateEquipmentOverlap(trx, payload) {
  const query = trx("equipmentAssignments")
    .where("equipmentUnitId", payload.equipmentUnitId)
    .where("isActive", true)
    .whereNull("deletedAt")
    .whereIn("statusCode", ACTIVE_STATUSES)
    .where("plannedStartDate", "<=", payload.plannedEndDate)
    .where("plannedEndDate", ">=", payload.plannedStartDate);
  if (payload.excludeAssignmentId)
    query.whereNot("id", payload.excludeAssignmentId);
  const overlap = await query.first([
    "id",
    "uuid",
    "plannedStartDate",
    "plannedEndDate",
  ]);
  return overlap
    ? {
        valid: false,
        overlap,
        message:
          "Equipment unit sudah memiliki assignment aktif pada periode tersebut.",
      }
    : { valid: true };
}

async function validateOperatorOverlap(trx, payload) {
  if (!payload.operatorUserId) return { valid: true };
  const query = trx("equipmentAssignments")
    .where("operatorUserId", payload.operatorUserId)
    .where("isActive", true)
    .whereNull("deletedAt")
    .whereIn("statusCode", ACTIVE_STATUSES)
    .where("plannedStartDate", "<=", payload.plannedEndDate)
    .where("plannedEndDate", ">=", payload.plannedStartDate);
  if (payload.excludeAssignmentId)
    query.whereNot("id", payload.excludeAssignmentId);
  const overlap = await query.first(["id", "uuid"]);
  return overlap
    ? {
        valid: false,
        overlap,
        message: "Operator sudah memiliki assignment pada periode tersebut.",
      }
    : { valid: true };
}

function validateReplacement(existingAssignment, replacementEquipmentUnitId) {
  if (!existingAssignment)
    return {
      valid: false,
      message: "Assignment yang akan diganti tidak ditemukan.",
    };
  if (
    ["COMPLETED", "REPLACED", "CANCELLED"].includes(
      existingAssignment.statusCode,
    )
  ) {
    return {
      valid: false,
      message: `Assignment berstatus ${existingAssignment.statusCode} tidak dapat diganti.`,
    };
  }
  if (
    Number(existingAssignment.equipmentUnitId) ===
    Number(replacementEquipmentUnitId)
  ) {
    return {
      valid: false,
      message:
        "Equipment unit pengganti harus berbeda dari equipment sebelumnya.",
    };
  }
  return { valid: true };
}

module.exports = {
  ACTIVE_STATUSES,
  validateEquipmentOverlap,
  validateOperatorOverlap,
  validateQuantity,
  validateReplacement,
};
