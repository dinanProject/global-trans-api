"use strict";

const express = require("express");

const router = express.Router();

const authentication = require("../../lib/authentication");
const authorization = require("../../lib/authorization");
const db = require("../../lib/db")();

const HOLDER_COMPANY_TYPE = 1;

router.use(authentication);

router.get(
  "/dashboard",
  authorization("EQUIPMENT_REQUEST.VIEW"),
  async (req, res) => {
    try {
      const access = await getRequestAccess(req);

      const requestQuery = db("equipmentRequests as request")
        .where("request.isActive", true)
        .whereNull("request.deletedAt")
        .select("request.status")
        .count({ total: "request.id" })
        .groupBy("request.status");

      applyRequestScope(requestQuery, access, "request");

      const assignmentQuery = db("equipmentAssignments as assignment")
        .join(
          "equipmentRequests as request",
          "request.id",
          "assignment.requestId",
        )
        .where("assignment.isActive", true)
        .whereNull("assignment.deletedAt")
        .where("request.isActive", true)
        .whereNull("request.deletedAt")
        .select("assignment.statusCode")
        .count({ total: "assignment.id" })
        .groupBy("assignment.statusCode");

      applyRequestScope(assignmentQuery, access, "request");

      const overdueQuery = db("equipmentAssignments as assignment")
        .join(
          "equipmentRequests as request",
          "request.id",
          "assignment.requestId",
        )
        .where("assignment.isActive", true)
        .whereNull("assignment.deletedAt")
        .where("request.isActive", true)
        .whereNull("request.deletedAt")
        .whereIn("assignment.statusCode", ["ASSIGNED", "IN_OPERATION"])
        .where("assignment.plannedEndDate", "<", db.fn.now())
        .count({ total: "assignment.id" })
        .first();

      applyRequestScope(overdueQuery, access, "request");

      const unassignedQuery = db("equipmentRequestDetails as detail")
        .join(
          "equipmentRequests as request",
          "request.id",
          "detail.requestId",
        )
        .leftJoin("equipmentAssignments as assignment", function () {
          this.on("assignment.requestDetailId", "=", "detail.id").andOnVal(
            "assignment.isActive",
            "=",
            1,
          );
        })
        .where("request.isActive", true)
        .whereNull("request.deletedAt")
        .whereIn("request.status", ["GTSI_APPROVED", "ASSIGNED"])
        .groupBy("detail.id", "detail.quantity")
        .havingRaw("COUNT(assignment.id) < detail.quantity")
        .count({ total: "detail.id" });

      applyRequestScope(unassignedQuery, access, "request");

      const [requestRows, assignmentRows, overdue, unassigned] =
        await Promise.all([
          requestQuery,
          assignmentQuery,
          overdueQuery,
          unassignedQuery,
        ]);

      return res.success({
        requestsByStatus: requestRows.map((row) => ({
          statusCode: row.status,
          total: Number(row.total),
        })),
        assignmentsByStatus: assignmentRows.map((row) => ({
          statusCode: row.statusCode,
          total: Number(row.total),
        })),
        overdueAssignments: Number(overdue?.total || 0),
        detailsWaitingAssignment: unassigned.length,
      });
    } catch (error) {
      return res.fail(
        error.message || "Failed to load monitoring dashboard.",
      );
    }
  },
);

router.get(
  "/calendar",
  authorization("EQUIPMENT_REQUEST.VIEW"),
  async (req, res) => {
    try {
      const access = await getRequestAccess(req);
      const query = db("equipmentAssignments as assignment")
        .join(
          "equipmentRequests as request",
          "request.id",
          "assignment.requestId",
        )
        .join(
          "equipmentUnits as unit",
          "unit.id",
          "assignment.equipmentUnitId",
        )
        .select([
          "assignment.uuid",
          "assignment.statusCode",
          "assignment.plannedStartDate as start",
          "assignment.plannedEndDate as end",
          "request.uuid as requestUuid",
          "request.requestNo",
          "unit.uuid as equipmentUnitUuid",
        ])
        .where("assignment.isActive", true)
        .whereNull("assignment.deletedAt")
        .where("request.isActive", true)
        .whereNull("request.deletedAt");

      applyRequestScope(query, access, "request");

      if (req.query.dateFrom) {
        query.where("assignment.plannedEndDate", ">=", req.query.dateFrom);
      }

      if (req.query.dateTo) {
        query.where("assignment.plannedStartDate", "<=", req.query.dateTo);
      }

      return res.success(
        await query.orderBy("assignment.plannedStartDate", "asc"),
      );
    } catch (error) {
      return res.fail(error.message || "Failed to load monitoring calendar.");
    }
  },
);

router.get(
  "/overdue",
  authorization("EQUIPMENT_REQUEST.VIEW"),
  async (req, res) => {
    try {
      const access = await getRequestAccess(req);
      const query = db("equipmentAssignments as assignment")
        .join(
          "equipmentRequests as request",
          "request.id",
          "assignment.requestId",
        )
        .join(
          "equipmentUnits as unit",
          "unit.id",
          "assignment.equipmentUnitId",
        )
        .select([
          "assignment.*",
          "request.uuid as requestUuid",
          "request.requestNo",
          "unit.uuid as equipmentUnitUuid",
        ])
        .where("assignment.isActive", true)
        .whereNull("assignment.deletedAt")
        .where("request.isActive", true)
        .whereNull("request.deletedAt")
        .whereIn("assignment.statusCode", ["ASSIGNED", "IN_OPERATION"])
        .where("assignment.plannedEndDate", "<", db.fn.now());

      applyRequestScope(query, access, "request");

      return res.success(
        await query.orderBy("assignment.plannedEndDate", "asc"),
      );
    } catch (error) {
      return res.fail(error.message || "Failed to load overdue assignments.");
    }
  },
);

router.get(
  "/report",
  authorization("EQUIPMENT_REQUEST.REPORT"),
  async (req, res) => {
    try {
      const access = await getRequestAccess(req);
      const query = db("equipmentRequests as request")
        .leftJoin("companies as company", "company.id", "request.companyId")
        .select([
          "request.uuid",
          "request.requestNo",
          "request.requestDate",
          "request.status",
          "request.startDate",
          "request.endDate",
          "company.name as companyName",
          "request.createdAt",
        ])
        .where("request.isActive", true)
        .whereNull("request.deletedAt");

      applyRequestScope(query, access, "request");

      if (req.query.statusCode) {
        query.where(
          "request.status",
          String(req.query.statusCode).toUpperCase(),
        );
      }

      if (req.query.dateFrom) {
        query.where("request.requestDate", ">=", req.query.dateFrom);
      }

      if (req.query.dateTo) {
        query.where("request.requestDate", "<=", req.query.dateTo);
      }

      if (req.query.companyId && isHolderAccess(access)) {
        query.where("request.companyId", req.query.companyId);
      }

      return res.success(
        await query.orderBy("request.requestDate", "desc"),
      );
    } catch (error) {
      return res.fail(
        error.message || "Failed to load equipment request report.",
      );
    }
  },
);

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
  };
}

module.exports = router;
