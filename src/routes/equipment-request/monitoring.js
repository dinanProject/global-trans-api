"use strict";

const express = require("express");
const { randomUUID } = require("crypto");

const router = express.Router();

const authentication = require("../../lib/authentication");
const authorization = require("../../lib/authorization");
const db = require("../../lib/db")();

const HOLDER_COMPANY_TYPE = 1;
const STATUS_DRAFT = "DRAFT";
const ACTION_SUBMIT = "SUBMIT";
const ACTION_GTSI_REVIEW = "START_GTSI_REVIEW";

router.use(authentication);

async function findRequestByUuid(uuid, access, trx = db) {
  const query = trx("equipmentRequests as request")
    .leftJoin("companies as company", function () {
      this.on("company.id", "=", "request.companyId").andOnNull(
        "company.deletedAt",
      );
    })
    .leftJoin("divisions as division", function () {
      this.on("division.id", "=", "request.divisionId").andOnNull(
        "division.deletedAt",
      );
    })
    .leftJoin("users as requester", function () {
      this.on("requester.id", "=", "request.requestBy").andOnNull(
        "requester.deletedAt",
      );
    })
    .leftJoin("equipmentRequestStatuses as requestStatus", function () {
      this.on("requestStatus.code", "=", "request.status")
        .andOnVal("requestStatus.isActive", "=", 1)
        .andOnNull("requestStatus.deletedAt");
    })
    .select([
      "request.id",
      "request.uuid",
      "request.requestNo",
      "request.companyId",
      "company.uuid as companyUuid",
      "company.code as companyCode",
      "company.name as companyName",
      "request.divisionId",
      "division.uuid as divisionUuid",
      "division.code as divisionCode",
      "division.name as divisionName",
      "request.requestBy",
      "requester.uuid as requestByUuid",
      "requester.fullName as requestByName",
      "request.requestDate",
      "request.startDate",
      "request.endDate",
      "request.purpose",
      "request.notes",
      "request.status",
      "requestStatus.name as statusName",
      "requestStatus.stage as statusStage",
      "requestStatus.sortOrder as statusSortOrder",
      "requestStatus.allowEdit as statusAllowEdit",
      "requestStatus.isTerminal as statusIsTerminal",
      "request.currentApprovalLevel",
      "request.approvalLocked",
      "request.isActive",
      "request.createdAt",
      "request.updatedAt",
    ])
    .where("request.uuid", uuid)
    .whereNull("request.deletedAt");

  applyRequestScope(query, access, "request");

  return query.first();
}

async function findRequestForUpdate(trx, uuid, access) {
  const query = trx("equipmentRequests as request")
    .leftJoin("equipmentRequestStatuses as requestStatus", function () {
      this.on("requestStatus.code", "=", "request.status")
        .andOnVal("requestStatus.isActive", "=", 1)
        .andOnNull("requestStatus.deletedAt");
    })
    .select([
      "request.*",
      "requestStatus.allowEdit as statusAllowEdit",
      "requestStatus.isTerminal as statusIsTerminal",
    ])
    .where("request.uuid", uuid)
    .whereNull("request.deletedAt")
    .forUpdate();

  applyRequestScope(query, access, "request");

  return query.first();
}

async function findRequestDetails(requestId, trx = db) {
  const details = await trx("equipmentRequestDetails as detail")
    .select([
      "detail.id",
      "detail.uuid",
      "detail.requestId",
      "detail.equipmentCategoryId",
      "detail.equipmentUnitId",
      "detail.rate",
      "detail.remarks",
      "detail.isActive",
      "detail.createdAt",
      "detail.updatedAt",
    ])
    .where("detail.requestId", requestId)
    .whereNull("detail.deletedAt")
    .orderBy("detail.id", "asc");

  return details.map((detail) => ({
    ...detail,
    rate: detail.rate === null ? null : Number(detail.rate),
    isActive: Boolean(detail.isActive),
  }));
}

async function findRequestApprovals(requestId, trx = db) {
  const approvals = await trx("equipmentRequestApprovals as approval")
    .leftJoin("companies as company", function () {
      this.on("company.id", "=", "approval.companyId").andOnNull(
        "company.deletedAt",
      );
    })
    .leftJoin("roles as role", "role.id", "approval.roleId")
    .leftJoin("users as approvalUser", function () {
      this.on("approvalUser.id", "=", "approval.userId").andOnNull(
        "approvalUser.deletedAt",
      );
    })
    .select([
      "approval.id",
      "approval.uuid",
      "approval.requestId",
      "approval.approvalLevel",
      "approval.companyId",
      "company.uuid as companyUuid",
      "company.code as companyCode",
      "company.name as companyName",
      "approval.roleId",
      "role.uuid as roleUuid",
      "role.code as roleCode",
      "role.name as roleName",
      "approval.userId",
      "approvalUser.uuid as userUuid",
      "approvalUser.fullName as userName",
      "approval.status",
      "approval.remarks",
      "approval.actionDate",
      "approval.isActive",
      "approval.createdAt",
      "approval.updatedAt",
    ])
    .where("approval.requestId", requestId)
    .whereNull("approval.deletedAt")
    .orderBy([
      { column: "approval.approvalLevel", order: "asc" },
      { column: "approval.id", order: "asc" },
    ]);

  return approvals.map((approval) => ({
    ...approval,
    approvalLevel: Number(approval.approvalLevel),
    isActive: Boolean(approval.isActive),
  }));
}

async function findRequestHistories(requestId, trx = db) {
  return trx("equipmentRequestHistories as history")
    .leftJoin("users as historyUser", function () {
      this.on("historyUser.id", "=", "history.userId").andOnNull(
        "historyUser.deletedAt",
      );
    })
    .select([
      "history.id",
      "history.uuid",
      "history.requestId",
      "history.activity",
      "history.description",
      "history.userId",
      "historyUser.uuid as userUuid",
      "historyUser.fullName as userName",
      "history.createdAt",
    ])
    .where("history.requestId", requestId)
    .orderBy([
      { column: "history.createdAt", order: "desc" },
      { column: "history.id", order: "desc" },
    ]);
}

async function findAvailableActions(statusCode, access, trx = db) {
  const transitions = await trx(
    "equipmentRequestStatusTransitions as transition",
  )
    .join("equipmentRequestStatuses as destinationStatus", function () {
      this.on("destinationStatus.code", "=", "transition.toStatusCode")
        .andOnVal("destinationStatus.isActive", "=", 1)
        .andOnNull("destinationStatus.deletedAt");
    })
    .select([
      "transition.uuid",
      "transition.fromStatusCode",
      "transition.toStatusCode",
      "destinationStatus.name as toStatusName",
      "transition.actionCode",
      "transition.actionName",
      "transition.actorStage",
      "transition.permissionCode",
      "transition.requiresRemarks",
      "transition.lockRequest",
      "transition.confirmationTitle",
      "transition.confirmationMessage",
      "transition.sortOrder",
    ])
    .where("transition.fromStatusCode", statusCode)
    .where("transition.isActive", 1)
    .whereNull("transition.deletedAt")
    .orderBy("transition.sortOrder", "asc");

  return transitions
    .filter(
      (transition) =>
        !transition.permissionCode ||
        access.permissionCodes.includes(transition.permissionCode),
    )
    .map((transition) => ({
      ...transition,
      requiresRemarks: Boolean(transition.requiresRemarks),
      lockRequest: Boolean(transition.lockRequest),
      sortOrder: Number(transition.sortOrder),
    }));
}

