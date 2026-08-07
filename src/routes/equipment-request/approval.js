"use strict";

const express = require("express");
const { randomUUID } = require("crypto");

const router = express.Router();

const authentication = require("../../lib/authentication");
const authorization = require("../../lib/authorization");
const db = require("../../lib/db")();
const {
  enqueueRequestActionNotifications,
} = require("../../services/equipment-request/email");

const HOLDER_COMPANY_TYPE = 1;

const ACTION_SUBMIT = "SUBMIT";
const ACTION_APPROVE_CLIENT = "APPROVE_CLIENT";
const ACTION_APPROVE_GTSI = "APPROVE_GTSI";
const ACTION_REJECT_CLIENT = "REJECT_CLIENT";
const ACTION_REJECT_GTSI = "REJECT_GTSI";

const APPROVAL_STATUS_PENDING = "PENDING";
const APPROVAL_STATUS_APPROVED = "APPROVED";
const APPROVAL_STATUS_REJECTED = "REJECTED";

router.use(authentication);

/**
 * GET /equipment-request/approval
 *
 * Worklist approval/review. Returns only requests that have approval-related availableActions.
 */
router.get("/", authorization("EQUIPMENT_APPROVAL.VIEW"), async (req, res) => {
  try {
    const access = await getRequestAccess(req);
    const {
      search,
      status,
      companyUuid,
      divisionUuid,
      startDate,
      endDate,
      isActive,
    } = req.query;

    const query = db("equipmentRequests as request")
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
      .whereNull("request.deletedAt");

    applyRequestScope(query, access, "request");

    if (search) {
      const normalizedSearch = `%${String(search).trim()}%`;
      query.andWhere((builder) => {
        builder
          .where("request.requestNo", "like", normalizedSearch)
          .orWhere("company.code", "like", normalizedSearch)
          .orWhere("company.name", "like", normalizedSearch)
          .orWhere("division.code", "like", normalizedSearch)
          .orWhere("division.name", "like", normalizedSearch)
          .orWhere("requester.fullName", "like", normalizedSearch)
          .orWhere("request.purpose", "like", normalizedSearch)
          .orWhere("request.notes", "like", normalizedSearch);
      });
    }

    if (status) {
      query.andWhere("request.status", String(status).trim().toUpperCase());
    }

    if (companyUuid) {
      query.andWhere("company.uuid", String(companyUuid).trim());
    }

    if (divisionUuid) {
      query.andWhere("division.uuid", String(divisionUuid).trim());
    }

    if (startDate) {
      const normalizedStartDate = normalizeDate(startDate);
      if (!normalizedStartDate)
        return res.incomplete("Query startDate tidak valid.");
      query.andWhere("request.endDate", ">=", normalizedStartDate);
    }

    if (endDate) {
      const normalizedEndDate = normalizeDate(endDate);
      if (!normalizedEndDate)
        return res.incomplete("Query endDate tidak valid.");
      query.andWhere("request.startDate", "<=", normalizedEndDate);
    }

    if (isActive !== undefined) {
      query.andWhere("request.isActive", parseBooleanQuery(isActive));
    }

    const requests = await query.orderBy([
      { column: "request.requestDate", order: "desc" },
      { column: "request.id", order: "desc" },
    ]);

    const requestIds = requests.map((request) => request.id);

    const equipmentSummaryByRequestId = new Map();

    if (requestIds.length > 0) {
      const detailSummaryQuery = db("equipmentRequestDetails")
        .select("requestId")
        .min({ previewDetailId: "id" })
        .count({ detailCount: "id" })
        .whereIn("requestId", requestIds)
        .where("isActive", true)
        .whereNull("deletedAt")
        .groupBy("requestId")
        .as("detailSummary");

      const equipmentRows = await db
        .from(detailSummaryQuery)
        .leftJoin(
          "equipmentRequestDetails as detail",
          "detail.id",
          "detailSummary.previewDetailId",
        )
        .leftJoin(
          "equipmentUnits as equipmentUnit",
          "equipmentUnit.id",
          "detail.equipmentUnitId",
        )
        .leftJoin(
          "equipmentCategories as equipmentCategory",
          "equipmentCategory.id",
          "detail.equipmentCategoryId",
        )
        .select([
          "detailSummary.requestId",
          "detailSummary.detailCount",
          "detailSummary.previewDetailId",

          "detail.equipmentUnitId",
          "equipmentUnit.uuid as equipmentUnitUuid",
          "equipmentUnit.unitCode as equipmentUnitCode",
          "equipmentUnit.unitName as equipmentUnitName",

          "equipmentCategory.code as equipmentCategoryCode",
          "equipmentCategory.name as equipmentCategoryName",
        ]);

      for (const row of equipmentRows) {
        equipmentSummaryByRequestId.set(row.requestId, {
          detailCount: Number(row.detailCount) || 0,
          details: row.previewDetailId
            ? [
                {
                  equipmentUnitId: row.equipmentUnitId,
                  equipmentUnitUuid: row.equipmentUnitUuid,
                  equipmentUnitCode: row.equipmentUnitCode,
                  equipmentUnitName: row.equipmentUnitName,
                  equipmentCategoryCode: row.equipmentCategoryCode,
                  equipmentCategoryName: row.equipmentCategoryName,
                },
              ]
            : [],
        });
      }
    }

    const approvalPermissions = new Set([
      "EQUIPMENT_APPROVAL.CLIENT_APPROVE",
      "EQUIPMENT_APPROVAL.CLIENT_REJECT",
      "EQUIPMENT_APPROVAL.GTSI_APPROVE",
      "EQUIPMENT_APPROVAL.GTSI_REJECT",
    ]);

    const actionsByStatus = await findAvailableActionsByStatuses(
      requests.map((request) => request.status),
      access,
    );

    const result = [];

    for (const request of requests) {
      const availableActions = actionsByStatus.get(request.status) ?? [];

      const approvalActions = availableActions.filter((action) =>
        approvalPermissions.has(action.permissionCode),
      );

      if (approvalActions.length === 0) {
        continue;
      }

      const equipmentSummary = equipmentSummaryByRequestId.get(request.id);

      result.push({
        ...normalizeRequestResult(request),
        details: equipmentSummary?.details ?? [],
        detailCount: equipmentSummary?.detailCount ?? 0,
        availableActions: approvalActions,
      });
    }

    return res.success(result);
  } catch (error) {
    console.error("GET /equipment-request/approval error:", error);
    return res.fail(error.message || "Failed to load approval requests.");
  }
});

