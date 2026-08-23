'use strict';

const express = require('express');
const { randomUUID } = require('crypto');

const router = express.Router();

const {
  authenticate: authentication,
  authorize: authorization,
} = require('../../modules/access/access.middleware');
const db = require('../../lib/db')();
const { enqueueRequestActionNotifications } = require('../../services/equipment-request/email');
const {
  enqueueRequestActionMenuNotifications,
} = require('../../services/equipment-request/notification');

const HOLDER_COMPANY_TYPE = 1;
const STATUS_DRAFT = 'DRAFT';
const ACTION_SUBMIT = 'SUBMIT';
const SCHEDULE_REVIEW_ACTIONS = new Set(['APPROVE_CLIENT', 'APPROVE_GTSI']);

router.use(authentication);

/**
 * GET /equipment-request
 *
 * Query:
 * - search
 * - status
 * - companyUuid
 * - divisionUuid
 * - startDate
 * - endDate
 * - isActive
 */
router
  .get('/', authorization('EQUIPMENT_REQUEST.VIEW'), async (req, res) => {
    try {
      const access = await getRequestAccess(req);
      const { search, status, companyUuid, divisionUuid, startDate, endDate, isActive } = req.query;

      const query = db('equipmentRequests as request')
        .leftJoin('companies as company', function () {
          this.on('company.id', '=', 'request.companyId').andOnNull('company.deletedAt');
        })
        .leftJoin('divisions as division', function () {
          this.on('division.id', '=', 'request.divisionId').andOnNull('division.deletedAt');
        })
        .leftJoin('users as requester', function () {
          this.on('requester.id', '=', 'request.requestBy').andOnNull('requester.deletedAt');
        })
        .leftJoin('equipmentRequestStatuses as requestStatus', function () {
          this.on('requestStatus.code', '=', 'request.status')
            .andOnVal('requestStatus.isActive', '=', 1)
            .andOnNull('requestStatus.deletedAt');
        })
        .select([
          'request.id',
          'request.uuid',
          'request.requestNo',
          'request.companyId',
          'company.uuid as companyUuid',
          'company.code as companyCode',
          'company.name as companyName',
          'request.divisionId',
          'division.uuid as divisionUuid',
          'division.code as divisionCode',
          'division.name as divisionName',
          'request.requestBy',
          'requester.uuid as requestByUuid',
          'requester.fullName as requestByName',
          'request.requestDate',
          'request.startDate',
          'request.endDate',
          'request.purpose',
          'request.notes',
          'request.status',
          'requestStatus.name as statusName',
          'requestStatus.stage as statusStage',
          'requestStatus.sortOrder as statusSortOrder',
          'requestStatus.allowEdit as statusAllowEdit',
          'requestStatus.isTerminal as statusIsTerminal',
          'request.currentApprovalLevel',
          'request.approvalLocked',
          'request.isActive',
          'request.createdAt',
          'request.updatedAt',
        ])
        .whereNull('request.deletedAt');

      applyRequestScope(query, access, 'request');

      if (search) {
        const normalizedSearch = `%${String(search).trim()}%`;

        query.andWhere((builder) => {
          builder
            .where('request.requestNo', 'like', normalizedSearch)
            .orWhere('company.code', 'like', normalizedSearch)
            .orWhere('company.name', 'like', normalizedSearch)
            .orWhere('division.code', 'like', normalizedSearch)
            .orWhere('division.name', 'like', normalizedSearch)
            .orWhere('requester.fullName', 'like', normalizedSearch)
            .orWhere('request.purpose', 'like', normalizedSearch)
            .orWhere('request.notes', 'like', normalizedSearch);
        });
      }

      if (status) {
        query.andWhere('request.status', String(status).trim().toUpperCase());
      }

      if (companyUuid) {
        query.andWhere('company.uuid', String(companyUuid).trim());
      }

      if (divisionUuid) {
        query.andWhere('division.uuid', String(divisionUuid).trim());
      }

      if (startDate) {
        const normalizedStartDate = normalizeDate(startDate);

        if (!normalizedStartDate) {
          return res.incomplete('Query startDate harus menggunakan format YYYY-MM-DD HH:mm.');
        }

        query.andWhere('request.endDate', '>=', normalizedStartDate);
      }

      if (endDate) {
        const normalizedEndDate = normalizeDate(endDate);

        if (!normalizedEndDate) {
          return res.incomplete('Query endDate tidak valid.');
        }

        query.andWhere('request.startDate', '<=', normalizedEndDate);
      }

      if (isActive !== undefined) {
        query.andWhere('request.isActive', parseBooleanQuery(isActive));
      }

      const requests = await query.orderBy([
        { column: 'request.requestDate', order: 'desc' },
        { column: 'request.id', order: 'desc' },
      ]);

      const requestIds = requests.map((item) => item.id);

      const detailSummaryByRequestId = new Map();

      if (requestIds.length > 0) {
        const detailSummaryQuery = db('equipmentRequestDetails')
          .select('requestId')
          .min({ previewDetailId: 'id' })
          .count({ detailCount: 'id' })
          .whereIn('requestId', requestIds)
          .whereNull('deletedAt')
          .groupBy('requestId')
          .as('detailSummary');

        const detailSummaries = await db
          .from(detailSummaryQuery)
          .leftJoin('equipmentRequestDetails as erd', 'erd.id', 'detailSummary.previewDetailId')
          .leftJoin('equipmentCategories as ec', 'ec.id', 'erd.equipmentCategoryId')
          .leftJoin('equipmentUnits as eu', 'eu.id', 'erd.equipmentUnitId')
          .select([
            'detailSummary.requestId',
            'detailSummary.detailCount',
            'detailSummary.previewDetailId',
            'erd.uuid',

            'erd.equipmentCategoryId',
            'ec.code as equipmentCategoryCode',
            'ec.name as equipmentCategoryName',
            'ec.icon as equipmentCategoryIcon',

            'erd.equipmentUnitId',
            'eu.uuid as equipmentUnitUuid',
            'eu.unitCode as equipmentUnitCode',
            'eu.unitName as equipmentUnitName',

            'erd.requiredCapacityValue',
            'erd.requiredCapacityUnit',
          ]);

        for (const detail of detailSummaries) {
          detailSummaryByRequestId.set(detail.requestId, {
            detailCount: Number(detail.detailCount) || 0,
            details: detail.previewDetailId
              ? [
                  {
                    uuid: detail.uuid,

                    equipmentCategoryId: detail.equipmentCategoryId,
                    equipmentCategoryCode: detail.equipmentCategoryCode,
                    equipmentCategoryName: detail.equipmentCategoryName,
                    equipmentCategoryIcon: detail.equipmentCategoryIcon,

                    equipmentUnitId: detail.equipmentUnitId,
                    equipmentUnitUuid: detail.equipmentUnitUuid,
                    equipmentUnitCode: detail.equipmentUnitCode,
                    equipmentUnitName: detail.equipmentUnitName,

                    requiredCapacityValue:
                      detail.requiredCapacityValue === null ||
                      detail.requiredCapacityValue === undefined
                        ? null
                        : Number(detail.requiredCapacityValue),
                    requiredCapacityUnit: detail.requiredCapacityUnit,
                  },
                ]
              : [],
          });
        }
      }

      const actionsByStatus = await findAvailableActionsByStatuses(
        requests.map((request) => request.status),
        access
      );

      const requestsWithActions = requests.map((request) => {
        const detailSummary = detailSummaryByRequestId.get(request.id);

        return {
          ...normalizeRequestResult(request),
          details: detailSummary?.details ?? [],
          detailCount: detailSummary?.detailCount ?? 0,
          availableActions: actionsByStatus.get(request.status) ?? [],
        };
      });
      return res.success(requestsWithActions);
    } catch (error) {
      console.error('GET /equipment-request error:', error);

      return res.fail(error.message || 'Failed to load equipment requests.');
    }
  })

  .get('/request-statuses', async (req, res) => {
    try {
      const statuses = await db('equipmentRequestStatuses')
        .select(
          'id',
          'uuid',
          'code',
          'name',
          'description',
          'stage',
          'sortOrder',
          'allowEdit',
          'isTerminal',
          'isActive'
        )
        .where('isActive', 1)
        .orderBy('sortOrder', 'asc');

      return res.success(statuses);
    } catch (error) {
      return res.err(500, error.message || 'Failed to retrieve request statuses');
    }
  })
  /**
   * GET /equipment-request/:uuid
   */
  .get('/:uuid', authorization('EQUIPMENT_REQUEST.VIEW'), async (req, res) => {
    try {
      const access = await getRequestAccess(req);
      const equipmentRequest = await findRequestByUuid(req.params.uuid, access);

      if (!equipmentRequest) {
        return res.incomplete('Equipment request tidak ditemukan.');
      }

      const [details, approvals, histories, availableActions] = await Promise.all([
        findRequestDetails(equipmentRequest.id),
        findRequestApprovals(equipmentRequest.id),
        findRequestHistories(equipmentRequest.id),
        findAvailableActions(equipmentRequest.status, access),
      ]);

      return res.success({
        ...normalizeRequestResult(equipmentRequest),
        details,
        approvals,
        histories,
        availableActions,
      });
    } catch (error) {
      console.error('GET /equipment-request/:uuid error:', error);

      return res.fail(error.message || 'Failed to load equipment request.');
    }
  })

  /**
   * POST /equipment-request
   */
  .post('/', authorization('EQUIPMENT_REQUEST.CREATE'), async (req, res) => {
    const trx = await db.transaction();

    try {
      const access = await getRequestAccess(req);
      const payload = normalizePayload(req.body);
      const validation = validatePayload(payload);

      if (!validation.valid) {
        await trx.rollback();

        return res.incomplete(validation.message);
      }

      const companyId = await resolveCompanyId(trx, payload.companyUuid, access);

      if (!companyId) {
        await trx.rollback();

        return res.incomplete('Company tidak valid atau tidak aktif.');
      }

      const divisionId = await resolveDivisionId(trx, payload.divisionUuid, companyId);

      if (payload.divisionUuid && !divisionId) {
        await trx.rollback();

        return res.incomplete(
          'Division tidak valid, tidak aktif, atau bukan milik company tersebut.'
        );
      }

      const detailValidation = await validateDetails(
        trx,
        payload.details,
        null,
        payload.startDate,
        payload.endDate
      );

      if (!detailValidation.valid) {
        await trx.rollback();

        return res.incomplete(detailValidation.message);
      }

      const draftStatus = await trx('equipmentRequestStatuses')
        .where('code', STATUS_DRAFT)
        .where('isActive', 1)
        .whereNull('deletedAt')
        .first(['code', 'allowEdit']);

      if (!draftStatus) {
        await trx.rollback();

        return res.incomplete(`Status ${STATUS_DRAFT} belum tersedia atau tidak aktif.`);
      }

      const now = db.fn.now();
      const uuid = randomUUID();
      const requestNo = await generateRequestNo(trx);

      const insertResult = await trx('equipmentRequests').insert({
        uuid,
        requestNo,
        companyId,
        divisionId,
        requestBy: access.user.id,
        requestDate: new Date(),
        startDate: payload.startDate,
        endDate: payload.endDate,
        purpose: payload.purpose,
        notes: payload.notes,
        status: STATUS_DRAFT,
        currentApprovalLevel: 1,
        approvalLocked: false,
        isActive: true,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });

      const requestId = getInsertedId(insertResult);

      await insertRequestDetails(trx, requestId, payload.details, now);

      await insertRequestHistory(trx, {
        requestId,
        activity: 'CREATE',
        description: `Equipment request ${requestNo} dibuat sebagai draft.`,
        userId: access.user.id,
        createdAt: now,
      });

      await trx.commit();

      const equipmentRequest = await findRequestByUuid(uuid, access);
      const details = await findRequestDetails(equipmentRequest.id);

      return res.success({
        ...normalizeRequestResult(equipmentRequest),
        details,
      });
    } catch (error) {
      await trx.rollback();

      console.error('POST /equipment-request error:', error);

      return res.fail(error.message || 'Failed to create equipment request.');
    }
  })

  /**
   * PUT /equipment-request/:uuid
   */
  .put('/:uuid', authorization('EQUIPMENT_REQUEST.UPDATE'), async (req, res) => {
    const trx = await db.transaction();

    try {
      const access = await getRequestAccess(req);
      const existingRequest = await findRequestForUpdate(trx, req.params.uuid, access);

      if (!existingRequest) {
        await trx.rollback();

        return res.incomplete('Equipment request tidak ditemukan.');
      }

      if (Boolean(existingRequest.approvalLocked)) {
        await trx.rollback();

        return res.incomplete('Equipment request sudah dikunci dan tidak dapat diubah.');
      }

      if (!Boolean(existingRequest.statusAllowEdit)) {
        await trx.rollback();

        return res.incomplete(
          `Equipment request dengan status ${existingRequest.status} tidak dapat diubah.`
        );
      }

      const payload = normalizePayload(req.body);
      const validation = validatePayload(payload);

      if (!validation.valid) {
        await trx.rollback();

        return res.incomplete(validation.message);
      }

      const companyId = await resolveCompanyId(
        trx,
        payload.companyUuid,
        access,
        existingRequest.companyId
      );

      if (!companyId) {
        await trx.rollback();

        return res.incomplete('Company tidak valid atau tidak aktif.');
      }

      const divisionId = await resolveDivisionId(trx, payload.divisionUuid, companyId);

      if (payload.divisionUuid && !divisionId) {
        await trx.rollback();

        return res.incomplete(
          'Division tidak valid, tidak aktif, atau bukan milik company tersebut.'
        );
      }

      const detailValidation = await validateDetails(
        trx,
        payload.details,
        existingRequest.id,
        payload.startDate,
        payload.endDate
      );

      if (!detailValidation.valid) {
        await trx.rollback();

        return res.incomplete(detailValidation.message);
      }

      const now = db.fn.now();

      await trx('equipmentRequests').where('id', existingRequest.id).update({
        companyId,
        divisionId,
        startDate: payload.startDate,
        endDate: payload.endDate,
        purpose: payload.purpose,
        notes: payload.notes,
        updatedAt: now,
      });

      await synchronizeRequestDetails(trx, existingRequest.id, payload.details, now);

      await insertRequestHistory(trx, {
        requestId: existingRequest.id,
        activity: 'UPDATE',
        description: `Equipment request ${existingRequest.requestNo} diperbarui.`,
        userId: access.user.id,
        createdAt: now,
      });

      await trx.commit();

      const equipmentRequest = await findRequestByUuid(req.params.uuid, access);
      const details = await findRequestDetails(equipmentRequest.id);

      return res.success({
        ...normalizeRequestResult(equipmentRequest),
        details,
      });
    } catch (error) {
      await trx.rollback();

      console.error('PUT /equipment-request/:uuid error:', error);

      return res.fail(error.message || 'Failed to update equipment request.');
    }
  })

  /**
   * DELETE /equipment-request/:uuid
   *
   * Soft delete. Only DRAFT requests may be deleted.
   */
  .delete('/:uuid', authorization('EQUIPMENT_REQUEST.DELETE'), async (req, res) => {
    const trx = await db.transaction();

    try {
      const access = await getRequestAccess(req);
      const equipmentRequest = await findRequestForUpdate(trx, req.params.uuid, access);

      if (!equipmentRequest) {
        await trx.rollback();

        return res.incomplete('Equipment request tidak ditemukan.');
      }

      if (Boolean(equipmentRequest.approvalLocked)) {
        await trx.rollback();

        return res.incomplete('Equipment request sudah dikunci dan tidak dapat dihapus.');
      }

      if (equipmentRequest.status !== STATUS_DRAFT) {
        await trx.rollback();

        return res.incomplete('Hanya equipment request berstatus DRAFT yang dapat dihapus.');
      }

      const now = db.fn.now();

      await trx('equipmentRequestDetails')
        .where('requestId', equipmentRequest.id)
        .whereNull('deletedAt')
        .update({
          isActive: false,
          updatedAt: now,
          deletedAt: now,
        });

      await trx('equipmentRequests').where('id', equipmentRequest.id).update({
        isActive: false,
        updatedAt: now,
        deletedAt: now,
      });

      await insertRequestHistory(trx, {
        requestId: equipmentRequest.id,
        activity: 'DELETE',
        description: `Equipment request ${equipmentRequest.requestNo} dihapus.`,
        userId: access.user.id,
        createdAt: now,
      });

      await trx.commit();

      return res.success({
        uuid: equipmentRequest.uuid,
      });
    } catch (error) {
      await trx.rollback();

      console.error('DELETE /equipment-request/:uuid error:', error);

      return res.fail(error.message || 'Failed to delete equipment request.');
    }
  })

  /**
   * POST /equipment-request/:uuid/action
   *
   * Body:
   * - actionCode
   * - remarks
   */
  .post('/:uuid/action', async (req, res) => {
    return executeRequestAction(req, res, req.body?.actionCode);
  })

  /**
   * POST /equipment-request/:uuid/submit
   *
   * Backward-compatible alias for actionCode SUBMIT.
   */
  .post('/:uuid/submit', authorization('EQUIPMENT_REQUEST.SUBMIT'), async (req, res) => {
    return executeRequestAction(req, res, ACTION_SUBMIT);
  });

