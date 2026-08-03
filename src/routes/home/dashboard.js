"use strict";

const express = require("express");

const router = express.Router();

const authentication = require("../../lib/authentication");
const authorization = require("../../lib/authorization");
const db = require("../../lib/db")();

const HOLDER_COMPANY_TYPE = 1;

const PERIODS = {
  "30_DAYS": {
    months: 1,
    labelFormat: "day",
  },
  "6_MONTHS": {
    months: 6,
    labelFormat: "month",
  },
  "12_MONTHS": {
    months: 12,
    labelFormat: "month",
  },
};

router.use(authentication);

function normalizeNullableString(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const normalizedValue = String(value).trim();

  return normalizedValue || null;
}

function normalizePeriod(value) {
  const period = normalizeNullableString(value)?.toUpperCase() || "12_MONTHS";

  return PERIODS[period] ? period : null;
}

function isHolderAccess(access) {
  return Number(access.company?.type) === HOLDER_COMPANY_TYPE;
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

function normalizeDateOnly(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString().slice(0, 10);
}

function getTodayDate() {
  return new Date().toISOString().slice(0, 10);
}

function calculateSlaStatus(assignment) {
  const today = getTodayDate();

  const plannedStartDate = normalizeDateOnly(assignment.plannedStartDate);

  const plannedEndDate = normalizeDateOnly(assignment.plannedEndDate);

  const actualStartDate = normalizeDateOnly(assignment.actualStartDate);

  const actualEndDate = normalizeDateOnly(assignment.actualEndDate);

  if (actualEndDate) {
    return plannedEndDate && actualEndDate <= plannedEndDate
      ? "COMPLETED_ON_TIME"
      : "COMPLETED_LATE";
  }

  if (actualStartDate) {
    if (plannedEndDate && today > plannedEndDate) {
      return "OVERDUE";
    }

    return plannedStartDate && actualStartDate > plannedStartDate
      ? "LATE_START"
      : "ON_TIME_START";
  }

  if (plannedEndDate && today > plannedEndDate) {
    return "OVERDUE";
  }

  return "ASSIGNED";
}

function getPeriodRange(periodCode) {
  const today = new Date();
  const endDate = new Date(
    Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate(),
      23,
      59,
      59,
      999,
    ),
  );

  const startDate = new Date(endDate);

  if (periodCode === "30_DAYS") {
    startDate.setUTCDate(startDate.getUTCDate() - 29);
    startDate.setUTCHours(0, 0, 0, 0);
  } else {
    const months = PERIODS[periodCode].months;

    startDate.setUTCMonth(startDate.getUTCMonth() - (months - 1));
    startDate.setUTCDate(1);
    startDate.setUTCHours(0, 0, 0, 0);
  }

  return {
    startDate,
    endDate,
  };
}

function formatBucketKey(date, periodCode) {
  if (!date) {
    return null;
  }

  const normalizedDate = new Date(date);

  if (Number.isNaN(normalizedDate.getTime())) {
    return null;
  }

  if (periodCode === "30_DAYS") {
    return normalizedDate.toISOString().slice(0, 10);
  }

  return normalizedDate.toISOString().slice(0, 7);
}

function formatBucketLabel(key, periodCode) {
  if (periodCode === "30_DAYS") {
    const date = new Date(`${key}T00:00:00Z`);

    return new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "short",
      timeZone: "UTC",
    }).format(date);
  }

  const date = new Date(`${key}-01T00:00:00Z`);

  return new Intl.DateTimeFormat("en-GB", {
    month: "short",
    year: periodCode === "12_MONTHS" ? "2-digit" : undefined,
    timeZone: "UTC",
  }).format(date);
}