router.get(
  "/:uuid/review",
  authorization("EQUIPMENT_APPROVAL.VIEW"),
  async (req, res) => {
    try {
      const access = await getRequestAccess(req);

      const equipmentRequest = await findRequestByUuid(req.params.uuid, access);

      if (!equipmentRequest) {
        return res.incomplete("Equipment request tidak ditemukan.");
      }

      const [details, availableActions] = await Promise.all([
        findRequestDetails(equipmentRequest.id),
        findAvailableActions(equipmentRequest.status, access),
      ]);

      let requestedStartDate = equipmentRequest.startDate;
      let requestedEndDate = equipmentRequest.endDate;

      if (req.query?.startDate || req.query?.endDate) {
        const reviewedSchedule = normalizeReviewSchedulePayload(req.query);

        if (!reviewedSchedule.valid) {
          return res.incomplete(reviewedSchedule.message);
        }

        requestedStartDate = reviewedSchedule.startDate;
        requestedEndDate = reviewedSchedule.endDate;
      }

      const detailsWithAvailability =
        await enrichRequestDetailsWithAvailability({
          details,
          requestId: equipmentRequest.id,
          requestedStartDate,
          requestedEndDate,
        });

      return res.success({
        ...normalizeRequestResult(equipmentRequest),
        details: detailsWithAvailability,
        availableActions,
      });
    } catch (error) {
      console.error(
        "GET /equipment-request/approval/:uuid/review error:",
        error,
      );

      return res.fail(error.message || "Failed to load approval review.");
    }
  },
);

/**
 * GET /equipment-request/approval/:uuid
 */
router.get(
  "/:uuid",
  authorization("EQUIPMENT_APPROVAL.VIEW"),
  async (req, res) => {
    try {
      const access = await getRequestAccess(req);
      const equipmentRequest = await findRequestByUuid(req.params.uuid, access);

      if (!equipmentRequest) {
        return res.incomplete("Equipment request tidak ditemukan.");
      }

      const [details, approvals, histories, availableActions] =
        await Promise.all([
          findRequestDetails(equipmentRequest.id),
          findRequestApprovals(equipmentRequest.id),
          findRequestHistories(equipmentRequest.id),
          findAvailableActions(equipmentRequest.status, access),
        ]);

      const detailsWithAvailability =
        await enrichRequestDetailsWithAvailability({
          details,
          requestId: equipmentRequest.id,
          requestedStartDate: equipmentRequest.startDate,
          requestedEndDate: equipmentRequest.endDate,
        });

      return res.success({
        ...normalizeRequestResult(equipmentRequest),
        details: detailsWithAvailability,
        approvals,
        histories,
        availableActions,
      });
    } catch (error) {
      console.error("GET /equipment-request/approval/:uuid error:", error);
      return res.fail(error.message || "Failed to load approval request.");
    }
  },
);

/**
 * POST /equipment-request/approval/:uuid/action
 */
router.post("/:uuid/action", async (req, res) =>
  executeRequestAction(req, res),
);