function normalizeReviewSchedulePayload(payload = {}) {
  const startDate = normalizeDate(payload.startDate);
  const endDate = normalizeDate(payload.endDate);

  if (!startDate) {
    return {
      valid: false,
      message: "Start date review wajib diisi dengan format YYYY-MM-DD.",
    };
  }

  if (!endDate) {
    return {
      valid: false,
      message: "End date review wajib diisi dengan format YYYY-MM-DD.",
    };
  }

  if (startDate > endDate) {
    return {
      valid: false,
      message: "End date review tidak boleh lebih kecil dari start date.",
    };
  }

  return {
    valid: true,
    startDate,
    endDate,
  };
}

function buildActionHistoryDescription({
  transition,
  remarks,
  reviewSchedule,
}) {
  if (transition.actionCode === ACTION_GTSI_REVIEW && reviewSchedule?.valid) {
    const scheduleText = `Jadwal direview menjadi ${reviewSchedule.startDate} sampai ${reviewSchedule.endDate}.`;

    return remarks ? `${scheduleText} Catatan: ${remarks}` : scheduleText;
  }

  return (
    remarks ||
    `${transition.actionName}: ${transition.fromStatusCode} menjadi ${transition.toStatusCode}.`
  );
}

function normalizePayload(payload = {}) {
  const rawDetails = Array.isArray(payload.details) ? payload.details : [];

  return {
    companyUuid: normalizeNullableString(payload.companyUuid),
    divisionUuid: normalizeNullableString(payload.divisionUuid),
    startDate: normalizeDate(payload.startDate),
    endDate: normalizeDate(payload.endDate),
    purpose: normalizeNullableString(payload.purpose),
    notes: normalizeNullableString(payload.notes),
    details: rawDetails.map((detail) => ({
      uuid: normalizeNullableString(detail?.uuid),
      equipmentCategoryId: normalizePositiveInteger(
        detail?.equipmentCategoryId,
      ),
      equipmentUnitId: normalizePositiveInteger(detail?.equipmentUnitId),
      rate: normalizeNullableDecimal(detail?.rate),
      remarks: normalizeNullableString(detail?.remarks),
    })),
  };
}

function validatePayload(payload) {
  if (!payload.startDate) {
    return {
      valid: false,
      message: "Start date wajib diisi dengan format YYYY-MM-DD.",
    };
  }

  if (!payload.endDate) {
    return {
      valid: false,
      message: "End date wajib diisi dengan format YYYY-MM-DD.",
    };
  }

  if (payload.startDate > payload.endDate) {
    return {
      valid: false,
      message: "End date tidak boleh lebih kecil dari start date.",
    };
  }

  if (payload.purpose && payload.purpose.length > 65535) {
    return {
      valid: false,
      message: "Purpose terlalu panjang.",
    };
  }

  if (payload.notes && payload.notes.length > 65535) {
    return {
      valid: false,
      message: "Notes terlalu panjang.",
    };
  }

  if (!Array.isArray(payload.details) || payload.details.length === 0) {
    return {
      valid: false,
      message: "Equipment request harus memiliki minimal satu detail.",
    };
  }

  for (let index = 0; index < payload.details.length; index += 1) {
    const detail = payload.details[index];
    const rowNumber = index + 1;

    if (!detail.equipmentCategoryId) {
      return {
        valid: false,
        message: `Equipment category pada detail baris ${rowNumber} wajib diisi.`,
      };
    }
    if (!detail.equipmentUnitId) {
      return {
        valid: false,
        message: `Equipment unit pada detail baris ${rowNumber} wajib diisi.`,
      };
    }
    if (detail.rate !== null && detail.rate < 0) {
      return {
        valid: false,
        message: `Rate pada detail baris ${rowNumber} tidak boleh negatif.`,
      };
    }
  }

  return {
    valid: true,
  };
}

async function validateDetails(trx, details, requestId = null) {
  const categoryIds = [
    ...new Set(details.map((detail) => detail.equipmentCategoryId)),
  ];

  const categories = await trx("equipmentCategories")
    .whereIn("id", categoryIds)
    .where("isActive", true)
    .whereNull("deletedAt")
    .select("id");

  if (categories.length !== categoryIds.length) {
    return {
      valid: false,
      message: "Terdapat equipment category yang tidak valid atau tidak aktif.",
    };
  }

  const suppliedDetailUuids = details
    .map((detail) => detail.uuid)
    .filter(Boolean);

  if (new Set(suppliedDetailUuids).size !== suppliedDetailUuids.length) {
    return {
      valid: false,
      message: "UUID detail tidak boleh duplikat.",
    };
  }

  if (requestId && suppliedDetailUuids.length > 0) {
    const existingDetails = await trx("equipmentRequestDetails")
      .where("requestId", requestId)
      .whereIn("uuid", suppliedDetailUuids)
      .whereNull("deletedAt")
      .select("uuid");

    if (existingDetails.length !== suppliedDetailUuids.length) {
      return {
        valid: false,
        message:
          "Terdapat detail yang tidak ditemukan atau bukan milik equipment request ini.",
      };
    }
  }

  return {
    valid: true,
  };
}

async function resolveCompanyId(
  trx,
  companyUuid,
  access,
  existingCompanyId = null,
) {
  if (!isHolderAccess(access)) {
    return access.company?.id || null;
  }

  if (!companyUuid && existingCompanyId) {
    return existingCompanyId;
  }

  if (!companyUuid) {
    return null;
  }

  const company = await trx("companies")
    .where("uuid", companyUuid)
    .where("isActive", true)
    .whereNull("deletedAt")
    .first("id");

  return company?.id || null;
}

async function resolveDivisionId(trx, divisionUuid, companyId) {
  if (!divisionUuid) {
    return null;
  }

  const division = await trx("divisions")
    .where("uuid", divisionUuid)
    .where("companyId", companyId)
    .where("isActive", true)
    .whereNull("deletedAt")
    .first("id");

  return division?.id || null;
}

async function insertRequestDetails(trx, requestId, details, now) {
  const rows = details.map((detail) => ({
    uuid: randomUUID(),
    requestId,
    equipmentCategoryId: detail.equipmentCategoryId,
    equipmentUnitId: detail.equipmentUnitId,
    quantity: 1,
    rate: detail.rate,
    remarks: detail.remarks,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  }));

  await trx("equipmentRequestDetails").insert(rows);
}