async function executeRequestAction(req, res, forcedActionCode = null) {
  const trx = await db.transaction();

  try {
    const access = await getRequestAccess(req);
    const actionCode = normalizeRequiredString(
      forcedActionCode || req.body?.actionCode
    ).toUpperCase();

    if (!actionCode) {
      await trx.rollback();

      return res.incomplete('Action code wajib diisi.');
    }

    const equipmentRequest = await findRequestForUpdate(trx, req.params.uuid, access);

    if (!equipmentRequest) {
      await trx.rollback();

      return res.incomplete('Equipment request tidak ditemukan.');
    }

    const transition = await trx('equipmentRequestStatusTransitions as transition')
      .join('equipmentRequestStatuses as destinationStatus', function () {
        this.on('destinationStatus.code', '=', 'transition.toStatusCode')
          .andOnVal('destinationStatus.isActive', '=', 1)
          .andOnNull('destinationStatus.deletedAt');
      })
      .select([
        'transition.id',
        'transition.fromStatusCode',
        'transition.toStatusCode',
        'transition.actionCode',
        'transition.actionName',
        'transition.actorStage',
        'transition.permissionCode',
        'transition.requiresRemarks',
        'transition.lockRequest',
      ])
      .where('transition.fromStatusCode', equipmentRequest.status)
      .where('transition.actionCode', actionCode)
      .where('transition.isActive', 1)
      .whereNull('transition.deletedAt')
      .first();

    if (!transition) {
      await trx.rollback();

      return res.incomplete(
        `Transition ${actionCode} tidak tersedia dari status ${equipmentRequest.status}.`
      );
    }

    if (transition.permissionCode && !access.permissionCodes.includes(transition.permissionCode)) {
      await trx.rollback();

      return res.unauthorized('You do not have permission to perform this action.', {
        requiredPermissions: [transition.permissionCode],
      });
    }

    const remarks = normalizeNullableString(req.body?.remarks);

    if (Boolean(transition.requiresRemarks) && !remarks) {
      await trx.rollback();

      return res.incomplete('Remarks wajib diisi untuk action ini.');
    }

    if (actionCode === ACTION_SUBMIT) {
      const activeDetails = await trx('equipmentRequestDetails')
        .where('requestId', equipmentRequest.id)
        .where('isActive', true)
        .whereNull('deletedAt')
        .select(['id', 'equipmentUnitId', 'requiredCapacityValue', 'requiredCapacityUnit']);

      if (activeDetails.length === 0) {
        await trx.rollback();

        return res.incomplete(
          'Equipment request harus memiliki minimal satu detail sebelum disubmit.'
        );
      }

      if (
        activeDetails.some(
          (detail) =>
            !detail.equipmentUnitId ||
            Number(detail.requiredCapacityValue) <= 0 ||
            !detail.requiredCapacityUnit
        )
      ) {
        await trx.rollback();

        return res.incomplete(
          'Semua detail harus memiliki equipment unit dan kebutuhan kapasitas.'
        );
      }

      const approvalGeneration = await generateRequestApprovals(trx, equipmentRequest);

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

    const shouldUpdateSchedule = SCHEDULE_REVIEW_ACTIONS.has(actionCode);

    const reviewSchedule = shouldUpdateSchedule
      ? normalizeReviewSchedulePayload(req.body)
      : {
          valid: true,
          startDate: equipmentRequest.startDate,
          endDate: equipmentRequest.endDate,
        };

    if (shouldUpdateSchedule && !reviewSchedule.valid) {
      await trx.rollback();

      return res.incomplete(reviewSchedule.message);
    }

    const now = db.fn.now();
    const nextApprovalLevel = await findNextPendingApprovalLevel(trx, equipmentRequest.id);

    const requestUpdatePayload = {
      status: transition.toStatusCode,
      currentApprovalLevel: nextApprovalLevel || equipmentRequest.currentApprovalLevel,
      approvalLocked: Boolean(transition.lockRequest),
      updatedAt: now,
    };

    if (shouldUpdateSchedule) {
      requestUpdatePayload.startDate = reviewSchedule.startDate;
      requestUpdatePayload.endDate = reviewSchedule.endDate;
    }

    await trx('equipmentRequests').where('id', equipmentRequest.id).update(requestUpdatePayload);

    await insertRequestHistory(trx, {
      requestId: equipmentRequest.id,
      activity: transition.actionCode,
      description: buildActionHistoryDescription({
        transition,
        remarks,
        reviewSchedule,
        scheduleUpdated: shouldUpdateSchedule,
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

    await enqueueRequestActionMenuNotifications(trx, {
      equipmentRequest,
      transition,
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

    console.error('POST /equipment-request/:uuid/action error:', error);

    return res.fail(error.message || 'Failed to process equipment request action.');
  }
}

async function findRequestByUuid(uuid, access, trx = db) {
  const query = trx('equipmentRequests as request')
    .leftJoin('companies as company', function () {
      this.on('company.id', '=', 'request.companyId').andOnNull('company.deletedAt');
    })
    .leftJoin('divisions as division', function () {
      this.on('division.id', '=', 'request.divisionId').andOnNull('division.deletedAt');
    })
    .leftJoin('users as requester', function () {
      this.on('requester.id', '=', 'request.requestBy').andOnNull('requester.deletedAt');
    })
    .leftJoin('equipmentRequestStatuses as requestStatus', function () {
      this.on('requestStatus.code', '=', 'request.status')
        .andOnVal('requestStatus.isActive', '=', 1)
        .andOnNull('requestStatus.deletedAt');
    })
    .select([
      'request.id',
      'request.uuid',
      'request.requestNo',
      'request.companyId',
      'company.uuid as companyUuid',
      'company.code as companyCode',
      'company.name as companyName',
      'request.divisionId',
      'division.uuid as divisionUuid',
      'division.code as divisionCode',
      'division.name as divisionName',
      'request.requestBy',
      'requester.uuid as requestByUuid',
      'requester.fullName as requestByName',
      'request.requestDate',
      'request.startDate',
      'request.endDate',
      'request.purpose',
      'request.notes',
      'request.status',
      'requestStatus.name as statusName',
      'requestStatus.stage as statusStage',
      'requestStatus.sortOrder as statusSortOrder',
      'requestStatus.allowEdit as statusAllowEdit',
      'requestStatus.isTerminal as statusIsTerminal',
      'request.currentApprovalLevel',
      'request.approvalLocked',
      'request.isActive',
      'request.createdAt',
      'request.updatedAt',
    ])
    .where('request.uuid', uuid)
    .whereNull('request.deletedAt');

  applyRequestScope(query, access, 'request');

  return query.first();
}

async function findRequestForUpdate(trx, uuid, access) {
  const query = trx('equipmentRequests as request')
    .leftJoin('equipmentRequestStatuses as requestStatus', function () {
      this.on('requestStatus.code', '=', 'request.status')
        .andOnVal('requestStatus.isActive', '=', 1)
        .andOnNull('requestStatus.deletedAt');
    })
    .select([
      'request.*',
      'requestStatus.allowEdit as statusAllowEdit',
      'requestStatus.isTerminal as statusIsTerminal',
    ])
    .where('request.uuid', uuid)
    .whereNull('request.deletedAt')
    .forUpdate();

  applyRequestScope(query, access, 'request');

  return query.first();
}

async function findRequestDetails(requestId, trx = db) {
  const details = await trx('equipmentRequestDetails as detail')
    .leftJoin('equipmentCategories as category', function () {
      this.on('category.id', '=', 'detail.equipmentCategoryId').andOnNull('category.deletedAt');
    })
    .leftJoin('equipmentUnits as equipmentUnit', function () {
      this.on('equipmentUnit.id', '=', 'detail.equipmentUnitId').andOnNull(
        'equipmentUnit.deletedAt'
      );
    })
    .select([
      'detail.id',
      'detail.uuid',
      'detail.requestId',
      'detail.equipmentCategoryId',
      'category.uuid as equipmentCategoryUuid',
      'category.code as equipmentCategoryCode',
      'category.name as equipmentCategoryName',
      'category.icon as equipmentCategoryIcon',
      'detail.equipmentUnitId',
      'detail.requiredCapacityValue',
      'detail.requiredCapacityUnit',
      'equipmentUnit.uuid as equipmentUnitUuid',
      'equipmentUnit.unitCode as equipmentUnitCode',
      'equipmentUnit.unitName as equipmentUnitName',
      'equipmentUnit.assetNumber as equipmentUnitAssetNumber',
      'equipmentUnit.modelNumber as equipmentUnitModelNumber',
      'equipmentUnit.plateNumber as equipmentUnitPlateNumber',
      'equipmentUnit.capacityValue as equipmentUnitCapacityValue',
      'equipmentUnit.capacityUnit as equipmentUnitCapacityUnit',
      'detail.rate',
      'detail.remarks',
      'detail.isActive',
      'detail.createdAt',
      'detail.updatedAt',
    ])
    .where('detail.requestId', requestId)
    .whereNull('detail.deletedAt')
    .orderBy('detail.id', 'asc');

  return details.map((detail) => ({
    ...detail,
    requiredCapacityValue:
      detail.requiredCapacityValue === null ? null : Number(detail.requiredCapacityValue),
    equipmentUnitCapacityValue:
      detail.equipmentUnitCapacityValue === null ? null : Number(detail.equipmentUnitCapacityValue),
    rate: detail.rate === null ? null : Number(detail.rate),
    isActive: Boolean(detail.isActive),
  }));
}

async function findRequestApprovals(requestId, trx = db) {
  const approvals = await trx('equipmentRequestApprovals as approval')
    .leftJoin('companies as company', function () {
      this.on('company.id', '=', 'approval.companyId').andOnNull('company.deletedAt');
    })
    .leftJoin('roles as role', 'role.id', 'approval.roleId')
    .leftJoin('users as approvalUser', function () {
      this.on('approvalUser.id', '=', 'approval.userId').andOnNull('approvalUser.deletedAt');
    })
    .select([
      'approval.id',
      'approval.uuid',
      'approval.requestId',
      'approval.approvalLevel',
      'approval.companyId',
      'company.uuid as companyUuid',
      'company.code as companyCode',
      'company.name as companyName',
      'approval.roleId',
      'role.uuid as roleUuid',
      'role.code as roleCode',
      'role.name as roleName',
      'approval.userId',
      'approvalUser.uuid as userUuid',
      'approvalUser.fullName as userName',
      'approval.status',
      'approval.remarks',
      'approval.actionDate',
      'approval.isActive',
      'approval.createdAt',
      'approval.updatedAt',
    ])
    .where('approval.requestId', requestId)
    .whereNull('approval.deletedAt')
    .orderBy([
      { column: 'approval.approvalLevel', order: 'asc' },
      { column: 'approval.id', order: 'asc' },
    ]);

  return approvals.map((approval) => ({
    ...approval,
    approvalLevel: Number(approval.approvalLevel),
    isActive: Boolean(approval.isActive),
  }));
}

async function findRequestHistories(requestId, trx = db) {
  return trx('equipmentRequestHistories as history')
    .leftJoin('users as historyUser', function () {
      this.on('historyUser.id', '=', 'history.userId').andOnNull('historyUser.deletedAt');
    })
    .select([
      'history.id',
      'history.uuid',
      'history.requestId',
      'history.activity',
      'history.description',
      'history.userId',
      'historyUser.uuid as userUuid',
      'historyUser.fullName as userName',
      'history.createdAt',
    ])
    .where('history.requestId', requestId)
    .orderBy([
      { column: 'history.createdAt', order: 'desc' },
      { column: 'history.id', order: 'desc' },
    ]);
}

async function findAvailableActionsByStatuses(statusCodes, access, trx = db) {
  const uniqueStatusCodes = [...new Set((statusCodes ?? []).filter(Boolean))];

  if (uniqueStatusCodes.length === 0) {
    return new Map();
  }

  const transitions = await trx('equipmentRequestStatusTransitions as transition')
    .join('equipmentRequestStatuses as destinationStatus', function () {
      this.on('destinationStatus.code', '=', 'transition.toStatusCode')
        .andOnVal('destinationStatus.isActive', '=', 1)
        .andOnNull('destinationStatus.deletedAt');
    })
    .select([
      'transition.uuid',
      'transition.fromStatusCode',
      'transition.toStatusCode',
      'destinationStatus.name as toStatusName',
      'transition.actionCode',
      'transition.actionName',
      'transition.actorStage',
      'transition.permissionCode',
      'transition.requiresRemarks',
      'transition.lockRequest',
      'transition.confirmationTitle',
      'transition.confirmationMessage',
      'transition.sortOrder',
    ])
    .whereIn('transition.fromStatusCode', uniqueStatusCodes)
    .where('transition.isActive', 1)
    .whereNull('transition.deletedAt')
    .orderBy([
      { column: 'transition.fromStatusCode', order: 'asc' },
      { column: 'transition.sortOrder', order: 'asc' },
    ]);

  const actionsByStatus = new Map();

  for (const transition of transitions) {
    if (transition.permissionCode && !access.permissionCodes.includes(transition.permissionCode)) {
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
  const transitions = await trx('equipmentRequestStatusTransitions as transition')
    .join('equipmentRequestStatuses as destinationStatus', function () {
      this.on('destinationStatus.code', '=', 'transition.toStatusCode')
        .andOnVal('destinationStatus.isActive', '=', 1)
        .andOnNull('destinationStatus.deletedAt');
    })
    .select([
      'transition.uuid',
      'transition.fromStatusCode',
      'transition.toStatusCode',
      'destinationStatus.name as toStatusName',
      'transition.actionCode',
      'transition.actionName',
      'transition.actorStage',
      'transition.permissionCode',
      'transition.requiresRemarks',
      'transition.lockRequest',
      'transition.confirmationTitle',
      'transition.confirmationMessage',
      'transition.sortOrder',
    ])
    .where('transition.fromStatusCode', statusCode)
    .where('transition.isActive', 1)
    .whereNull('transition.deletedAt')
    .orderBy('transition.sortOrder', 'asc');

  return transitions
    .filter(
      (transition) =>
        !transition.permissionCode || access.permissionCodes.includes(transition.permissionCode)
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
      message: 'Start date review wajib diisi dengan format YYYY-MM-DD HH:mm.',
    };
  }

  if (!endDate) {
    return {
      valid: false,
      message: 'End date review wajib diisi dengan format YYYY-MM-DD HH:mm.',
    };
  }

  if (startDate >= endDate) {
    return {
      valid: false,
      message: 'End date review harus lebih besar dari start date review.',
    };
  }

  return {
    valid: true,
    startDate,
    endDate,
  };
}

function buildActionHistoryDescription({ transition, remarks, reviewSchedule, scheduleUpdated }) {
  if (scheduleUpdated && reviewSchedule?.valid) {
    const scheduleText =
      `Jadwal direview menjadi ${reviewSchedule.startDate} ` + `sampai ${reviewSchedule.endDate}.`;

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
      equipmentCategoryId: normalizePositiveInteger(detail?.equipmentCategoryId),
      equipmentUnitId: normalizePositiveInteger(detail?.equipmentUnitId),
      requiredCapacityValue: normalizePositiveDecimal(detail?.requiredCapacityValue),
      requiredCapacityUnit: normalizeRequiredString(detail?.requiredCapacityUnit).toUpperCase(),
      quantity: 1,
      rate: normalizeNullableDecimal(detail?.rate),
      remarks: normalizeNullableString(detail?.remarks),
    })),
  };
}

function validatePayload(payload) {
  if (!payload.startDate) {
    return {
      valid: false,
      message: 'Start date dan waktu wajib diisi dengan format YYYY-MM-DD HH:mm.',
    };
  }

  if (!payload.endDate) {
    return {
      valid: false,
      message: 'End date dan waktu wajib diisi dengan format YYYY-MM-DD HH:mm.',
    };
  }

  if (payload.startDate >= payload.endDate) {
    return {
      valid: false,
      message: 'End date dan waktu harus lebih besar dari start date dan waktu.',
    };
  }

  if (payload.purpose && payload.purpose.length > 65535) {
    return {
      valid: false,
      message: 'Purpose terlalu panjang.',
    };
  }

  if (payload.notes && payload.notes.length > 65535) {
    return {
      valid: false,
      message: 'Notes terlalu panjang.',
    };
  }

  if (!Array.isArray(payload.details) || payload.details.length === 0) {
    return {
      valid: false,
      message: 'Equipment request harus memiliki minimal satu detail.',
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

    if (!detail.requiredCapacityValue) {
      return {
        valid: false,
        message: `Required capacity value pada detail baris ${rowNumber} ` + 'wajib lebih dari 0.',
      };
    }

    if (!detail.requiredCapacityUnit) {
      return {
        valid: false,
        message: `Required capacity unit pada detail baris ${rowNumber} wajib diisi.`,
      };
    }

    if (detail.requiredCapacityUnit.length > 50) {
      return {
        valid: false,
        message: `Required capacity unit pada detail baris ${rowNumber} ` + 'maksimal 50 karakter.',
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

async function validateEquipmentUnitAvailability(
  trx,
  { equipmentUnitId, requestId = null, startDate, endDate }
) {
  const query = trx('equipmentAssignments as assignment')
    .leftJoin(
      'equipmentRequestDetails as requestDetail',
      'requestDetail.id',
      'assignment.requestDetailId'
    )
    .where('assignment.equipmentUnitId', equipmentUnitId)
    .where('assignment.isActive', true)
    .whereNull('assignment.deletedAt')
    .whereNull('requestDetail.deletedAt')
    .whereNotIn('assignment.statusCode', ['CANCELLED'])
    .where('assignment.plannedStartDate', '<=', endDate)
    .andWhere((builder) => {
      builder.whereNull('assignment.actualEndDate').orWhereRaw(
        `
            GREATEST(
              assignment.plannedEndDate,
              assignment.actualEndDate
            ) >= ?
          `,
        [startDate]
      );
    });

  if (requestId) {
    query.andWhere('requestDetail.requestId', '!=', requestId);
  }

  const overlap = await query.first([
    'assignment.id',
    'assignment.uuid',
    'assignment.statusCode',
    'assignment.plannedStartDate',
    'assignment.plannedEndDate',
    'assignment.actualEndDate',
  ]);

  if (!overlap) {
    return {
      valid: true,
    };
  }

  if (!overlap.actualEndDate) {
    return {
      valid: false,
      message: 'Unit masih memiliki assignment aktif yang belum diselesaikan.',
    };
  }

  const plannedEndDate = new Date(overlap.plannedEndDate);
  const actualEndDate = new Date(overlap.actualEndDate);

  const availableAt =
    actualEndDate > plannedEndDate ? overlap.actualEndDate : overlap.plannedEndDate;

  return {
    valid: false,
    message: `Unit baru dapat digunakan setelah ${availableAt}.`,
  };
}

async function validateDetails(trx, details, requestId = null, startDate = null, endDate = null) {
  const categoryIds = [...new Set(details.map((detail) => detail.equipmentCategoryId))];

  const categories = await trx('equipmentCategories')
    .whereIn('id', categoryIds)
    .where('isActive', true)
    .whereNull('deletedAt')
    .select('id');

  if (categories.length !== categoryIds.length) {
    return {
      valid: false,
      message: 'Terdapat equipment category yang tidak valid atau tidak aktif.',
    };
  }

  const equipmentUnitIds = details.map((detail) => detail.equipmentUnitId);

  if (equipmentUnitIds.some((equipmentUnitId) => !equipmentUnitId)) {
    return {
      valid: false,
      message: 'Setiap detail wajib memiliki equipment unit.',
    };
  }

  if (new Set(equipmentUnitIds).size !== equipmentUnitIds.length) {
    return {
      valid: false,
      message: 'Equipment unit yang sama tidak boleh dipilih lebih dari satu kali.',
    };
  }

  const equipmentUnits = await trx('equipmentUnits')
    .whereIn('id', equipmentUnitIds)
    .where('isActive', true)
    .whereNull('deletedAt')
    .select(['id', 'categoryId', 'unitCode', 'capacityValue', 'capacityUnit']);

  if (equipmentUnits.length !== equipmentUnitIds.length) {
    return {
      valid: false,
      message: 'Terdapat equipment unit yang tidak valid atau tidak aktif.',
    };
  }

  const requiredCapacityUnits = [
    ...new Set(details.map((detail) => detail.requiredCapacityUnit).filter(Boolean)),
  ];

  const capacityUnitLookups = await trx('sysLookups')
    .where('lookupGroup', 'equipment_capacity_unit')
    .whereIn('lookupCode', requiredCapacityUnits)
    .where('isActive', 1)
    .whereNull('deletedAt')
    .select('lookupCode');

  if (capacityUnitLookups.length !== requiredCapacityUnits.length) {
    return {
      valid: false,
      message: 'Terdapat required capacity unit yang tidak valid atau tidak aktif.',
    };
  }

  const equipmentUnitById = new Map(
    equipmentUnits.map((equipmentUnit) => [Number(equipmentUnit.id), equipmentUnit])
  );

  for (let index = 0; index < details.length; index += 1) {
    const detail = details[index];
    const rowNumber = index + 1;
    const equipmentUnit = equipmentUnitById.get(Number(detail.equipmentUnitId));

    if (Number(equipmentUnit.categoryId) !== Number(detail.equipmentCategoryId)) {
      return {
        valid: false,
        message:
          `Equipment unit pada detail baris ${rowNumber} ` +
          'tidak sesuai dengan equipment category.',
      };
    }

    if (String(equipmentUnit.capacityUnit).toUpperCase() !== detail.requiredCapacityUnit) {
      return {
        valid: false,
        message:
          `Satuan kapasitas unit ${equipmentUnit.unitCode} ` +
          `tidak sesuai dengan kebutuhan pada detail baris ${rowNumber}.`,
      };
    }

    if (Number(equipmentUnit.capacityValue) < Number(detail.requiredCapacityValue)) {
      return {
        valid: false,
        message:
          `Kapasitas unit ${equipmentUnit.unitCode} tidak mencukupi. ` +
          `Kapasitas unit ${Number(equipmentUnit.capacityValue)} ` +
          `${equipmentUnit.capacityUnit}, kebutuhan ` +
          `${Number(detail.requiredCapacityValue)} ` +
          `${detail.requiredCapacityUnit}.`,
      };
    }
  }

  const suppliedDetailUuids = details.map((detail) => detail.uuid).filter(Boolean);

  if (startDate && endDate) {
    for (let index = 0; index < details.length; index += 1) {
      const detail = details[index];
      const equipmentUnit = equipmentUnitById.get(Number(detail.equipmentUnitId));

      const scheduleValidation = await validateEquipmentUnitAvailability(trx, {
        equipmentUnitId: detail.equipmentUnitId,
        requestId,
        startDate,
        endDate,
      });

      if (!scheduleValidation.valid) {
        return {
          valid: false,
          message:
            `Equipment unit ${equipmentUnit.unitCode} pada detail baris ` +
            `${index + 1} tidak tersedia. ${scheduleValidation.message}`,
        };
      }
    }
  }

  if (new Set(suppliedDetailUuids).size !== suppliedDetailUuids.length) {
    return {
      valid: false,
      message: 'UUID detail tidak boleh duplikat.',
    };
  }

  if (requestId && suppliedDetailUuids.length > 0) {
    const existingDetails = await trx('equipmentRequestDetails')
      .where('requestId', requestId)
      .whereIn('uuid', suppliedDetailUuids)
      .whereNull('deletedAt')
      .select('uuid');

    if (existingDetails.length !== suppliedDetailUuids.length) {
      return {
        valid: false,
        message: 'Terdapat detail yang tidak ditemukan atau bukan milik equipment request ini.',
      };
    }
  }

  return {
    valid: true,
  };
}

async function resolveCompanyId(trx, companyUuid, access, existingCompanyId = null) {
  if (!isHolderAccess(access)) {
    return access.company?.id || null;
  }

  if (!companyUuid && existingCompanyId) {
    return existingCompanyId;
  }

  if (!companyUuid) {
    return null;
  }

  const company = await trx('companies')
    .where('uuid', companyUuid)
    .where('isActive', true)
    .whereNull('deletedAt')
    .first('id');

  return company?.id || null;
}

async function resolveDivisionId(trx, divisionUuid, companyId) {
  if (!divisionUuid) {
    return null;
  }

  const division = await trx('divisions')
    .where('uuid', divisionUuid)
    .where('companyId', companyId)
    .where('isActive', true)
    .whereNull('deletedAt')
    .first('id');

  return division?.id || null;
}

async function insertRequestDetails(trx, requestId, details, now) {
  const rows = details.map((detail) => ({
    uuid: randomUUID(),
    requestId,
    equipmentCategoryId: detail.equipmentCategoryId,
    equipmentUnitId: detail.equipmentUnitId,
    requiredCapacityValue: detail.requiredCapacityValue,
    requiredCapacityUnit: detail.requiredCapacityUnit,
    quantity: 1,
    rate: detail.rate,
    remarks: detail.remarks,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  }));

  await trx('equipmentRequestDetails').insert(rows);
}

async function synchronizeRequestDetails(trx, requestId, details, now) {
  const existingDetails = await trx('equipmentRequestDetails')
    .where('requestId', requestId)
    .whereNull('deletedAt')
    .select(['id', 'uuid']);

  const existingByUuid = new Map(existingDetails.map((detail) => [detail.uuid, detail]));

  const retainedUuids = [];
  const newRows = [];

  for (const detail of details) {
    if (detail.uuid && existingByUuid.has(detail.uuid)) {
      retainedUuids.push(detail.uuid);

      await trx('equipmentRequestDetails').where('id', existingByUuid.get(detail.uuid).id).update({
        equipmentCategoryId: detail.equipmentCategoryId,
        equipmentUnitId: detail.equipmentUnitId,
        requiredCapacityValue: detail.requiredCapacityValue,
        requiredCapacityUnit: detail.requiredCapacityUnit,
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
        requiredCapacityValue: detail.requiredCapacityValue,
        requiredCapacityUnit: detail.requiredCapacityUnit,
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

  const removedDetails = existingDetails.filter((detail) => !retainedUuids.includes(detail.uuid));

  if (removedDetails.length > 0) {
    const removedDetailIds = removedDetails.map((detail) => detail.id);

    const existingAssignment = await trx('equipmentAssignments')
      .whereIn('requestDetailId', removedDetailIds)
      .whereNull('deletedAt')
      .first('id');

    if (existingAssignment) {
      throw new Error('Detail tidak dapat dihapus karena sudah memiliki equipment assignment.');
    }

    await trx('equipmentRequestDetails').whereIn('id', removedDetailIds).update({
      isActive: false,
      updatedAt: now,
      deletedAt: now,
    });
  }

  if (newRows.length > 0) {
    await trx('equipmentRequestDetails').insert(newRows);
  }
}

async function generateRequestApprovals(trx, equipmentRequest) {
  const existingApproval = await trx('equipmentRequestApprovals')
    .where('requestId', equipmentRequest.id)
    .whereNull('deletedAt')
    .first('id');

  if (existingApproval) {
    return { valid: true };
  }

  const flows = await trx('equipmentApprovalFlows as flow')
    .select(['flow.approvalLevel', 'flow.companyId', 'flow.roleId', 'flow.actorStage'])
    .where((builder) => {
      builder
        .whereNull('flow.requestCompanyId')
        .orWhere('flow.requestCompanyId', equipmentRequest.companyId);
    })
    .where('flow.isActive', 1)
    .whereNull('flow.deletedAt')
    .orderBy([
      { column: 'flow.approvalLevel', order: 'asc' },
      { column: 'flow.id', order: 'asc' },
    ]);

  if (flows.length === 0) {
    return {
      valid: false,
      message: 'Approval flow belum dikonfigurasi untuk company equipment request ini.',
    };
  }

  const now = db.fn.now();

  await trx('equipmentRequestApprovals').insert(
    flows.map((flow) => ({
      uuid: randomUUID(),
      requestId: equipmentRequest.id,
      approvalLevel: flow.approvalLevel,
      companyId: flow.companyId,
      roleId: flow.roleId,
      userId: null,
      status: 'PENDING',
      remarks: null,
      actionDate: null,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }))
  );

  return { valid: true };
}

async function processPendingApproval(trx, { equipmentRequest, transition, access, remarks }) {
  const actionCode = transition.actionCode;
  const isApprovalAction = actionCode.includes('APPROVE') || actionCode.includes('REJECT');

  if (!isApprovalAction) {
    return { valid: true };
  }

  if (!access.company?.id) {
    return {
      valid: false,
      message: 'Company access user tidak ditemukan.',
    };
  }

  const userRoleIds = await trx('userRoles').where('userId', access.user.id).pluck('roleId');

  if (userRoleIds.length === 0) {
    return {
      valid: false,
      message: 'User tidak memiliki role approval aktif.',
    };
  }

  const pendingApproval = await trx('equipmentRequestApprovals')
    .where('requestId', equipmentRequest.id)
    .where('approvalLevel', equipmentRequest.currentApprovalLevel)
    .where('companyId', access.company.id)
    .whereIn('roleId', userRoleIds)
    .where('status', 'PENDING')
    .where('isActive', true)
    .whereNull('deletedAt')
    .orderBy('id', 'asc')
    .first();

  if (!pendingApproval) {
    return {
      valid: false,
      message: 'Approval pending yang sesuai dengan company, role, dan level user tidak ditemukan.',
    };
  }

  const now = db.fn.now();

  await trx('equipmentRequestApprovals')
    .where('id', pendingApproval.id)
    .update({
      userId: access.user.id,
      status: actionCode.includes('REJECT') ? 'REJECTED' : 'APPROVED',
      remarks,
      actionDate: now,
      updatedAt: now,
    });

  return { valid: true };
}

async function findNextPendingApprovalLevel(trx, requestId) {
  const pendingApproval = await trx('equipmentRequestApprovals')
    .where('requestId', requestId)
    .where('status', 'PENDING')
    .where('isActive', true)
    .whereNull('deletedAt')
    .orderBy('approvalLevel', 'asc')
    .first('approvalLevel');

  return pendingApproval ? Number(pendingApproval.approvalLevel) : null;
}

async function insertRequestHistory(trx, { requestId, activity, description, userId, createdAt }) {
  await trx('equipmentRequestHistories').insert({
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
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const datePart = `${year}${month}${day}`;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const randomPart = randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
    const requestNo = `REQ-${datePart}-${randomPart}`;

    const duplicate = await trx('equipmentRequests').where('requestNo', requestNo).first('id');

    if (!duplicate) {
      return requestNo;
    }
  }

  throw new Error('Failed to generate a unique equipment request number.');
}

function applyRequestScope(query, access, alias = 'request') {
  if (isHolderAccess(access)) {
    return query;
  }

  if (!access.company?.id) {
    query.whereRaw('1 = 0');

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
    rawUser.id || rawUser.userId || rawAccess.userId || requestData.userId || requestData.id
  );

  if (!userId) {
    throw new Error('Authenticated user access was not found.');
  }

  const existingCompany = rawAccess.company || requestData.company || {};
  const existingCompanyId = Number(
    existingCompany.id || existingCompany.companyId || rawAccess.companyId || requestData.companyId
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

  const userCompany = await trx('users as user')
    .leftJoin('companies as company', function () {
      this.on('company.id', '=', 'user.companyId').andOnNull('company.deletedAt');
    })
    .select([
      'user.id as userId',
      'user.companyId',
      'company.uuid as companyUuid',
      'company.code as companyCode',
      'company.name as companyName',
      'company.type as companyType',
    ])
    .where('user.id', userId)
    .whereNull('user.deletedAt')
    .first();

  if (!userCompany) {
    throw new Error('Authenticated user was not found.');
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
            userCompany.companyType === null || userCompany.companyType === undefined
              ? null
              : Number(userCompany.companyType),
        }
      : null,
    permissionCodes: normalizePermissionCodes(rawAccess),
  };
}

function normalizePermissionCodes(access = {}) {
  const source = access.permissionCodes || access.permissions || access.permission || [];

  if (!Array.isArray(source)) {
    return [];
  }

  return source
    .map((permission) => {
      if (typeof permission === 'string') {
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
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const normalizedValue = Number(value);

  if (!Number.isInteger(normalizedValue) || normalizedValue <= 0) {
    return null;
  }

  return normalizedValue;
}

function normalizePositiveDecimal(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const normalizedValue = Number(value);

  if (!Number.isFinite(normalizedValue) || normalizedValue <= 0) {
    return null;
  }

  return normalizedValue;
}

function normalizeNullableDecimal(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const normalizedValue = Number(value);

  if (!Number.isFinite(normalizedValue)) {
    return null;
  }

  return normalizedValue;
}

function normalizeRequiredString(value) {
  if (typeof value !== 'string') {
    return '';
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
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const normalizedValue = String(value).trim();

  const match = normalizedValue.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?$/);

  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second = '00'] = match;

  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const hourNumber = Number(hour);
  const minuteNumber = Number(minute);
  const secondNumber = Number(second);

  if (hourNumber > 23 || minuteNumber > 59 || secondNumber > 59) {
    return null;
  }

  const date = new Date(
    Date.UTC(yearNumber, monthNumber - 1, dayNumber, hourNumber, minuteNumber, secondNumber)
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

  if (['true', '1', 'yes', 'y'].includes(normalizedValue)) {
    return true;
  }

  if (['false', '0', 'no', 'n'].includes(normalizedValue)) {
    return false;
  }

  throw new Error('Query isActive harus berupa true atau false.');
}

module.exports = router;