async function executeRequestAction(req, res, forcedActionCode = null) {
  const trx = await db.transaction();

  try {
    const access = await getRequestAccess(req);
    const actionCode = normalizeRequiredString(
      forcedActionCode || req.body?.actionCode,
    ).toUpperCase();

    if (!actionCode) {
      await trx.rollback();

      return res.incomplete("Action code wajib diisi.");
    }

    const equipmentRequest = await findRequestForUpdate(
      trx,
      req.params.uuid,
      access,
    );

    if (!equipmentRequest) {
      await trx.rollback();

      return res.incomplete("Equipment request tidak ditemukan.");
    }

    const transition = await trx(
      "equipmentRequestStatusTransitions as transition",
    )
      .join("equipmentRequestStatuses as destinationStatus", function () {
        this.on("destinationStatus.code", "=", "transition.toStatusCode")
          .andOnVal("destinationStatus.isActive", "=", 1)
          .andOnNull("destinationStatus.deletedAt");
      })
      .select([
        "transition.id",
        "transition.fromStatusCode",
        "transition.toStatusCode",
        "transition.actionCode",
        "transition.actionName",
        "transition.actorStage",
        "transition.permissionCode",
        "transition.requiresRemarks",
        "transition.lockRequest",
      ])
      .where("transition.fromStatusCode", equipmentRequest.status)
      .where("transition.actionCode", actionCode)
      .where("transition.isActive", 1)
      .whereNull("transition.deletedAt")
      .first();

    if (!transition) {
      await trx.rollback();

      return res.incomplete(
        `Transition ${actionCode} tidak tersedia dari status ${equipmentRequest.status}.`,
      );
    }

    if (
      transition.permissionCode &&
      !access.permissionCodes.includes(transition.permissionCode)
    ) {
      await trx.rollback();

      return res.unauthorized(
        "You do not have permission to perform this action.",
        { requiredPermissions: [transition.permissionCode] },
      );
    }

    const remarks = normalizeNullableString(req.body?.remarks);

    if (Boolean(transition.requiresRemarks) && !remarks) {
      await trx.rollback();

      return res.incomplete("Remarks wajib diisi untuk action ini.");
    }

    let reviewedSchedule = null;

    if ([ACTION_APPROVE_CLIENT, ACTION_APPROVE_GTSI].includes(actionCode)) {
      reviewedSchedule = normalizeReviewSchedulePayload(req.body);

      if (!reviewedSchedule.valid) {
        await trx.rollback();

        return res.incomplete(reviewedSchedule.message);
      }

      const unitLock = await lockRequestEquipmentUnits(
        trx,
        equipmentRequest.id,
      );

      if (!unitLock.valid) {
        await trx.rollback();

        return res.incomplete(unitLock.message);
      }

      const availabilityValidation = await validateFinalRequestAvailability(
        trx,
        {
          requestId: equipmentRequest.id,
          startDate: reviewedSchedule.startDate,
          endDate: reviewedSchedule.endDate,
        },
      );

      if (!availabilityValidation.valid) {
        await trx.rollback();

        return res.incomplete(availabilityValidation.message);
      }
    }

    if (actionCode === ACTION_SUBMIT) {
      const activeDetails = await trx("equipmentRequestDetails")
        .where("requestId", equipmentRequest.id)
        .where("isActive", true)
        .whereNull("deletedAt")
        .select([
          "id",
          "equipmentUnitId",
          "requiredCapacityValue",
          "requiredCapacityUnit",
        ]);

      if (activeDetails.length === 0) {
        await trx.rollback();

        return res.incomplete(
          "Equipment request harus memiliki minimal satu detail sebelum disubmit.",
        );
      }

      if (
        activeDetails.some(
          (detail) =>
            !detail.equipmentUnitId ||
            Number(detail.requiredCapacityValue) <= 0 ||
            !detail.requiredCapacityUnit,
        )
      ) {
        await trx.rollback();

        return res.incomplete(
          "Semua detail harus memiliki equipment unit dan kebutuhan kapasitas.",
        );
      }

      const approvalGeneration = await generateRequestApprovals(
        trx,
        equipmentRequest,
      );

      if (!approvalGeneration.valid) {
        await trx.rollback();

        return res.incomplete(approvalGeneration.message);
      }
    }

    const approvalResult = await processPendingApproval(trx, {
      equipmentRequest,
      transition,
      access,
      remarks,
    });

    if (!approvalResult.valid) {
      await trx.rollback();

      return res.incomplete(approvalResult.message);
    }

    const now = db.fn.now();
    const nextApprovalLevel = await findNextPendingApprovalLevel(
      trx,
      equipmentRequest.id,
    );

    const requestUpdatePayload = {
      status: transition.toStatusCode,
      currentApprovalLevel:
        nextApprovalLevel || equipmentRequest.currentApprovalLevel,
      approvalLocked: Boolean(transition.lockRequest),
      updatedAt: now,
    };

    if (reviewedSchedule) {
      requestUpdatePayload.startDate = reviewedSchedule.startDate;
      requestUpdatePayload.endDate = reviewedSchedule.endDate;
    }

    await trx("equipmentRequests")
      .where("id", equipmentRequest.id)
      .update(requestUpdatePayload);

    await insertRequestHistory(trx, {
      requestId: equipmentRequest.id,
      activity: transition.actionCode,
      description: buildActionHistoryDescription({
        transition,
        remarks,
      }),
      userId: access.user.id,
      createdAt: now,
    });

    await enqueueRequestActionNotifications(trx, {
      equipmentRequest,
      transition,
      actionUserId: access.user.id,
      remarks,
    });

    await trx.commit();

    const updatedRequest = await findRequestByUuid(req.params.uuid, access);
    const [approvals, histories, availableActions] = await Promise.all([
      findRequestApprovals(updatedRequest.id),
      findRequestHistories(updatedRequest.id),
      findAvailableActions(updatedRequest.status, access),
    ]);

    return res.success({
      ...normalizeRequestResult(updatedRequest),
      approvals,
      histories,
      availableActions,
    });
  } catch (error) {
    await trx.rollback();

    console.error("POST /equipment-request/:uuid/action error:", error);

    return res.fail(
      error.message || "Failed to process equipment request action.",
    );
  }
}