function buildPeriodBuckets(periodCode, range) {
  const buckets = [];

  if (periodCode === "30_DAYS") {
    const cursor = new Date(range.startDate);

    while (cursor <= range.endDate) {
      const key = cursor.toISOString().slice(0, 10);

      buckets.push({
        key,
        label: formatBucketLabel(key, periodCode),
        assigned: 0,
        started: 0,
        completed: 0,
      });

      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    return buckets;
  }

  const cursor = new Date(
    Date.UTC(
      range.startDate.getUTCFullYear(),
      range.startDate.getUTCMonth(),
      1,
    ),
  );

  const endMonth = new Date(
    Date.UTC(range.endDate.getUTCFullYear(), range.endDate.getUTCMonth(), 1),
  );

  while (cursor <= endMonth) {
    const key = cursor.toISOString().slice(0, 7);

    buckets.push({
      key,
      label: formatBucketLabel(key, periodCode),
      assigned: 0,
      started: 0,
      completed: 0,
    });

    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  return buckets;
}

function applyDashboardFilters(query, filters) {
  if (filters.companyUuid) {
    query.andWhere("company.uuid", filters.companyUuid);
  }

  if (filters.divisionUuid) {
    query.andWhere("division.uuid", filters.divisionUuid);
  }

  return query;
}

function buildAssignmentDashboardQuery(trx = db) {
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
    .where("assignment.isActive", true);
}

async function getOperationsTrend(
  access,
  filters,
  periodCode,
  range,
  trx = db,
) {
  const query = buildAssignmentDashboardQuery(trx)
    .select([
      "assignment.id",
      "assignment.assignedAt",
      "assignment.actualStartDate",
      "assignment.actualEndDate",
    ])
    .andWhere((builder) => {
      builder
        .whereBetween("assignment.assignedAt", [range.startDate, range.endDate])
        .orWhereBetween("assignment.actualStartDate", [
          range.startDate,
          range.endDate,
        ])
        .orWhereBetween("assignment.actualEndDate", [
          range.startDate,
          range.endDate,
        ]);
    });

  applyRequestScope(query, access, "request");
  applyDashboardFilters(query, filters);

  const rows = await query;
  const buckets = buildPeriodBuckets(periodCode, range);
  const bucketMap = new Map(buckets.map((bucket) => [bucket.key, bucket]));

  rows.forEach((row) => {
    const assignedKey = formatBucketKey(row.assignedAt, periodCode);

    const startedKey = formatBucketKey(row.actualStartDate, periodCode);

    const completedKey = formatBucketKey(row.actualEndDate, periodCode);

    if (assignedKey && bucketMap.has(assignedKey)) {
      bucketMap.get(assignedKey).assigned += 1;
    }

    if (startedKey && bucketMap.has(startedKey)) {
      bucketMap.get(startedKey).started += 1;
    }

    if (completedKey && bucketMap.has(completedKey)) {
      bucketMap.get(completedKey).completed += 1;
    }
  });

  return buckets.map((bucket) => ({
    label: bucket.label,
    assigned: bucket.assigned,
    started: bucket.started,
    completed: bucket.completed,
  }));
}

async function getEquipmentUtilization(access, filters, trx = db) {
  const currentAssignmentQuery = buildAssignmentDashboardQuery(trx)
    .select([
      "assignment.equipmentUnitId",
      "assignment.actualStartDate",
      "assignment.actualEndDate",
    ])
    .whereNull("assignment.actualEndDate")
    .whereIn("assignment.statusCode", ["ASSIGNED", "IN_OPERATION"]);

  applyRequestScope(currentAssignmentQuery, access, "request");
  applyDashboardFilters(currentAssignmentQuery, filters);

  const [currentAssignments, totalUnitsResult] = await Promise.all([
    currentAssignmentQuery,
    trx("equipmentUnits as equipmentUnit")
      .where("equipmentUnit.isActive", true)
      .whereNull("equipmentUnit.deletedAt")
      .count({ total: "equipmentUnit.id" })
      .first(),
  ]);

  const allocatedUnitIds = new Set();
  let waitingStart = 0;
  let inOperation = 0;

  currentAssignments.forEach((assignment) => {
    allocatedUnitIds.add(Number(assignment.equipmentUnitId));

    if (assignment.actualStartDate) {
      inOperation += 1;
    } else {
      waitingStart += 1;
    }
  });

  const totalUnits = Number(totalUnitsResult?.total || 0);
  const available = Math.max(totalUnits - allocatedUnitIds.size, 0);

  return {
    totalUnits,
    available,
    waitingStart,
    inOperation,
  };
}

async function getSlaPerformance(access, filters, range, trx = db) {
  const query = buildAssignmentDashboardQuery(trx)
    .select([
      "assignment.plannedStartDate",
      "assignment.plannedEndDate",
      "assignment.actualStartDate",
      "assignment.actualEndDate",
    ])
    .whereBetween("assignment.plannedStartDate", [
      range.startDate,
      range.endDate,
    ]);

  applyRequestScope(query, access, "request");
  applyDashboardFilters(query, filters);

  const rows = await query;

  const result = {
    onTime: 0,
    lateStart: 0,
    overdue: 0,
    completedLate: 0,
  };

  rows.forEach((assignment) => {
    const slaStatus = calculateSlaStatus(assignment);

    if (slaStatus === "ON_TIME_START" || slaStatus === "COMPLETED_ON_TIME") {
      result.onTime += 1;
    } else if (slaStatus === "LATE_START") {
      result.lateStart += 1;
    } else if (slaStatus === "OVERDUE") {
      result.overdue += 1;
    } else if (slaStatus === "COMPLETED_LATE") {
      result.completedLate += 1;
    }
  });

  return result;
}

async function getTopEquipmentCategories(access, filters, range, trx = db) {
  const query = buildAssignmentDashboardQuery(trx)
    .select(["category.uuid", "category.code", "category.name"])
    .count({ total: "assignment.id" })
    .whereBetween("assignment.assignedAt", [range.startDate, range.endDate])
    .groupBy(["category.uuid", "category.code", "category.name"])
    .orderBy("total", "desc")
    .limit(8);

  applyRequestScope(query, access, "request");
  applyDashboardFilters(query, filters);

  const rows = await query;

  return rows.map((row) => ({
    uuid: row.uuid,
    code: row.code,
    name: row.name || "Uncategorized",
    total: Number(row.total || 0),
  }));
}

async function getOperationsByCompany(access, filters, range, trx = db) {
  const query = buildAssignmentDashboardQuery(trx)
    .select(["company.uuid", "company.code", "company.name"])
    .count({ total: "assignment.id" })
    .whereBetween("assignment.assignedAt", [range.startDate, range.endDate])
    .groupBy(["company.uuid", "company.code", "company.name"])
    .orderBy("total", "desc")
    .limit(8);

  applyRequestScope(query, access, "request");
  applyDashboardFilters(query, filters);

  const rows = await query;

  return rows.map((row) => ({
    uuid: row.uuid,
    code: row.code,
    name: row.name || "Unknown Company",
    total: Number(row.total || 0),
  }));
}

/**
 * GET /equipment-request/dashboard/overview
 *
 * Query:
 * - period: 30_DAYS | 6_MONTHS | 12_MONTHS
 * - companyUuid
 * - divisionUuid
 */
router.get("/", async (req, res) => {
  try {
    const access = await getRequestAccess(req);
    const period = normalizePeriod(req.query.period);

    if (!period) {
      return res.incomplete(
        "Period harus berupa 30_DAYS, 6_MONTHS, atau 12_MONTHS.",
      );
    }

    const filters = {
      companyUuid: normalizeNullableString(req.query.companyUuid),
      divisionUuid: normalizeNullableString(req.query.divisionUuid),
    };

    const range = getPeriodRange(period);

    const [
      operationsTrend,
      equipmentUtilization,
      slaPerformance,
      topEquipmentCategories,
      operationsByCompany,
    ] = await Promise.all([
      getOperationsTrend(access, filters, period, range),
      getEquipmentUtilization(access, filters),
      getSlaPerformance(access, filters, range),
      getTopEquipmentCategories(access, filters, range),
      getOperationsByCompany(access, filters, range),
    ]);

    return res.success({
      period,
      dateRange: {
        startDate: range.startDate.toISOString().slice(0, 10),
        endDate: range.endDate.toISOString().slice(0, 10),
      },
      operationsTrend,
      equipmentUtilization,
      slaPerformance,
      topEquipmentCategories,
      operationsByCompany,
    });
  } catch (error) {
    console.error("GET /equipment-request/dashboard/overview error:", error);

    return res.fail(
      error.message || "Failed to load equipment operations dashboard.",
    );
  }
});

module.exports = router;