async function synchronizeRequestDetails(trx, requestId, details, now) {
  const existingDetails = await trx("equipmentRequestDetails")
    .where("requestId", requestId)
    .whereNull("deletedAt")
    .select(["id", "uuid"]);

  const existingByUuid = new Map(
    existingDetails.map((detail) => [detail.uuid, detail]),
  );

  const retainedUuids = [];
  const newRows = [];

  for (const detail of details) {
    if (detail.uuid && existingByUuid.has(detail.uuid)) {
      retainedUuids.push(detail.uuid);

      await trx("equipmentRequestDetails")
        .where("id", existingByUuid.get(detail.uuid).id)
        .update({
          equipmentCategoryId: detail.equipmentCategoryId,
          equipmentUnitId: detail.equipmentUnitId,
          quantity: 1,
          rate: detail.rate,
          remarks: detail.remarks,
          isActive: true,
          updatedAt: now,
        });
    } else {
      newRows.push({
        uuid: randomUUID(),
        requestId,
        equipmentCategoryId: detail.equipmentCategoryId,
        equipmentUnitId: detail.equipmentUnitId,
        quantity: 1,
        rate: detail.rate,
        remarks: detail.remarks,
        isActive: true,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
    }
  }

  const removedDetails = existingDetails.filter(
    (detail) => !retainedUuids.includes(detail.uuid),
  );

  if (removedDetails.length > 0) {
    const removedDetailIds = removedDetails.map((detail) => detail.id);

    const existingAssignment = await trx("equipmentAssignments")
      .whereIn("requestDetailId", removedDetailIds)
      .whereNull("deletedAt")
      .first("id");

    if (existingAssignment) {
      throw new Error(
        "Detail tidak dapat dihapus karena sudah memiliki equipment assignment.",
      );
    }

    await trx("equipmentRequestDetails")
      .whereIn("id", removedDetailIds)
      .update({
        isActive: false,
        updatedAt: now,
        deletedAt: now,
      });
  }

  if (newRows.length > 0) {
    await trx("equipmentRequestDetails").insert(newRows);
  }
}

async function generateRequestApprovals(trx, equipmentRequest) {
  const existingApproval = await trx("equipmentRequestApprovals")
    .where("requestId", equipmentRequest.id)
    .whereNull("deletedAt")
    .first("id");

  if (existingApproval) {
    return { valid: true };
  }

  const flows = await trx("equipmentApprovalFlows as flow")
    .select([
      "flow.approvalLevel",
      "flow.companyId",
      "flow.roleId",
      "flow.actorStage",
    ])
    .where((builder) => {
      builder
        .whereNull("flow.requestCompanyId")
        .orWhere("flow.requestCompanyId", equipmentRequest.companyId);
    })
    .where("flow.isActive", 1)
    .whereNull("flow.deletedAt")
    .orderBy([
      { column: "flow.approvalLevel", order: "asc" },
      { column: "flow.id", order: "asc" },
    ]);

  if (flows.length === 0) {
    return {
      valid: false,
      message:
        "Approval flow belum dikonfigurasi untuk company equipment request ini.",
    };
  }

  const now = db.fn.now();

  await trx("equipmentRequestApprovals").insert(
    flows.map((flow) => ({
      uuid: randomUUID(),
      requestId: equipmentRequest.id,
      approvalLevel: flow.approvalLevel,
      companyId: flow.companyId,
      roleId: flow.roleId,
      userId: null,
      status: "PENDING",
      remarks: null,
      actionDate: null,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    })),
  );

  return { valid: true };
}

async function processPendingApproval(
  trx,
  { equipmentRequest, transition, access, remarks },
) {
  const actionCode = transition.actionCode;
  const isApprovalAction =
    actionCode.includes("APPROVE") || actionCode.includes("REJECT");

  if (!isApprovalAction) {
    return { valid: true };
  }

  if (!access.company?.id) {
    return {
      valid: false,
      message: "Company access user tidak ditemukan.",
    };
  }

  const userRoleIds = await trx("userRoles")
    .where("userId", access.user.id)
    .where("isActive", true)
    .whereNull("deletedAt")
    .pluck("roleId");

  if (userRoleIds.length === 0) {
    return {
      valid: false,
      message: "User tidak memiliki role approval aktif.",
    };
  }

  const pendingApproval = await trx("equipmentRequestApprovals")
    .where("requestId", equipmentRequest.id)
    .where("approvalLevel", equipmentRequest.currentApprovalLevel)
    .where("companyId", access.company.id)
    .whereIn("roleId", userRoleIds)
    .where("status", "PENDING")
    .where("isActive", true)
    .whereNull("deletedAt")
    .orderBy("id", "asc")
    .first();

  if (!pendingApproval) {
    return {
      valid: false,
      message:
        "Approval pending yang sesuai dengan company, role, dan level user tidak ditemukan.",
    };
  }

  const now = db.fn.now();

  await trx("equipmentRequestApprovals")
    .where("id", pendingApproval.id)
    .update({
      userId: access.user.id,
      status: actionCode.includes("REJECT") ? "REJECTED" : "APPROVED",
      remarks,
      actionDate: now,
      updatedAt: now,
    });

  return { valid: true };
}

async function findNextPendingApprovalLevel(trx, requestId) {
  const pendingApproval = await trx("equipmentRequestApprovals")
    .where("requestId", requestId)
    .where("status", "PENDING")
    .where("isActive", true)
    .whereNull("deletedAt")
    .orderBy("approvalLevel", "asc")
    .first("approvalLevel");

  return pendingApproval ? Number(pendingApproval.approvalLevel) : null;
}

async function insertRequestHistory(
  trx,
  { requestId, activity, description, userId, createdAt },
) {
  await trx("equipmentRequestHistories").insert({
    uuid: randomUUID(),
    requestId,
    activity,
    description,
    userId,
    createdAt,
  });
}

async function generateRequestNo(trx) {
  const date = new Date();
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const datePart = `${year}${month}${day}`;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const randomPart = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
    const requestNo = `REQ-${datePart}-${randomPart}`;

    const duplicate = await trx("equipmentRequests")
      .where("requestNo", requestNo)
      .first("id");

    if (!duplicate) {
      return requestNo;
    }
  }

  throw new Error("Failed to generate a unique equipment request number.");
}

function applyRequestScope(query, access, alias = "request") {
  if (isHolderAccess(access)) {
    return query;
  }

  if (!access.company?.id) {
    query.whereRaw("1 = 0");

    return query;
  }

  query.andWhere(`${alias}.companyId`, access.company.id);

  return query;
}

function isHolderAccess(access) {
  return Number(access.company?.type) === HOLDER_COMPANY_TYPE;
}

async function getRequestAccess(req, trx = db) {
  const requestData = req.getData() || {};
  const rawAccess = requestData.access || {};
  const rawUser = rawAccess.user || requestData.user || {};
  const userId = Number(
    rawUser.id ||
      rawUser.userId ||
      rawAccess.userId ||
      requestData.userId ||
      requestData.id,
  );

  if (!userId) {
    throw new Error("Authenticated user access was not found.");
  }

  const existingCompany = rawAccess.company || requestData.company || {};
  const existingCompanyId = Number(
    existingCompany.id ||
      existingCompany.companyId ||
      rawAccess.companyId ||
      requestData.companyId,
  );
  const existingCompanyType =
    existingCompany.type === null || existingCompany.type === undefined
      ? null
      : Number(existingCompany.type);

  if (existingCompanyId && existingCompanyType !== null) {
    return {
      ...rawAccess,
      user: {
        ...rawUser,
        id: userId,
      },
      company: {
        ...existingCompany,
        id: existingCompanyId,
        type: existingCompanyType,
      },
      permissionCodes: normalizePermissionCodes(rawAccess),
    };
  }

  const userCompany = await trx("users as user")
    .leftJoin("companies as company", function () {
      this.on("company.id", "=", "user.companyId").andOnNull(
        "company.deletedAt",
      );
    })
    .select([
      "user.id as userId",
      "user.companyId",
      "company.uuid as companyUuid",
      "company.code as companyCode",
      "company.name as companyName",
      "company.type as companyType",
    ])
    .where("user.id", userId)
    .whereNull("user.deletedAt")
    .first();

  if (!userCompany) {
    throw new Error("Authenticated user was not found.");
  }

  return {
    ...rawAccess,
    user: {
      ...rawUser,
      id: userId,
    },
    company: userCompany.companyId
      ? {
          ...existingCompany,
          id: Number(userCompany.companyId),
          uuid: userCompany.companyUuid,
          code: userCompany.companyCode,
          name: userCompany.companyName,
          type:
            userCompany.companyType === null ||
            userCompany.companyType === undefined
              ? null
              : Number(userCompany.companyType),
        }
      : null,
    permissionCodes: normalizePermissionCodes(rawAccess),
  };
}

function normalizePermissionCodes(access = {}) {
  const source =
    access.permissionCodes || access.permissions || access.permission || [];

  if (!Array.isArray(source)) {
    return [];
  }

  return source
    .map((permission) => {
      if (typeof permission === "string") {
        return permission;
      }

      return permission?.code || permission?.permissionCode || null;
    })
    .filter(Boolean);
}

function getInsertedId(insertResult) {
  if (Array.isArray(insertResult)) {
    return Number(insertResult[0]);
  }

  return Number(insertResult);
}

function normalizeRequestResult(request) {
  if (!request) {
    return request;
  }

  return {
    ...request,
    currentApprovalLevel: Number(request.currentApprovalLevel),
    approvalLocked: Boolean(request.approvalLocked),
    isActive: Boolean(request.isActive),
    statusAllowEdit: Boolean(request.statusAllowEdit),
    statusIsTerminal: Boolean(request.statusIsTerminal),
    statusSortOrder:
      request.statusSortOrder === null || request.statusSortOrder === undefined
        ? null
        : Number(request.statusSortOrder),
  };
}

function normalizePositiveInteger(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const normalizedValue = Number(value);

  if (!Number.isInteger(normalizedValue) || normalizedValue <= 0) {
    return null;
  }

  return normalizedValue;
}

function normalizeNullableDecimal(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const normalizedValue = Number(value);

  if (!Number.isFinite(normalizedValue)) {
    return null;
  }

  return normalizedValue;
}

function normalizeRequiredString(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function normalizeNullableString(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const normalizedValue = String(value).trim();

  return normalizedValue || null;
}

function normalizeDate(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const normalizedValue = String(value).trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedValue)) {
    return null;
  }

  const date = new Date(`${normalizedValue}T00:00:00Z`);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  if (date.toISOString().slice(0, 10) !== normalizedValue) {
    return null;
  }

  return normalizedValue;
}