async function validateFinalRequestAvailability(
  trx,
  { requestId, startDate, endDate },
) {
  const requestDetails = await trx("equipmentRequestDetails as detail")
    .leftJoin(
      "equipmentUnits as equipmentUnit",
      "equipmentUnit.id",
      "detail.equipmentUnitId",
    )
    .where("detail.requestId", requestId)
    .where("detail.isActive", true)
    .whereNull("detail.deletedAt")
    .select([
      "detail.id",
      "detail.equipmentUnitId",
      "equipmentUnit.unitCode as unitCode",
    ]);

  if (requestDetails.length === 0) {
    return {
      valid: false,
      message: "Equipment request tidak memiliki detail aktif untuk disetujui.",
    };
  }

  if (requestDetails.some((detail) => !detail.equipmentUnitId)) {
    return {
      valid: false,
      message: "Seluruh request detail wajib memiliki equipment unit.",
    };
  }

  const equipmentUnitIds = [
    ...new Set(requestDetails.map((detail) => detail.equipmentUnitId)),
  ];

  const [reservedRequests, activeAssignments] = await Promise.all([
    trx("equipmentRequestDetails as otherDetail")
      .join(
        "equipmentRequests as otherRequest",
        "otherRequest.id",
        "otherDetail.requestId",
      )
      .whereIn("otherDetail.equipmentUnitId", equipmentUnitIds)
      .whereNot("otherRequest.id", requestId)
      .whereIn("otherRequest.status", ["APPROVED", "ASSIGNED", "IN_PROGRESS"])
      .where("otherRequest.isActive", true)
      .whereNull("otherRequest.deletedAt")
      .where("otherDetail.isActive", true)
      .whereNull("otherDetail.deletedAt")
      .where("otherRequest.startDate", "<=", endDate)
      .where("otherRequest.endDate", ">=", startDate)
      .select([
        "otherDetail.equipmentUnitId",
        "otherRequest.requestNo",
        "otherRequest.startDate",
        "otherRequest.endDate",
        "otherRequest.status",
      ])
      .orderBy("otherDetail.equipmentUnitId", "asc")
      .orderBy("otherRequest.startDate", "asc"),

    trx("equipmentAssignments as assignment")
      .leftJoin(
        "equipmentRequestDetails as assignmentDetail",
        "assignmentDetail.id",
        "assignment.requestDetailId",
      )
      .whereIn("assignment.equipmentUnitId", equipmentUnitIds)
      .whereNot("assignmentDetail.requestId", requestId)
      .where("assignment.isActive", true)
      .whereNull("assignment.deletedAt")
      .whereNotIn("assignment.statusCode", ["CANCELLED"])
      .where("assignment.plannedStartDate", "<=", endDate)
      .andWhere((builder) => {
        builder.whereNull("assignment.actualEndDate").orWhereRaw(
          `
              COALESCE(
                GREATEST(
                  assignment.plannedEndDate,
                  assignment.actualEndDate
                ),
                assignment.plannedEndDate
              ) >= ?
              `,
          [startDate],
        );
      })
      .select([
        "assignment.equipmentUnitId",
        "assignment.statusCode",
        "assignment.plannedStartDate",
        "assignment.plannedEndDate",
        "assignment.actualEndDate",
      ])
      .orderBy("assignment.equipmentUnitId", "asc")
      .orderBy("assignment.plannedStartDate", "asc"),
  ]);

  const reservedRequestByUnitId = new Map();

  for (const reservedRequest of reservedRequests) {
    if (!reservedRequestByUnitId.has(reservedRequest.equipmentUnitId)) {
      reservedRequestByUnitId.set(
        reservedRequest.equipmentUnitId,
        reservedRequest,
      );
    }
  }

  const activeAssignmentByUnitId = new Map();

  for (const activeAssignment of activeAssignments) {
    if (!activeAssignmentByUnitId.has(activeAssignment.equipmentUnitId)) {
      activeAssignmentByUnitId.set(
        activeAssignment.equipmentUnitId,
        activeAssignment,
      );
    }
  }

  for (const detail of requestDetails) {
    const reservedRequest = reservedRequestByUnitId.get(detail.equipmentUnitId);

    if (reservedRequest) {
      return {
        valid: false,
        message:
          `Equipment unit ${detail.unitCode} sudah digunakan oleh ` +
          `request ${reservedRequest.requestNo} pada periode ` +
          `${reservedRequest.startDate} sampai ` +
          `${reservedRequest.endDate}.`,
      };
    }

    const activeAssignment = activeAssignmentByUnitId.get(
      detail.equipmentUnitId,
    );

    if (activeAssignment) {
      const availableAt = getAssignmentEffectiveEndDate(activeAssignment);

      if (!activeAssignment.actualEndDate) {
        return {
          valid: false,
          message:
            `Equipment unit ${detail.unitCode} masih memiliki ` +
            "assignment yang belum diselesaikan.",
        };
      }

      return {
        valid: false,
        message:
          `Equipment unit ${detail.unitCode} belum tersedia. ` +
          `Unit baru dapat digunakan setelah ${availableAt}.`,
      };
    }
  }

  return {
    valid: true,
  };
}

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
    .leftJoin(
      "equipmentCategories as equipmentCategory",
      "equipmentCategory.id",
      "detail.equipmentCategoryId",
    )
    .leftJoin(
      "equipmentUnits as equipmentUnit",
      "equipmentUnit.id",
      "detail.equipmentUnitId",
    )
    .select([
      "detail.id",
      "detail.uuid",
      "detail.requestId",
      "detail.equipmentCategoryId",
      "equipmentCategory.code as equipmentCategoryCode",
      "equipmentCategory.name as equipmentCategoryName",
      "detail.equipmentUnitId",
      "equipmentUnit.uuid as equipmentUnitUuid",
      "equipmentUnit.unitCode as equipmentUnitCode",
      "equipmentUnit.unitName as equipmentUnitName",
      "equipmentUnit.assetNumber as equipmentUnitAssetNumber",
      "equipmentUnit.capacityValue as equipmentUnitCapacityValue",
      "equipmentUnit.capacityUnit as equipmentUnitCapacityUnit",
      "detail.requiredCapacityValue",
      "detail.requiredCapacityUnit",
      "detail.quantity",
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
    quantity: Number(detail.quantity || 1),
    requiredCapacityValue:
      detail.requiredCapacityValue === null
        ? null
        : Number(detail.requiredCapacityValue),
    equipmentUnitCapacityValue:
      detail.equipmentUnitCapacityValue === null
        ? null
        : Number(detail.equipmentUnitCapacityValue),
    rate: detail.rate === null ? null : Number(detail.rate),
    isActive: Boolean(detail.isActive),
  }));
}

async function enrichRequestDetailsWithAvailability({
  details,
  requestId,
  requestedStartDate,
  requestedEndDate,
  trx = db,
}) {
  const equipmentUnitIds = [
    ...new Set(details.map((detail) => detail.equipmentUnitId).filter(Boolean)),
  ];

  const statusMapPromise = getAvailabilityStatusMap(trx);

  if (equipmentUnitIds.length === 0) {
    const statusMap = await statusMapPromise;

    return details.map((detail) => {
      const status = "UNIT_NOT_SELECTED";

      return {
        ...detail,
        availability: {
          isAvailableForRequestedPeriod: false,
          status,
          statusName: statusMap.get(status) || status,
          lastUsageStartDate: null,
          lastUsageEndDate: null,
          availableFrom: null,
          conflictRequestNo: null,
          conflictCompanyUuid: null,
          conflictCompanyCode: null,
          conflictCompanyName: null,
          conflictRequesterUuid: null,
          conflictRequesterName: null,
          conflictStartDate: null,
          conflictEndDate: null,
        },
      };
    });
  }

  const [
    statusMap,
    lastAssignments,
    conflictingRequests,
    conflictingAssignments,
  ] = await Promise.all([
    statusMapPromise,

    trx("equipmentAssignments as assignment")
      .leftJoin(
        "equipmentRequestDetails as assignmentDetail",
        "assignmentDetail.id",
        "assignment.requestDetailId",
      )
      .whereIn("assignment.equipmentUnitId", equipmentUnitIds)
      .whereNot("assignmentDetail.requestId", requestId)
      .where("assignment.isActive", true)
      .whereNull("assignment.deletedAt")
      .whereNotIn("assignment.statusCode", ["CANCELLED"])
      .andWhereRaw(
        `
        COALESCE(
          GREATEST(
            assignment.plannedEndDate,
            assignment.actualEndDate
          ),
          assignment.plannedEndDate
        ) <= ?
      `,
        [requestedStartDate],
      )
      .select([
        "assignment.equipmentUnitId",
        "assignment.statusCode",
        "assignment.plannedStartDate",
        "assignment.plannedEndDate",
        "assignment.actualEndDate",
      ])
      .orderBy("assignment.equipmentUnitId", "asc")
      .orderByRaw(
        `
        COALESCE(
          GREATEST(
            assignment.plannedEndDate,
            assignment.actualEndDate
          ),
          assignment.plannedEndDate
        ) DESC
      `,
      ),

    trx("equipmentRequestDetails as otherDetail")
      .join(
        "equipmentRequests as otherRequest",
        "otherRequest.id",
        "otherDetail.requestId",
      )
      .leftJoin("companies as otherCompany", function () {
        this.on("otherCompany.id", "=", "otherRequest.companyId").andOnNull(
          "otherCompany.deletedAt",
        );
      })
      .leftJoin("users as otherRequester", function () {
        this.on("otherRequester.id", "=", "otherRequest.requestBy").andOnNull(
          "otherRequester.deletedAt",
        );
      })
      .whereIn("otherDetail.equipmentUnitId", equipmentUnitIds)
      .whereNot("otherRequest.id", requestId)
      .whereIn("otherRequest.status", ["APPROVED", "ASSIGNED", "IN_PROGRESS"])
      .where("otherRequest.isActive", true)
      .whereNull("otherRequest.deletedAt")
      .where("otherDetail.isActive", true)
      .whereNull("otherDetail.deletedAt")
      .where("otherRequest.startDate", "<=", requestedEndDate)
      .where("otherRequest.endDate", ">=", requestedStartDate)
      .select([
        "otherDetail.equipmentUnitId",
        "otherRequest.requestNo",
        "otherRequest.startDate",
        "otherRequest.endDate",
        "otherRequest.status",
        "otherCompany.uuid as companyUuid",
        "otherCompany.code as companyCode",
        "otherCompany.name as companyName",
        "otherRequester.uuid as requesterUuid",
        "otherRequester.fullName as requesterName",
      ])
      .orderBy("otherDetail.equipmentUnitId", "asc")
      .orderBy("otherRequest.startDate", "asc"),

    trx("equipmentAssignments as assignment")
      .leftJoin(
        "equipmentRequestDetails as assignmentDetail",
        "assignmentDetail.id",
        "assignment.requestDetailId",
      )
      .whereIn("assignment.equipmentUnitId", equipmentUnitIds)
      .whereNot("assignmentDetail.requestId", requestId)
      .where("assignment.isActive", true)
      .whereNull("assignment.deletedAt")
      .whereNotIn("assignment.statusCode", ["CANCELLED"])
      .where("assignment.plannedStartDate", "<=", requestedEndDate)
      .andWhere((builder) => {
        builder.whereNull("assignment.actualEndDate").orWhereRaw(
          `
            GREATEST(
              assignment.plannedEndDate,
              assignment.actualEndDate
            ) >= ?
          `,
          [requestedStartDate],
        );
      })
      .select([
        "assignment.equipmentUnitId",
        "assignment.statusCode",
        "assignment.plannedStartDate",
        "assignment.plannedEndDate",
        "assignment.actualEndDate",
      ])
      .orderBy("assignment.equipmentUnitId", "asc")
      .orderBy("assignment.plannedStartDate", "asc"),
  ]);

  const lastAssignmentByUnitId = new Map();

  for (const assignment of lastAssignments) {
    if (!lastAssignmentByUnitId.has(assignment.equipmentUnitId)) {
      lastAssignmentByUnitId.set(assignment.equipmentUnitId, assignment);
    }
  }

  const conflictingRequestByUnitId = new Map();

  for (const request of conflictingRequests) {
    if (!conflictingRequestByUnitId.has(request.equipmentUnitId)) {
      conflictingRequestByUnitId.set(request.equipmentUnitId, request);
    }
  }

  const conflictingAssignmentByUnitId = new Map();

  for (const assignment of conflictingAssignments) {
    if (!conflictingAssignmentByUnitId.has(assignment.equipmentUnitId)) {
      conflictingAssignmentByUnitId.set(assignment.equipmentUnitId, assignment);
    }
  }

  return details.map((detail) => {
    if (!detail.equipmentUnitId) {
      const status = "UNIT_NOT_SELECTED";

      return {
        ...detail,
        availability: {
          isAvailableForRequestedPeriod: false,
          status,
          statusName: statusMap.get(status) || status,
          lastUsageStartDate: null,
          lastUsageEndDate: null,
          availableFrom: null,
          conflictRequestNo: null,
          conflictCompanyUuid: null,
          conflictCompanyCode: null,
          conflictCompanyName: null,
          conflictRequesterUuid: null,
          conflictRequesterName: null,
          conflictStartDate: null,
          conflictEndDate: null,
        },
      };
    }

    const lastAssignment = lastAssignmentByUnitId.get(detail.equipmentUnitId);

    const conflictingRequest = conflictingRequestByUnitId.get(
      detail.equipmentUnitId,
    );

    const conflictingAssignment = conflictingAssignmentByUnitId.get(
      detail.equipmentUnitId,
    );

    const lastUsageEndDate = getAssignmentEffectiveEndDate(lastAssignment);

    let availability;

    if (conflictingRequest) {
      availability = {
        isAvailableForRequestedPeriod: false,
        status: "RESERVED",
        lastUsageStartDate: lastAssignment?.plannedStartDate || null,
        lastUsageEndDate,
        availableFrom: conflictingRequest.endDate,
        conflictRequestNo: conflictingRequest.requestNo,
        conflictCompanyUuid: conflictingRequest.companyUuid || null,
        conflictCompanyCode: conflictingRequest.companyCode || null,
        conflictCompanyName: conflictingRequest.companyName || null,
        conflictRequesterUuid: conflictingRequest.requesterUuid || null,
        conflictRequesterName: conflictingRequest.requesterName || null,
        conflictStartDate: conflictingRequest.startDate,
        conflictEndDate: conflictingRequest.endDate,
      };
    } else if (conflictingAssignment) {
      const conflictingAssignmentEndDate = getAssignmentEffectiveEndDate(
        conflictingAssignment,
      );

      availability = {
        isAvailableForRequestedPeriod: false,
        status: conflictingAssignment.actualEndDate
          ? "ASSIGNMENT_CONFLICT"
          : "ACTIVE_ASSIGNMENT",
        lastUsageStartDate: lastAssignment?.plannedStartDate || null,
        lastUsageEndDate,
        availableFrom: conflictingAssignment.actualEndDate
          ? conflictingAssignmentEndDate
          : null,
        conflictRequestNo: null,
        conflictCompanyUuid: null,
        conflictCompanyCode: null,
        conflictCompanyName: null,
        conflictRequesterUuid: null,
        conflictRequesterName: null,
        conflictStartDate: conflictingAssignment.plannedStartDate,
        conflictEndDate: conflictingAssignmentEndDate,
      };
    } else {
      availability = {
        isAvailableForRequestedPeriod: true,
        status: "AVAILABLE",
        lastUsageStartDate: lastAssignment?.plannedStartDate || null,
        lastUsageEndDate,
        availableFrom: lastUsageEndDate,
        conflictRequestNo: null,
        conflictCompanyUuid: null,
        conflictCompanyCode: null,
        conflictCompanyName: null,
        conflictRequesterUuid: null,
        conflictRequesterName: null,
        conflictStartDate: null,
        conflictEndDate: null,
      };
    }

    return {
      ...detail,
      availability: {
        ...availability,
        statusName: statusMap.get(availability.status) || availability.status,
      },
    };
  });
}