function parseBooleanQuery(value) {
  const normalizedValue = String(value).trim().toLowerCase();

  if (["true", "1", "yes", "y"].includes(normalizedValue)) {
    return true;
  }

  if (["false", "0", "no", "n"].includes(normalizedValue)) {
    return false;
  }

  throw new Error("Query isActive harus berupa true atau false.");
}

async function findAssignments(requestId, trx = db) {
  return trx("equipmentAssignments as assignment")
    .join(
      "equipmentRequestDetails as detail",
      "detail.id",
      "assignment.requestDetailId",
    )
    .join(
      "equipmentUnits as equipmentUnit",
      "equipmentUnit.id",
      "assignment.equipmentUnitId",
    )
    .leftJoin(
      "users as assignedUser",
      "assignedUser.id",
      "assignment.assignedBy",
    )
    .leftJoin(
      "users as releasedUser",
      "releasedUser.id",
      "assignment.releasedBy",
    )
    .select([
      "assignment.id",
      "assignment.uuid",
      "assignment.requestId",
      "assignment.requestDetailId",
      "detail.uuid as requestDetailUuid",
      "assignment.equipmentUnitId",
      "equipmentUnit.uuid as equipmentUnitUuid",
      "assignment.statusCode",
      "assignment.plannedStartDate",
      "assignment.plannedEndDate",
      "assignment.actualStartDate",
      "assignment.actualEndDate",
      "assignment.assignedBy",
      "assignedUser.uuid as assignedByUuid",
      "assignedUser.fullName as assignedByName",
      "assignment.assignedAt",
      "assignment.releasedBy",
      "releasedUser.uuid as releasedByUuid",
      "releasedUser.fullName as releasedByName",
      "assignment.releasedAt",
      "assignment.notes",
      "assignment.isActive",
      "assignment.createdAt",
      "assignment.updatedAt",
    ])
    .where("assignment.requestId", requestId)
    .whereNull("assignment.deletedAt")
    .orderBy([
      { column: "assignment.requestDetailId", order: "asc" },
      { column: "assignment.id", order: "asc" },
    ]);
}

async function findAssignmentByUuid(uuid, trx = db) {
  return trx("equipmentAssignments as assignment")
    .join(
      "equipmentRequestDetails as detail",
      "detail.id",
      "assignment.requestDetailId",
    )
    .join(
      "equipmentUnits as equipmentUnit",
      "equipmentUnit.id",
      "assignment.equipmentUnitId",
    )
    .leftJoin(
      "users as assignedUser",
      "assignedUser.id",
      "assignment.assignedBy",
    )
    .leftJoin(
      "users as releasedUser",
      "releasedUser.id",
      "assignment.releasedBy",
    )
    .select([
      "assignment.id",
      "assignment.uuid",
      "assignment.requestId",
      "assignment.requestDetailId",
      "detail.uuid as requestDetailUuid",
      "assignment.equipmentUnitId",
      "equipmentUnit.uuid as equipmentUnitUuid",
      "assignment.statusCode",
      "assignment.plannedStartDate",
      "assignment.plannedEndDate",
      "assignment.actualStartDate",
      "assignment.actualEndDate",
      "assignment.assignedBy",
      "assignedUser.uuid as assignedByUuid",
      "assignedUser.fullName as assignedByName",
      "assignment.assignedAt",
      "assignment.releasedBy",
      "releasedUser.uuid as releasedByUuid",
      "releasedUser.fullName as releasedByName",
      "assignment.releasedAt",
      "assignment.notes",
      "assignment.isActive",
      "assignment.createdAt",
      "assignment.updatedAt",
    ])
    .where("assignment.uuid", uuid)
    .whereNull("assignment.deletedAt")
    .first();
}

function normalizeAssignmentPayload(payload = {}) {
  return {
    requestDetailUuid: normalizeRequiredString(payload.requestDetailUuid),
    equipmentUnitUuid: normalizeRequiredString(payload.equipmentUnitUuid),
    plannedStartDate: normalizeDate(payload.plannedStartDate),
    plannedEndDate: normalizeDate(payload.plannedEndDate),
    notes: normalizeNullableString(payload.notes),
  };
}

function validateAssignmentPayload(payload) {
  if (!payload.requestDetailUuid) {
    return { valid: false, message: "Request detail wajib dipilih." };
  }

  if (!payload.equipmentUnitUuid) {
    return { valid: false, message: "Equipment unit wajib dipilih." };
  }

  if (!payload.plannedStartDate) {
    return { valid: false, message: "Planned start date wajib diisi." };
  }

  if (!payload.plannedEndDate) {
    return { valid: false, message: "Planned end date wajib diisi." };
  }

  if (payload.plannedEndDate < payload.plannedStartDate) {
    return {
      valid: false,
      message:
        "Planned end date tidak boleh lebih kecil dari planned start date.",
    };
  }

  return { valid: true };
}

async function validateEquipmentSchedule(trx, payload) {
  const overlap = await trx("equipmentAssignments")
    .where("equipmentUnitId", payload.equipmentUnitId)
    .where("isActive", true)
    .whereNull("deletedAt")
    .whereNotIn("statusCode", ["COMPLETED", "CANCELLED"])
    .where("plannedStartDate", "<=", payload.plannedEndDate)
    .where("plannedEndDate", ">=", payload.plannedStartDate)
    .first("id");

  if (overlap) {
    return {
      valid: false,
      message:
        "Equipment unit sudah memiliki assignment aktif pada periode tersebut.",
    };
  }

  return { valid: true };
}

async function synchronizeRequestAssignmentStatus(trx, requestId) {
  const details = await trx("equipmentRequestDetails")
    .where("requestId", requestId)
    .where("isActive", true)
    .whereNull("deletedAt")
    .select(["id"]);

  if (details.length === 0) {
    return;
  }

  for (const detail of details) {
    const assignment = await trx("equipmentAssignments")
      .where("requestDetailId", detail.id)
      .where("isActive", true)
      .whereNull("deletedAt")
      .whereNotIn("statusCode", ["CANCELLED"])
      .first("id");

    if (!assignment) {
      return;
    }
  }

  await updateRequestStatusIfAvailable(trx, requestId, "ASSIGNED");
}

async function synchronizeRequestOperationalStatus(trx, requestId) {
  const assignments = await trx("equipmentAssignments")
    .where("requestId", requestId)
    .where("isActive", true)
    .whereNull("deletedAt")
    .whereNot("statusCode", "CANCELLED")
    .select(["statusCode"]);

  if (assignments.length === 0) {
    return;
  }

  const completedCount = assignments.filter(
    (assignment) => assignment.statusCode === "COMPLETED",
  ).length;

  const hasInOperation = assignments.some(
    (assignment) => assignment.statusCode === "IN_OPERATION",
  );

  if (completedCount === assignments.length) {
    await updateRequestStatusIfAvailable(trx, requestId, "COMPLETED");

    return;
  }

  if (completedCount > 0) {
    await updateRequestStatusIfAvailable(trx, requestId, "PARTIALLY_COMPLETED");

    return;
  }

  if (hasInOperation) {
    await updateRequestStatusIfAvailable(trx, requestId, "IN_PROGRESS");

    return;
  }

  await updateRequestStatusIfAvailable(trx, requestId, "ASSIGNED");
}

async function updateRequestStatusIfAvailable(trx, requestId, statusCode) {
  const status = await trx("equipmentRequestStatuses")
    .where("code", statusCode)
    .where("isActive", true)
    .whereNull("deletedAt")
    .first("code");

  if (!status) {
    return;
  }

  await trx("equipmentRequests")
    .where("id", requestId)
    .whereNull("deletedAt")
    .update({
      status: statusCode,
      updatedAt: db.fn.now(),
    });
}

const MONITORING_ASSIGNMENT_STATUS_CODES = [
  "ASSIGNED",
  "IN_OPERATION",
  "COMPLETED",
];