function getAssignmentEffectiveEndDate(assignment) {
  if (!assignment) {
    return null;
  }

  if (!assignment.actualEndDate) {
    return assignment.plannedEndDate || null;
  }

  const plannedEndDate = new Date(assignment.plannedEndDate);
  const actualEndDate = new Date(assignment.actualEndDate);

  if (
    Number.isNaN(plannedEndDate.getTime()) ||
    Number.isNaN(actualEndDate.getTime())
  ) {
    return assignment.actualEndDate || assignment.plannedEndDate || null;
  }

  return actualEndDate > plannedEndDate
    ? assignment.actualEndDate
    : assignment.plannedEndDate;
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

async function findAvailableActionsByStatuses(statusCodes, access, trx = db) {
  const uniqueStatusCodes = [...new Set((statusCodes ?? []).filter(Boolean))];

  if (uniqueStatusCodes.length === 0) {
    return new Map();
  }

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
    .whereIn("transition.fromStatusCode", uniqueStatusCodes)
    .where("transition.isActive", 1)
    .whereNull("transition.deletedAt")
    .orderBy([
      { column: "transition.fromStatusCode", order: "asc" },
      { column: "transition.sortOrder", order: "asc" },
    ]);

  const actionsByStatus = new Map();

  for (const transition of transitions) {
    if (
      transition.permissionCode &&
      !access.permissionCodes.includes(transition.permissionCode)
    ) {
      continue;
    }

    if (!actionsByStatus.has(transition.fromStatusCode)) {
      actionsByStatus.set(transition.fromStatusCode, []);
    }

    actionsByStatus.get(transition.fromStatusCode).push({
      ...transition,
      requiresRemarks: Boolean(transition.requiresRemarks),
      lockRequest: Boolean(transition.lockRequest),
      sortOrder: Number(transition.sortOrder),
    });
  }

  return actionsByStatus;
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

async function getAvailabilityStatusMap(trx = db) {
  const rows = await trx("sysLookups")
    .where("lookupGroup", "equipment_availability_status")
    .where("isActive", true)
    .select(["lookupCode", "lookupValue"]);

  return new Map(rows.map((row) => [row.lookupCode, row.lookupValue]));
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

function buildActionHistoryDescription({ transition, remarks }) {
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

  const equipmentUnitIds = details.map((detail) => detail.equipmentUnitId);

  if (new Set(equipmentUnitIds).size !== equipmentUnitIds.length) {
    return {
      valid: false,
      message:
        "Equipment unit yang sama tidak boleh dipilih lebih dari satu kali dalam satu request.",
    };
  }

  const units = await trx("equipmentUnits")
    .whereIn("id", equipmentUnitIds)
    .where("isActive", true)
    .whereNull("deletedAt")
    .select(["id", "categoryId"]);

  if (units.length !== equipmentUnitIds.length) {
    return {
      valid: false,
      message: "Terdapat equipment unit yang tidak valid atau tidak aktif.",
    };
  }

  const unitById = new Map(units.map((unit) => [Number(unit.id), unit]));

  for (let index = 0; index < details.length; index += 1) {
    const detail = details[index];
    const unit = unitById.get(Number(detail.equipmentUnitId));

    if (
      !unit ||
      Number(unit.categoryId) !== Number(detail.equipmentCategoryId)
    ) {
      return {
        valid: false,
        message:
          `Equipment unit pada detail baris ${index + 1} ` +
          "tidak sesuai dengan equipment category.",
      };
    }
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
      status: APPROVAL_STATUS_PENDING,
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
  const isApprovalAction = [
    ACTION_APPROVE_CLIENT,
    ACTION_APPROVE_GTSI,
    ACTION_REJECT_CLIENT,
    ACTION_REJECT_GTSI,
  ].includes(actionCode);

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
    .pluck("roleId");

  if (userRoleIds.length === 0) {
    return {
      valid: false,
      message: "User tidak memiliki role approval.",
    };
  }

  const pendingApproval = await trx("equipmentRequestApprovals")
    .where("requestId", equipmentRequest.id)
    .where("approvalLevel", equipmentRequest.currentApprovalLevel)
    .where("companyId", access.company.id)
    .whereIn("roleId", userRoleIds)
    .where("status", APPROVAL_STATUS_PENDING)
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
      status: [ACTION_REJECT_CLIENT, ACTION_REJECT_GTSI].includes(actionCode)
        ? APPROVAL_STATUS_REJECTED
        : APPROVAL_STATUS_APPROVED,
      remarks,
      actionDate: now,
      updatedAt: now,
    });

  return { valid: true };
}

async function findNextPendingApprovalLevel(trx, requestId) {
  const pendingApproval = await trx("equipmentRequestApprovals")
    .where("requestId", requestId)
    .where("status", APPROVAL_STATUS_PENDING)
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

  const match = normalizedValue.match(
    /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?$/,
  );

  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second = "00"] = match;

  const values = [
    Number(year),
    Number(month),
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ];

  const [
    yearNumber,
    monthNumber,
    dayNumber,
    hourNumber,
    minuteNumber,
    secondNumber,
  ] = values;

  if (hourNumber > 23 || minuteNumber > 59 || secondNumber > 59) {
    return null;
  }

  const date = new Date(
    Date.UTC(
      yearNumber,
      monthNumber - 1,
      dayNumber,
      hourNumber,
      minuteNumber,
      secondNumber,
    ),
  );

  if (
    date.getUTCFullYear() !== yearNumber ||
    date.getUTCMonth() + 1 !== monthNumber ||
    date.getUTCDate() !== dayNumber ||
    date.getUTCHours() !== hourNumber ||
    date.getUTCMinutes() !== minuteNumber ||
    date.getUTCSeconds() !== secondNumber
  ) {
    return null;
  }

  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
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

async function lockRequestEquipmentUnits(trx, requestId) {
  const details = await trx("equipmentRequestDetails")
    .where("requestId", requestId)
    .where("isActive", true)
    .whereNull("deletedAt")
    .select(["id", "equipmentUnitId"])
    .forUpdate();

  if (details.length === 0) {
    return {
      valid: false,
      message: "Equipment request tidak memiliki detail aktif.",
    };
  }

  if (details.some((detail) => !detail.equipmentUnitId)) {
    return {
      valid: false,
      message: "Seluruh request detail wajib memiliki equipment unit.",
    };
  }

  const equipmentUnitIds = [
    ...new Set(details.map((detail) => Number(detail.equipmentUnitId))),
  ];

  const lockedUnits = await trx("equipmentUnits")
    .whereIn("id", equipmentUnitIds)
    .where("isActive", true)
    .whereNull("deletedAt")
    .select(["id", "unitCode"])
    .forUpdate();

  if (lockedUnits.length !== equipmentUnitIds.length) {
    return {
      valid: false,
      message: "Terdapat equipment unit yang tidak ditemukan atau tidak aktif.",
    };
  }

  return {
    valid: true,
    details,
    units: lockedUnits,
  };
}

module.exports = router;