const MONITORING_TIME_ZONE = (
  process.env.APP_TIMEZONE || "Asia/Jakarta"
).replace(/^["']|["']$/g, "");

function normalizeDateOnly(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: MONITORING_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : null;
}

function getTodayDate() {
  return normalizeDateOnly(new Date());
}

function calculateRemainingDays(plannedEndDate, actualEndDate = null) {
  if (!plannedEndDate) {
    return null;
  }

  const comparisonDate = actualEndDate
    ? normalizeDateOnly(actualEndDate)
    : getTodayDate();

  if (!comparisonDate) {
    return null;
  }

  const plannedEnd = new Date(`${plannedEndDate}T00:00:00Z`);
  const currentDate = new Date(`${comparisonDate}T00:00:00Z`);

  return Math.ceil(
    (plannedEnd.getTime() - currentDate.getTime()) / (24 * 60 * 60 * 1000),
  );
}

function calculateAssignmentMonitoring(assignment) {
  const today = getTodayDate();
  const plannedStartDate = normalizeDateOnly(assignment.plannedStartDate);
  const plannedEndDate = normalizeDateOnly(assignment.plannedEndDate);
  const actualStartDate = normalizeDateOnly(assignment.actualStartDate);
  const actualEndDate = normalizeDateOnly(assignment.actualEndDate);

  let operationStatus = "ASSIGNED";
  let slaStatus = "ASSIGNED";

  if (actualEndDate) {
    operationStatus = "COMPLETED";
    slaStatus =
      plannedEndDate && actualEndDate <= plannedEndDate
        ? "COMPLETED_ON_TIME"
        : "COMPLETED_LATE";
  } else if (actualStartDate) {
    operationStatus = "RUNNING";

    if (plannedEndDate && today > plannedEndDate) {
      slaStatus = "OVERDUE";
    } else if (plannedStartDate && actualStartDate > plannedStartDate) {
      slaStatus = "LATE_START";
    } else {
      slaStatus = "ON_TIME_START";
    }
  } else if (plannedEndDate && today > plannedEndDate) {
    operationStatus = "ASSIGNED";
    slaStatus = "OVERDUE";
  }

  return {
    operationStatus,
    slaStatus,
    remainingDays: calculateRemainingDays(
      plannedEndDate,
      assignment.actualEndDate,
    ),
    isOverdue: slaStatus === "OVERDUE",
    isLateStart: slaStatus === "LATE_START",
    isCompletedToday: actualEndDate === today,
  };
}

function normalizeMonitoringFilters(query = {}) {
  const startDate = query.startDate ? normalizeDate(query.startDate) : null;
  const endDate = query.endDate ? normalizeDate(query.endDate) : null;

  if (query.startDate && !startDate) {
    return {
      valid: false,
      message: "Query startDate tidak valid.",
    };
  }

  if (query.endDate && !endDate) {
    return {
      valid: false,
      message: "Query endDate tidak valid.",
    };
  }

  if (startDate && endDate && endDate < startDate) {
    return {
      valid: false,
      message: "Query endDate tidak boleh lebih kecil dari startDate.",
    };
  }

  let overdueOnly = false;

  if (
    query.overdueOnly !== null &&
    query.overdueOnly !== undefined &&
    query.overdueOnly !== ""
  ) {
    try {
      overdueOnly = parseBooleanQuery(query.overdueOnly);
    } catch (error) {
      return {
        valid: false,
        message: error.message,
      };
    }
  }

  return {
    valid: true,
    search: normalizeNullableString(query.search),
    companyUuid: normalizeNullableString(query.companyUuid),
    divisionUuid: normalizeNullableString(query.divisionUuid),
    equipmentUuid: normalizeNullableString(query.equipmentUuid),
    status: normalizeNullableString(query.status)?.toUpperCase() || null,
    startDate,
    endDate,
    overdueOnly,
  };
}
function applyMonitoringFilters(query, filters, aliases = {}) {
  const assignmentAlias = aliases.assignment || "assignment";
  const companyAlias = aliases.company || "company";
  const divisionAlias = aliases.division || "division";
  const equipmentAlias = aliases.equipment || "equipmentUnit";

  if (filters.companyUuid) {
    query.andWhere(`${companyAlias}.uuid`, filters.companyUuid);
  }

  if (filters.divisionUuid) {
    query.andWhere(`${divisionAlias}.uuid`, filters.divisionUuid);
  }

  if (filters.equipmentUuid) {
    query.andWhere(`${equipmentAlias}.uuid`, filters.equipmentUuid);
  }

  if (filters.startDate) {
    query.andWhere(
      `${assignmentAlias}.plannedEndDate`,
      ">=",
      filters.startDate,
    );
  }

  if (filters.endDate) {
    query.andWhere(
      `${assignmentAlias}.plannedStartDate`,
      "<=",
      filters.endDate,
    );
  }
}

function buildMonitoringAssignmentQuery(trx = db) {
  return trx("equipmentAssignments as assignment")
    .join("equipmentRequests as request", "request.id", "assignment.requestId")
    .join(
      "equipmentRequestDetails as detail",
      "detail.id",
      "assignment.requestDetailId",
    )
    .join(
      "equipmentUnits as equipmentUnit",
      "equipmentUnit.id",
      "assignment.equipmentUnitId",
    )
    .leftJoin("equipmentCategories as category", function () {
      this.on("category.id", "=", "detail.equipmentCategoryId").andOnNull(
        "category.deletedAt",
      );
    })
    .leftJoin("companies as company", function () {
      this.on("company.id", "=", "request.companyId").andOnNull(
        "company.deletedAt",
      );
    })
    .leftJoin("divisions as division", function () {
      this.on("division.id", "=", "request.divisionId").andOnNull(
        "division.deletedAt",
      );
    })
    .whereNull("assignment.deletedAt")
    .whereNull("request.deletedAt")
    .where("assignment.isActive", true)
    .whereIn("assignment.statusCode", MONITORING_ASSIGNMENT_STATUS_CODES);
}

router.get(
  "/overview",
  authorization("EQUIPMENT_MONITORING.VIEW"),
  async (req, res) => {
    try {
      const access = await getRequestAccess(req);
      const filters = normalizeMonitoringFilters(req.query);

      if (!filters.valid) {
        return res.incomplete(filters.message);
      }

      const query = buildMonitoringAssignmentQuery().select([
        "assignment.id",
        "assignment.uuid",
        "assignment.statusCode",
        "assignment.plannedStartDate",
        "assignment.plannedEndDate",
        "assignment.actualStartDate",
        "assignment.actualEndDate",
        "assignment.assignedAt",
        "assignment.notes",
        "assignment.isActive",
        "assignment.createdAt",
        "assignment.updatedAt",

        "request.uuid as requestUuid",
        "request.requestNo",
        "request.status as requestStatus",
        "request.requestDate",
        "request.startDate as requestStartDate",
        "request.endDate as requestEndDate",

        "company.uuid as companyUuid",
        "company.code as companyCode",
        "company.name as companyName",

        "division.uuid as divisionUuid",
        "division.code as divisionCode",
        "division.name as divisionName",

        "detail.uuid as requestDetailUuid",

        "category.uuid as equipmentCategoryUuid",
        "category.code as equipmentCategoryCode",
        "category.name as equipmentCategoryName",
        "category.icon as equipmentCategoryIcon",

        "equipmentUnit.uuid as equipmentUnitUuid",
        "equipmentUnit.unitCode as equipmentUnitCode",
        "equipmentUnit.unitName as equipmentUnitName",
        "equipmentUnit.assetNumber as assetNumber",
      ]);

      applyRequestScope(query, access, "request");

      applyMonitoringFilters(query, filters, {
        assignment: "assignment",
        company: "company",
        division: "division",
        equipment: "equipmentUnit",
      });

      if (filters.status === "ACTIVE") {
        query.andWhere((builder) => {
          builder
            .whereIn("assignment.statusCode", ["ASSIGNED", "IN_OPERATION"])
            .orWhere((completedBuilder) => {
              completedBuilder
                .where("assignment.statusCode", "COMPLETED")
                .whereRaw("DATE(assignment.actualEndDate) = CURRENT_DATE");
            });
        });
      }

      if (filters.search) {
        const search = `%${filters.search}%`;

        query.andWhere((builder) => {
          builder
            .where("equipmentUnit.unitCode", "like", search)
            .orWhere("equipmentUnit.unitName", "like", search)
            .orWhere("equipmentUnit.assetNumber", "like", search)
            .orWhere("request.requestNo", "like", search)
            .orWhere("company.code", "like", search)
            .orWhere("company.name", "like", search)
            .orWhere("division.code", "like", search)
            .orWhere("division.name", "like", search)
            .orWhere("category.code", "like", search)
            .orWhere("category.name", "like", search);
        });
      }

      const availableUnitQuery = db("equipmentUnits as equipmentUnit")
        .where("equipmentUnit.isActive", true)
        .whereNull("equipmentUnit.deletedAt")
        .whereNotExists(function () {
          this.select(db.raw("1"))
            .from("equipmentAssignments as activeAssignment")
            .whereRaw("activeAssignment.equipmentUnitId = equipmentUnit.id")
            .where("activeAssignment.isActive", true)
            .whereNull("activeAssignment.deletedAt")
            .whereNot("activeAssignment.statusCode", "CANCELLED")
            .andWhere((builder) => {
              builder.whereNull("activeAssignment.actualEndDate").orWhereRaw(
                `
                  GREATEST(
                    activeAssignment.plannedEndDate,
                    activeAssignment.actualEndDate
                  ) >= NOW()
                  `,
              );
            });
        })
        .count({ total: "equipmentUnit.id" })
        .first();

      const [assignmentRows, availableUnitResult] = await Promise.all([
        query.orderBy([
          {
            column: "assignment.plannedStartDate",
            order: "asc",
          },
          {
            column: "request.requestNo",
            order: "asc",
          },
          {
            column: "assignment.id",
            order: "asc",
          },
        ]),
        availableUnitQuery,
      ]);

      let assignments = assignmentRows.map((assignment) => {
        const monitoring = calculateAssignmentMonitoring(assignment);

        return {
          ...assignment,
          isActive: Boolean(assignment.isActive),
          operationStatus: monitoring.operationStatus,
          slaStatus: monitoring.slaStatus,
          remainingDays: monitoring.remainingDays,
          isOverdue: monitoring.isOverdue,
          isLateStart: monitoring.isLateStart,
          isCompletedToday: monitoring.isCompletedToday,
        };
      });

      if (filters.status && !["ACTIVE", "ALL"].includes(filters.status)) {
        assignments = assignments.filter((assignment) => {
          return (
            assignment.statusCode === filters.status ||
            assignment.requestStatus === filters.status ||
            assignment.operationStatus === filters.status ||
            assignment.slaStatus === filters.status
          );
        });
      }

      if (filters.overdueOnly) {
        assignments = assignments.filter((assignment) => assignment.isOverdue);
      }

      const summary = {
        activeOperation: 0,
        assignedWaitingStart: 0,
        overdue: 0,
        lateStart: 0,
        completedToday: 0,
        availableUnit: Number(availableUnitResult?.total || 0),
      };

      assignments.forEach((assignment) => {
        if (assignment.actualStartDate && !assignment.actualEndDate) {
          summary.activeOperation += 1;
        }

        if (!assignment.actualStartDate && !assignment.actualEndDate) {
          summary.assignedWaitingStart += 1;
        }

        if (assignment.isOverdue) {
          summary.overdue += 1;
        }

        if (assignment.isLateStart) {
          summary.lateStart += 1;
        }

        if (assignment.isCompletedToday) {
          summary.completedToday += 1;
        }
      });

      return res.success({
        summary,
        assignments,
      });
    } catch (error) {
      console.error("GET /equipment-request/monitoring/overview error:", error);

      return res.fail(
        error.message || "Failed to load equipment monitoring overview.",
      );
    }
  },
);
/**
 * GET /equipment-request/monitoring/summary
 *
 * Query:
 * - companyUuid
 * - divisionUuid
 * - startDate
 * - endDate
 */
router.get(
  "/summary",
  authorization("EQUIPMENT_MONITORING.VIEW"),
  async (req, res) => {
    try {
      const access = await getRequestAccess(req);
      const filters = normalizeMonitoringFilters(req.query);

      if (!filters.valid) {
        return res.incomplete(filters.message);
      }

      const query = buildMonitoringAssignmentQuery().select([
        "assignment.id",
        "assignment.statusCode",
        "assignment.plannedStartDate",
        "assignment.plannedEndDate",
        "assignment.actualStartDate",
        "assignment.actualEndDate",
      ]);

      applyRequestScope(query, access, "request");
      applyMonitoringFilters(query, filters, {
        assignment: "assignment",
        company: "company",
        division: "division",
        equipment: "equipmentUnit",
      });

      const assignments = await query;

      const summary = {
        activeOperation: 0,
        assignedWaitingStart: 0,
        overdue: 0,
        lateStart: 0,
        completedToday: 0,
        availableUnit: 0,
      };

      assignments.forEach((assignment) => {
        const monitoring = calculateAssignmentMonitoring(assignment);

        if (assignment.actualStartDate && !assignment.actualEndDate) {
          summary.activeOperation += 1;
        }

        if (!assignment.actualStartDate && !assignment.actualEndDate) {
          summary.assignedWaitingStart += 1;
        }

        if (monitoring.isOverdue) {
          summary.overdue += 1;
        }

        if (monitoring.isLateStart) {
          summary.lateStart += 1;
        }

        if (monitoring.isCompletedToday) {
          summary.completedToday += 1;
        }
      });

      const availableUnitQuery = db("equipmentUnits as equipmentUnit")
        .where("equipmentUnit.isActive", true)
        .whereNull("equipmentUnit.deletedAt")
        .whereNotExists(function () {
          this.select(db.raw("1"))
            .from("equipmentAssignments as activeAssignment")
            .whereRaw("activeAssignment.equipmentUnitId = equipmentUnit.id")
            .where("activeAssignment.isActive", true)
            .whereNull("activeAssignment.deletedAt")
            .whereNot("activeAssignment.statusCode", "CANCELLED")
            .andWhere((builder) => {
              builder.whereNull("activeAssignment.actualEndDate").orWhereRaw(
                `
              GREATEST(
                activeAssignment.plannedEndDate,
                activeAssignment.actualEndDate
              ) >= NOW()
            `,
              );
            });
        })
        .count({ total: "equipmentUnit.id" })
        .first();

      const availableUnitResult = await availableUnitQuery;

      summary.availableUnit = Number(availableUnitResult?.total || 0);

      return res.success(summary);
    } catch (error) {
      console.error("GET /equipment-request/monitoring/summary error:", error);

      return res.fail(error.message || "Failed to load monitoring summary.");
    }
  },
);
/**
 * GET /equipment-request/monitoring/assignments
 *
 * Query:
 * - search
 * - companyUuid
 * - divisionUuid
 * - equipmentUuid
 * - status
 * - startDate
 * - endDate
 * - overdueOnly
 */
router.get(
  "/assignments",
  authorization("EQUIPMENT_MONITORING.VIEW"),
  async (req, res) => {
    try {
      const access = await getRequestAccess(req);
      const filters = normalizeMonitoringFilters(req.query);

      if (!filters.valid) {
        return res.incomplete(filters.message);
      }

      const query = buildMonitoringAssignmentQuery().select([
        "assignment.id",
        "assignment.uuid",
        "assignment.statusCode",
        "assignment.plannedStartDate",
        "assignment.plannedEndDate",
        "assignment.actualStartDate",
        "assignment.actualEndDate",
        "assignment.assignedAt",
        "assignment.notes",
        "assignment.isActive",
        "assignment.createdAt",
        "assignment.updatedAt",

        "request.uuid as requestUuid",
        "request.requestNo",
        "request.status as requestStatus",
        "request.requestDate",
        "request.startDate as requestStartDate",
        "request.endDate as requestEndDate",

        "company.uuid as companyUuid",
        "company.code as companyCode",
        "company.name as companyName",

        "division.uuid as divisionUuid",
        "division.code as divisionCode",
        "division.name as divisionName",

        "detail.uuid as requestDetailUuid",

        "category.uuid as equipmentCategoryUuid",
        "category.code as equipmentCategoryCode",
        "category.name as equipmentCategoryName",

        "equipmentUnit.uuid as equipmentUnitUuid",
        "equipmentUnit.unitCode as equipmentUnitCode",
        "equipmentUnit.unitName as equipmentUnitName",
        "equipmentUnit.assetNumber as assetNumber",
      ]);

      applyRequestScope(query, access, "request");

      applyMonitoringFilters(query, filters, {
        assignment: "assignment",
        company: "company",
        division: "division",
        equipment: "equipmentUnit",
      });

      if (filters.search) {
        const search = `%${filters.search}%`;

        query.andWhere((builder) => {
          builder
            .where("equipmentUnit.unitCode", "like", search)
            .orWhere("equipmentUnit.unitName", "like", search)
            .orWhere("equipmentUnit.assetNumber", "like", search)
            .orWhere("request.requestNo", "like", search)
            .orWhere("company.code", "like", search)
            .orWhere("company.name", "like", search)
            .orWhere("division.code", "like", search)
            .orWhere("division.name", "like", search)
            .orWhere("category.code", "like", search)
            .orWhere("category.name", "like", search);
        });
      }

      const assignmentRows = await query.orderBy([
        {
          column: "assignment.plannedStartDate",
          order: "asc",
        },
        {
          column: "request.requestNo",
          order: "asc",
        },
        {
          column: "assignment.id",
          order: "asc",
        },
      ]);

      let assignments = assignmentRows.map((assignment) => {
        const monitoring = calculateAssignmentMonitoring(assignment);

        return {
          ...assignment,
          isActive: Boolean(assignment.isActive),
          operationStatus: monitoring.operationStatus,
          slaStatus: monitoring.slaStatus,
          remainingDays: monitoring.remainingDays,
          isOverdue: monitoring.isOverdue,
          isLateStart: monitoring.isLateStart,
          isCompletedToday: monitoring.isCompletedToday,
        };
      });

      if (filters.status) {
        assignments = assignments.filter((assignment) => {
          return (
            assignment.statusCode === filters.status ||
            assignment.requestStatus === filters.status ||
            assignment.operationStatus === filters.status ||
            assignment.slaStatus === filters.status
          );
        });
      }

      if (filters.overdueOnly) {
        assignments = assignments.filter((assignment) => assignment.isOverdue);
      }

      return res.success(assignments);
    } catch (error) {
      console.error(
        "GET /equipment-request/monitoring/assignments error:",
        error,
      );

      return res.fail(
        error.message || "Failed to load monitoring assignments.",
      );
    }
  },
);

/**
 * GET /equipment-request/monitoring/:uuid
 */
router.get(
  "/:uuid",
  authorization("EQUIPMENT_REQUEST.VIEW"),
  async (req, res) => {
    try {
      const access = await getRequestAccess(req);

      const assignment = await findMonitoringAssignmentByUuid(
        req.params.uuid,
        access,
      );

      if (!assignment) {
        return res.incomplete(
          "Equipment assignment monitoring tidak ditemukan.",
        );
      }

      const histories = await findRequestHistories(assignment.requestId);

      const approvedHistory = histories.find(
        (history) =>
          history.activity === "APPROVE_GTSI" ||
          history.activity === "APPROVED",
      );

      const monitoring = calculateAssignmentMonitoring(assignment);

      return res.success({
        ...assignment,
        ...monitoring,
        schedule: {
          plannedStartDate: assignment.plannedStartDate,
          plannedEndDate: assignment.plannedEndDate,
          actualStartDate: assignment.actualStartDate,
          actualEndDate: assignment.actualEndDate,
          remainingDays: monitoring.remainingDays,
          slaStatus: monitoring.slaStatus,
        },
        timeline: [
          {
            code: "APPROVED",
            label: "Approved",
            completed: Boolean(approvedHistory),
            date: approvedHistory?.createdAt || null,
          },
          {
            code: "ASSIGNED",
            label: "Assigned",
            completed: Boolean(assignment.assignedAt),
            date: assignment.assignedAt || null,
          },
          {
            code: "STARTED",
            label: "Started",
            completed: Boolean(assignment.actualStartDate),
            date: assignment.actualStartDate || null,
          },
          {
            code: "COMPLETED",
            label: "Completed",
            completed: Boolean(assignment.actualEndDate),
            date: assignment.actualEndDate || null,
          },
        ],
      });
    } catch (error) {
      console.error("GET /equipment-request/monitoring/:uuid error:", error);

      return res.fail(
        error.message || "Failed to load equipment assignment monitoring.",
      );
    }
  },
);

async function findMonitoringAssignmentByUuid(uuid, access, trx = db) {
  const query = buildMonitoringAssignmentQuery(trx)
    .leftJoin("users as assignedUser", function () {
      this.on("assignedUser.id", "=", "assignment.assignedBy").andOnNull(
        "assignedUser.deletedAt",
      );
    })
    .select([
      "assignment.id",
      "assignment.uuid",
      "assignment.requestId",
      "assignment.requestDetailId",
      "assignment.statusCode",
      "assignment.plannedStartDate",
      "assignment.plannedEndDate",
      "assignment.actualStartDate",
      "assignment.actualEndDate",
      "assignment.assignedAt",
      "assignment.notes",

      "assignedUser.uuid as assignedByUuid",
      "assignedUser.fullName as assignedByName",

      "request.uuid as requestUuid",
      "request.requestNo",
      "request.status as requestStatus",
      "request.requestDate",
      "request.startDate as requestStartDate",
      "request.endDate as requestEndDate",

      "company.uuid as companyUuid",
      "company.code as companyCode",
      "company.name as companyName",

      "division.uuid as divisionUuid",
      "division.code as divisionCode",
      "division.name as divisionName",

      "detail.uuid as requestDetailUuid",

      "category.uuid as equipmentCategoryUuid",
      "category.code as equipmentCategoryCode",
      "category.name as equipmentCategoryName",

      "equipmentUnit.uuid as equipmentUnitUuid",
      "equipmentUnit.unitCode as equipmentUnitCode",
      "equipmentUnit.unitName as equipmentUnitName",
      "equipmentUnit.assetNumber as assetNumber",
    ])
    .where("assignment.uuid", uuid);

  applyRequestScope(query, access, "request");

  return query.first();
}

module.exports = router;
