'use strict';

const express = require('express');
const { randomUUID } = require('crypto');

const router = express.Router();
const {
  authenticate: authentication,
  authorize: authorization,
} = require('../../modules/access/access.middleware');
const db = require('../../lib/db')();

const {
  enqueueAssignmentNotifications,
  enqueueOperationStartedNotifications,
  enqueueOperationCompletedNotifications,
} = require('../../services/equipment-request/email');
const {
  deactivateAssignmentMenuNotifications,
} = require('../../services/equipment-request/notification');

const HOLDER_COMPANY_TYPE = 1;

const STATUS_APPROVED = 'APPROVED';
const STATUS_ASSIGNED = 'ASSIGNED';
const STATUS_IN_PROGRESS = 'IN_PROGRESS';
const STATUS_PARTIALLY_COMPLETED = 'PARTIALLY_COMPLETED';
const STATUS_COMPLETED = 'COMPLETED';

const ASSIGNMENT_STATUS_ASSIGNED = 'ASSIGNED';
const ASSIGNMENT_STATUS_IN_OPERATION = 'IN_OPERATION';
const ASSIGNMENT_STATUS_COMPLETED = 'COMPLETED';
const ASSIGNMENT_STATUS_CANCELLED = 'CANCELLED';

router.use(authentication);

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
      'equipmentUnit.uuid as equipmentUnitUuid',
      'equipmentUnit.unitCode as equipmentUnitCode',
      'equipmentUnit.unitName as equipmentUnitName',
      'equipmentUnit.assetNumber as equipmentUnitAssetNumber',
      'equipmentUnit.modelNumber as equipmentUnitModelNumber',
      'equipmentUnit.plateNumber as equipmentUnitPlateNumber',
      'equipmentUnit.capacityValue as equipmentUnitCapacityValue',
      'equipmentUnit.capacityUnit as equipmentUnitCapacityUnit',

      'detail.requiredCapacityValue',
      'detail.requiredCapacityUnit',
      'detail.rate',
      'detail.remarks',
      'detail.isActive',
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
      message: 'Start date review wajib diisi dengan format YYYY-MM-DD.',
    };
  }

  if (!endDate) {
    return {
      valid: false,
      message: 'End date review wajib diisi dengan format YYYY-MM-DD.',
    };
  }

  if (startDate > endDate) {
    return {
      valid: false,
      message: 'End date review tidak boleh lebih kecil dari start date.',
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
      equipmentCategoryId: normalizePositiveInteger(detail?.equipmentCategoryId),
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
      message: 'Start date wajib diisi dengan format YYYY-MM-DD.',
    };
  }

  if (!payload.endDate) {
    return {
      valid: false,
      message: 'End date wajib diisi dengan format YYYY-MM-DD.',
    };
  }

  if (payload.startDate > payload.endDate) {
    return {
      valid: false,
      message: 'End date tidak boleh lebih kecil dari start date.',
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

  const suppliedDetailUuids = details.map((detail) => detail.uuid).filter(Boolean);

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

  const userRoleIds = await trx('userRoles')
    .where('userId', access.user.id)
    .where('isActive', true)
    .whereNull('deletedAt')
    .pluck('roleId');

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

router.get('/:uuid/workspace', authorization('EQUIPMENT_REQUEST.VIEW'), async (req, res) => {
  try {
    const access = await getRequestAccess(req);

    const equipmentRequest = await findRequestByUuid(req.params.uuid, access);

    if (!equipmentRequest) {
      return res.incomplete('Equipment request tidak ditemukan.');
    }

    const [details, assignments] = await Promise.all([
      findRequestDetails(equipmentRequest.id),
      findAssignments(equipmentRequest.id),
    ]);

    return res.success({
      request: {
        ...equipmentRequest,
        details,
      },
      assignments,
    });
  } catch (error) {
    console.error('GET /equipment-request/assignment/:uuid/workspace error:', error);

    return res.fail(error.message || 'Failed to load assignment workspace.');
  }
});

/**
 * GET /equipment-request/:uuid
 */
router.get('/:uuid', authorization('EQUIPMENT_REQUEST.VIEW'), async (req, res) => {
  try {
    const access = await getRequestAccess(req);

    const equipmentRequest = await findRequestByUuid(req.params.uuid, access);

    if (!equipmentRequest) {
      return res.incomplete('Equipment request tidak ditemukan.');
    }

    const assignments = await findAssignments(equipmentRequest.id);

    return res.success(assignments);
  } catch (error) {
    console.error('GET /equipment-request/:uuid error:', error);

    return res.fail(error.message || 'Failed to load equipment assignments.');
  }
});

/**
 * POST /equipment-request/:uuid
 *
 * One assignment represents one equipment unit.
 */
router.post('/:uuid', authorization('EQUIPMENT_REQUEST.ASSIGN'), async (req, res) => {
  const trx = await db.transaction();

  try {
    const access = await getRequestAccess(req);

    const equipmentRequest = await findRequestForUpdate(trx, req.params.uuid, access);

    if (!equipmentRequest) {
      await trx.rollback();

      return res.incomplete('Equipment request tidak ditemukan.');
    }

    if (!equipmentRequest.approvalLocked) {
      await trx.rollback();

      return res.incomplete(
        'Equipment hanya dapat di-assign setelah request mendapat approval final.'
      );
    }

    /*
     * Assignment hanya dapat ditambahkan setelah approval final.
     *
     * Satu request detail mewakili satu physical equipment unit
     * dan hanya dapat memiliki satu assignment aktif.
     *
     * Setelah seluruh request detail memiliki assignment aktif,
     * synchronizeRequestAssignmentStatus akan mengubah status
     * request menjadi ASSIGNED.
     */
    if (equipmentRequest.status !== STATUS_APPROVED) {
      await trx.rollback();

      return res.incomplete(
        `Assignment hanya dapat dilakukan pada request berstatus ${STATUS_APPROVED}. Status saat ini: ${equipmentRequest.status}.`
      );
    }

    const payload = normalizeAssignmentPayload(req.body);
    const validation = validateAssignmentPayload(payload);

    if (!validation.valid) {
      await trx.rollback();

      return res.incomplete(validation.message);
    }

    const requestDetail = await trx('equipmentRequestDetails')
      .where('uuid', payload.requestDetailUuid)
      .where('requestId', equipmentRequest.id)
      .where('isActive', true)
      .whereNull('deletedAt')
      .first();

    if (!requestDetail) {
      await trx.rollback();

      return res.incomplete('Equipment request detail tidak ditemukan.');
    }

    const equipmentUnit = await trx('equipmentUnits')
      .where('uuid', payload.equipmentUnitUuid)
      .where('isActive', true)
      .whereNull('deletedAt')
      .first([
        'id',
        'uuid',
        'categoryId',
        'unitName',
        'unitCode',
        'assetNumber',
        'modelNumber',
        'plateNumber',
        'capacityValue',
        'capacityUnit',
        'operationalStatusCode',
      ]);

    if (!equipmentUnit) {
      await trx.rollback();

      return res.incomplete('Equipment unit tidak valid atau tidak aktif.');
    }

    if (String(equipmentUnit.operationalStatusCode || '').toUpperCase() !== 'AVAILABLE') {
      await trx.rollback();

      return res.incomplete(
        `Equipment unit ${equipmentUnit.unitCode} tidak dapat di-assign karena status operasionalnya ${equipmentUnit.operationalStatusCode}.`
      );
    }

    if (Number(requestDetail.equipmentUnitId) !== Number(equipmentUnit.id)) {
      await trx.rollback();

      return res.incomplete(
        'Equipment unit assignment harus sesuai dengan unit yang telah disetujui pada request detail.'
      );
    }

    if (Number(requestDetail.equipmentCategoryId) !== Number(equipmentUnit.categoryId)) {
      await trx.rollback();

      return res.incomplete('Equipment unit tidak sesuai dengan category pada request detail.');
    }

    if (
      String(equipmentUnit.capacityUnit || '').toUpperCase() !==
      String(requestDetail.requiredCapacityUnit || '').toUpperCase()
    ) {
      await trx.rollback();

      return res.incomplete(
        `Satuan kapasitas unit ${equipmentUnit.unitCode} ` +
          'tidak sesuai dengan kebutuhan request.'
      );
    }

    if (Number(equipmentUnit.capacityValue) < Number(requestDetail.requiredCapacityValue)) {
      await trx.rollback();

      return res.incomplete(
        `Kapasitas unit ${equipmentUnit.unitCode} tidak mencukupi. ` +
          `Kapasitas unit ${Number(equipmentUnit.capacityValue)} ` +
          `${equipmentUnit.capacityUnit}, kebutuhan ` +
          `${Number(requestDetail.requiredCapacityValue)} ` +
          `${requestDetail.requiredCapacityUnit}.`
      );
    }

    const scheduleValidation = await validateEquipmentSchedule(trx, {
      equipmentUnitId: equipmentUnit.id,
      plannedStartDate: payload.plannedStartDate,
      plannedEndDate: payload.plannedEndDate,
    });

    if (!scheduleValidation.valid) {
      await trx.rollback();

      return res.incomplete(scheduleValidation.message);
    }

    const now = db.fn.now();
    const assignmentUuid = randomUUID();

    await trx('equipmentAssignments').insert({
      uuid: assignmentUuid,
      requestId: equipmentRequest.id,
      requestDetailId: requestDetail.id,
      equipmentUnitId: equipmentUnit.id,
      statusCode: ASSIGNMENT_STATUS_ASSIGNED,
      plannedStartDate: payload.plannedStartDate,
      plannedEndDate: payload.plannedEndDate,
      actualStartDate: null,
      actualEndDate: null,
      assignedBy: access.user.id,
      assignedAt: now,

      releasedBy: null,
      releasedAt: null,
      notes: payload.notes,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });

    // await synchronizeRequestAssignmentStatus(trx, equipmentRequest.id);
    const assignmentStatusResult = await synchronizeRequestAssignmentStatus(
      trx,
      equipmentRequest.id
    );

    await insertRequestHistory(trx, {
      requestId: equipmentRequest.id,
      activity: 'ASSIGN_EQUIPMENT',
      description: `Equipment unit ${equipmentUnit.uuid} di-assign ke request detail ${requestDetail.uuid}.`,
      userId: access.user.id,
      createdAt: now,
    });

    if (assignmentStatusResult.statusChanged) {
      await deactivateAssignmentMenuNotifications(trx, equipmentRequest);

      await enqueueAssignmentNotifications(trx, {
        requestId: equipmentRequest.id,
        actionUserId: access.user.id,
        previousStatusCode: assignmentStatusResult.previousStatusCode,
      });
    }

    await trx.commit();

    const assignment = await findAssignmentByUuid(assignmentUuid);

    return res.success(assignment);
  } catch (error) {
    await trx.rollback();

    console.error('POST /equipment-request/:uuid error:', error);

    return res.fail(error.message || 'Failed to create equipment assignment.');
  }
});

router.post('/:uuid/bulk', authorization('EQUIPMENT_REQUEST.ASSIGN'), async (req, res) => {
  const trx = await db.transaction();

  try {
    const access = await getRequestAccess(req);

    const equipmentRequest = await findRequestForUpdate(trx, req.params.uuid, access);

    if (!equipmentRequest) {
      await trx.rollback();

      return res.incomplete('Equipment request tidak ditemukan.');
    }

    if (!equipmentRequest.approvalLocked) {
      await trx.rollback();

      return res.incomplete(
        'Equipment hanya dapat di-assign setelah request mendapat approval final.'
      );
    }

    if (equipmentRequest.status !== STATUS_APPROVED) {
      await trx.rollback();

      return res.incomplete(
        `Assignment hanya dapat dilakukan pada request berstatus ${STATUS_APPROVED}. Status saat ini: ${equipmentRequest.status}.`
      );
    }

    const rawAssignments = Array.isArray(req.body?.assignments) ? req.body.assignments : [];

    if (rawAssignments.length === 0) {
      await trx.rollback();

      return res.incomplete('Minimal satu equipment assignment wajib dikirim.');
    }

    const payloads = rawAssignments.map((item) => normalizeAssignmentPayload(item));

    for (let index = 0; index < payloads.length; index += 1) {
      const validation = validateAssignmentPayload(payloads[index]);

      if (!validation.valid) {
        await trx.rollback();

        return res.incomplete(`Assignment baris ${index + 1}: ${validation.message}`);
      }
    }

    const requestDetailUuids = payloads.map((payload) => payload.requestDetailUuid);

    if (new Set(requestDetailUuids).size !== requestDetailUuids.length) {
      await trx.rollback();

      return res.incomplete('Request detail tidak boleh memiliki assignment duplikat.');
    }

    const equipmentUnitUuids = payloads.map((payload) => payload.equipmentUnitUuid);

    if (new Set(equipmentUnitUuids).size !== equipmentUnitUuids.length) {
      await trx.rollback();

      return res.incomplete(
        'Equipment unit tidak boleh digunakan lebih dari satu kali dalam proses Assign All.'
      );
    }

    const requestDetails = await trx('equipmentRequestDetails')
      .where('requestId', equipmentRequest.id)
      .whereIn('uuid', requestDetailUuids)
      .where('isActive', true)
      .whereNull('deletedAt');

    if (requestDetails.length !== requestDetailUuids.length) {
      await trx.rollback();

      return res.incomplete('Terdapat equipment request detail yang tidak valid.');
    }

    const equipmentUnits = await trx('equipmentUnits')
      .whereIn('uuid', equipmentUnitUuids)
      .where('isActive', true)
      .whereNull('deletedAt')
      .select([
        'id',
        'uuid',
        'categoryId',
        'unitName',
        'unitCode',
        'assetNumber',
        'modelNumber',
        'plateNumber',
        'capacityValue',
        'capacityUnit',
        'operationalStatusCode',
      ]);

    if (equipmentUnits.length !== equipmentUnitUuids.length) {
      await trx.rollback();

      return res.incomplete('Terdapat equipment unit yang tidak valid atau tidak aktif.');
    }

    const unavailableOperationalUnit = equipmentUnits.find(
      (unit) => String(unit.operationalStatusCode || '').toUpperCase() !== 'AVAILABLE'
    );

    if (unavailableOperationalUnit) {
      await trx.rollback();

      return res.incomplete(
        `Equipment unit ${unavailableOperationalUnit.unitCode} tidak dapat di-assign karena status operasionalnya ${unavailableOperationalUnit.operationalStatusCode}.`
      );
    }

    const detailByUuid = new Map(requestDetails.map((detail) => [detail.uuid, detail]));

    const unitByUuid = new Map(equipmentUnits.map((unit) => [unit.uuid, unit]));

    const now = db.fn.now();
    const assignmentRows = [];
    const historyRows = [];

    for (const payload of payloads) {
      const requestDetail = detailByUuid.get(payload.requestDetailUuid);

      const equipmentUnit = unitByUuid.get(payload.equipmentUnitUuid);

      if (Number(requestDetail.equipmentUnitId) !== Number(equipmentUnit.id)) {
        await trx.rollback();

        return res.incomplete(
          `Equipment unit ${equipmentUnit.unitCode} tidak sesuai dengan unit yang telah disetujui pada request detail ${requestDetail.uuid}.`
        );
      }

      if (Number(requestDetail.equipmentCategoryId) !== Number(equipmentUnit.categoryId)) {
        await trx.rollback();

        return res.incomplete(
          `Equipment unit ${equipmentUnit.unitCode} tidak sesuai dengan category request detail.`
        );
      }

      if (
        String(equipmentUnit.capacityUnit || '').toUpperCase() !==
        String(requestDetail.requiredCapacityUnit || '').toUpperCase()
      ) {
        await trx.rollback();

        return res.incomplete(
          `Satuan kapasitas unit ${equipmentUnit.unitCode} tidak sesuai dengan kebutuhan request.`
        );
      }

      if (Number(equipmentUnit.capacityValue) < Number(requestDetail.requiredCapacityValue)) {
        await trx.rollback();

        return res.incomplete(`Kapasitas unit ${equipmentUnit.unitCode} tidak mencukupi.`);
      }

      const scheduleValidation = await validateEquipmentSchedule(trx, {
        equipmentUnitId: equipmentUnit.id,
        plannedStartDate: payload.plannedStartDate,
        plannedEndDate: payload.plannedEndDate,
      });

      if (!scheduleValidation.valid) {
        await trx.rollback();

        return res.incomplete(`${equipmentUnit.unitCode}: ${scheduleValidation.message}`);
      }

      assignmentRows.push({
        uuid: randomUUID(),
        requestId: equipmentRequest.id,
        requestDetailId: requestDetail.id,
        equipmentUnitId: equipmentUnit.id,
        statusCode: ASSIGNMENT_STATUS_ASSIGNED,
        plannedStartDate: payload.plannedStartDate,
        plannedEndDate: payload.plannedEndDate,
        actualStartDate: null,
        actualEndDate: null,
        assignedBy: access.user.id,
        assignedAt: now,
        releasedBy: null,
        releasedAt: null,
        notes: payload.notes,
        isActive: true,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });

      historyRows.push({
        uuid: randomUUID(),
        requestId: equipmentRequest.id,
        activity: 'ASSIGN_EQUIPMENT',
        description:
          `Equipment unit ${equipmentUnit.uuid} di-assign ` +
          `ke request detail ${requestDetail.uuid}.`,
        userId: access.user.id,
        createdAt: now,
      });
    }

    await trx('equipmentAssignments').insert(assignmentRows);

    await trx('equipmentRequestHistories').insert(historyRows);

    const assignmentStatusResult = await synchronizeRequestAssignmentStatus(
      trx,
      equipmentRequest.id
    );

    if (assignmentStatusResult.statusChanged) {
      await deactivateAssignmentMenuNotifications(trx, equipmentRequest);

      await enqueueAssignmentNotifications(trx, {
        requestId: equipmentRequest.id,
        actionUserId: access.user.id,
        previousStatusCode: assignmentStatusResult.previousStatusCode,
      });
    }

    await trx.commit();

    const assignments = await findAssignments(equipmentRequest.id);

    return res.success(assignments);
  } catch (error) {
    await trx.rollback();

    console.error('POST /equipment-request/assignment/:uuid/bulk error:', error);

    return res.fail(error.message || 'Failed to create equipment assignments.');
  }
});

router.post(
  '/:uuid/start-all',
  authorization('EQUIPMENT_REQUEST.START_OPERATION'),
  async (req, res) => {
    const trx = await db.transaction();

    try {
      const access = await getRequestAccess(req);

      const equipmentRequest = await findRequestForUpdate(trx, req.params.uuid, access);

      if (!equipmentRequest) {
        await trx.rollback();

        return res.incomplete('Equipment request tidak ditemukan.');
      }

      const assignmentUuids = Array.isArray(req.body?.assignmentUuids)
        ? [...new Set(req.body.assignmentUuids.filter(Boolean))]
        : [];

      if (assignmentUuids.length === 0) {
        await trx.rollback();

        return res.incomplete('Minimal satu equipment assignment wajib dipilih.');
      }

      const assignments = await trx('equipmentAssignments')
        .where('requestId', equipmentRequest.id)
        .whereIn('uuid', assignmentUuids)
        .where('isActive', true)
        .whereNull('deletedAt')
        .forUpdate()
        .select(['id', 'uuid', 'statusCode']);

      if (assignments.length !== assignmentUuids.length) {
        await trx.rollback();

        return res.incomplete('Terdapat equipment assignment yang tidak ditemukan.');
      }

      const invalidAssignment = assignments.find(
        (assignment) => assignment.statusCode !== ASSIGNMENT_STATUS_ASSIGNED
      );

      if (invalidAssignment) {
        await trx.rollback();

        return res.incomplete(
          `Assignment ${invalidAssignment.uuid} berstatus ${invalidAssignment.statusCode} dan tidak dapat dimulai.`
        );
      }

      const now = db.fn.now();
      const assignmentIds = assignments.map((assignment) => assignment.id);

      await trx('equipmentAssignments').whereIn('id', assignmentIds).update({
        statusCode: ASSIGNMENT_STATUS_IN_OPERATION,
        actualStartDate: now,
        updatedAt: now,
      });

      await trx('equipmentRequestHistories').insert(
        assignments.map((assignment) => ({
          uuid: randomUUID(),
          requestId: equipmentRequest.id,
          activity: 'START_OPERATION',
          description: `Assignment ${assignment.uuid} mulai beroperasi.`,
          userId: access.user.id,
          createdAt: now,
        }))
      );

      const operationalStatusResult = await synchronizeRequestOperationalStatus(
        trx,
        equipmentRequest.id
      );

      if (
        operationalStatusResult.statusChanged &&
        operationalStatusResult.statusCode === STATUS_IN_PROGRESS
      ) {
        await enqueueOperationStartedNotifications(trx, {
          requestId: equipmentRequest.id,
          actionUserId: access.user.id,
          previousStatusCode: operationalStatusResult.previousStatusCode,
        });
      }

      await trx.commit();

      const updatedAssignments = await findAssignments(equipmentRequest.id);

      return res.success(updatedAssignments);
    } catch (error) {
      await trx.rollback();

      console.error('POST /equipment-request/assignment/:uuid/start-all error:', error);

      return res.fail(error.message || 'Failed to start equipment operations.');
    }
  }
);

router.post(
  '/:uuid/:assignmentUuid/start',
  authorization('EQUIPMENT_REQUEST.START_OPERATION'),
  async (req, res) => {
    return updateAssignmentOperation(req, res, ASSIGNMENT_STATUS_IN_OPERATION);
  }
);

router.post(
  '/:uuid/:assignmentUuid/complete',
  authorization('EQUIPMENT_REQUEST.COMPLETE'),
  async (req, res) => {
    return updateAssignmentOperation(req, res, ASSIGNMENT_STATUS_COMPLETED);
  }
);

async function updateAssignmentOperation(req, res, destinationStatus) {
  const trx = await db.transaction();

  try {
    const access = await getRequestAccess(req);

    const equipmentRequest = await findRequestForUpdate(trx, req.params.uuid, access);

    if (!equipmentRequest) {
      await trx.rollback();

      return res.incomplete('Equipment request tidak ditemukan.');
    }

    const assignment = await trx('equipmentAssignments')
      .where('uuid', req.params.assignmentUuid)
      .where('requestId', equipmentRequest.id)
      .where('isActive', true)
      .whereNull('deletedAt')
      .forUpdate()
      .first();

    if (!assignment) {
      await trx.rollback();

      return res.incomplete('Equipment assignment tidak ditemukan.');
    }

    if (
      destinationStatus === ASSIGNMENT_STATUS_IN_OPERATION &&
      assignment.statusCode !== ASSIGNMENT_STATUS_ASSIGNED
    ) {
      await trx.rollback();

      return res.incomplete(`Assignment berstatus ${assignment.statusCode} tidak dapat dimulai.`);
    }

    if (
      destinationStatus === ASSIGNMENT_STATUS_COMPLETED &&
      assignment.statusCode !== ASSIGNMENT_STATUS_IN_OPERATION
    ) {
      await trx.rollback();

      return res.incomplete(
        assignment.statusCode === ASSIGNMENT_STATUS_COMPLETED
          ? 'Equipment assignment sudah diselesaikan.'
          : `Assignment berstatus ${assignment.statusCode} tidak dapat diselesaikan.`
      );
    }

    const now = db.fn.now();

    const updatePayload = {
      statusCode: destinationStatus,
      updatedAt: now,
    };

    if (destinationStatus === ASSIGNMENT_STATUS_IN_OPERATION) {
      updatePayload.actualStartDate = now;
    }

    if (destinationStatus === ASSIGNMENT_STATUS_COMPLETED) {
      updatePayload.actualEndDate = now;
      updatePayload.releasedBy = access.user.id;
      updatePayload.releasedAt = now;
    }

    await trx('equipmentAssignments').where('id', assignment.id).update(updatePayload);

    // await synchronizeRequestOperationalStatus(trx, equipmentRequest.id);
    const operationalStatusResult = await synchronizeRequestOperationalStatus(
      trx,
      equipmentRequest.id
    );

    await insertRequestHistory(trx, {
      requestId: equipmentRequest.id,
      activity:
        destinationStatus === ASSIGNMENT_STATUS_IN_OPERATION
          ? 'START_OPERATION'
          : 'COMPLETE_ASSIGNMENT',

      description:
        destinationStatus === ASSIGNMENT_STATUS_IN_OPERATION
          ? `Assignment ${assignment.uuid} mulai beroperasi.`
          : `Assignment ${assignment.uuid} selesai beroperasi.`,
      userId: access.user.id,
      createdAt: now,
    });

    if (
      destinationStatus === ASSIGNMENT_STATUS_IN_OPERATION &&
      operationalStatusResult.statusChanged &&
      operationalStatusResult.statusCode === STATUS_IN_PROGRESS
    ) {
      await enqueueOperationStartedNotifications(trx, {
        requestId: equipmentRequest.id,
        actionUserId: access.user.id,
        previousStatusCode: operationalStatusResult.previousStatusCode,
      });
    }

    if (
      destinationStatus === ASSIGNMENT_STATUS_COMPLETED &&
      operationalStatusResult.statusChanged &&
      operationalStatusResult.statusCode === STATUS_COMPLETED
    ) {
      await enqueueOperationCompletedNotifications(trx, {
        requestId: equipmentRequest.id,
        actionUserId: access.user.id,
        previousStatusCode: operationalStatusResult.previousStatusCode,
      });
    }

    await trx.commit();

    const updatedAssignment = await findAssignmentByUuid(assignment.uuid);

    return res.success(updatedAssignment);
  } catch (error) {
    await trx.rollback();

    console.error(
      `POST /equipment-request/:uuid/:assignmentUuid/${destinationStatus} error:`,
      error
    );

    return res.fail(error.message || 'Failed to update equipment assignment.');
  }
}

async function findAssignments(requestId, trx = db) {
  return trx('equipmentAssignments as assignment')
    .join('equipmentRequestDetails as detail', 'detail.id', 'assignment.requestDetailId')
    .join('equipmentUnits as equipmentUnit', 'equipmentUnit.id', 'assignment.equipmentUnitId')
    .leftJoin('users as assignedUser', 'assignedUser.id', 'assignment.assignedBy')
    .leftJoin('users as releasedUser', 'releasedUser.id', 'assignment.releasedBy')
    .select([
      'assignment.id',
      'assignment.uuid',
      'assignment.requestId',
      'assignment.requestDetailId',
      'detail.uuid as requestDetailUuid',
      'assignment.equipmentUnitId',
      'equipmentUnit.uuid as equipmentUnitUuid',
      'equipmentUnit.unitName as equipmentUnitName',
      'equipmentUnit.unitCode as equipmentUnitCode',
      'equipmentUnit.assetNumber as equipmentUnitAssetNumber',
      'equipmentUnit.modelNumber as equipmentUnitModelNumber',
      'equipmentUnit.plateNumber as equipmentUnitPlateNumber',
      'assignment.statusCode',
      'assignment.plannedStartDate',
      'assignment.plannedEndDate',
      'assignment.actualStartDate',
      'assignment.actualEndDate',
      'assignment.assignedBy',
      'assignedUser.uuid as assignedByUuid',
      'assignedUser.fullName as assignedByName',
      'assignment.assignedAt',
      'assignment.releasedBy',
      'releasedUser.uuid as releasedByUuid',
      'releasedUser.fullName as releasedByName',
      'assignment.releasedAt',
      'assignment.notes',
      'assignment.isActive',
      'assignment.createdAt',
      'assignment.updatedAt',
    ])
    .where('assignment.requestId', requestId)
    .whereNull('assignment.deletedAt')
    .orderBy([
      {
        column: 'assignment.requestDetailId',
        order: 'asc',
      },
      {
        column: 'assignment.id',
        order: 'asc',
      },
    ]);
}

async function findAssignmentByUuid(uuid, trx = db) {
  return trx('equipmentAssignments as assignment')
    .join('equipmentRequestDetails as detail', 'detail.id', 'assignment.requestDetailId')
    .join('equipmentUnits as equipmentUnit', 'equipmentUnit.id', 'assignment.equipmentUnitId')
    .leftJoin('users as assignedUser', 'assignedUser.id', 'assignment.assignedBy')
    .leftJoin('users as releasedUser', 'releasedUser.id', 'assignment.releasedBy')
    .select([
      'assignment.id',
      'assignment.uuid',
      'assignment.requestId',
      'assignment.requestDetailId',
      'detail.uuid as requestDetailUuid',
      'assignment.equipmentUnitId',
      'equipmentUnit.uuid as equipmentUnitUuid',
      'equipmentUnit.unitName as equipmentUnitName',
      'equipmentUnit.unitCode as equipmentUnitCode',
      'equipmentUnit.assetNumber as equipmentUnitAssetNumber',
      'equipmentUnit.modelNumber as equipmentUnitModelNumber',
      'equipmentUnit.plateNumber as equipmentUnitPlateNumber',
      'assignment.statusCode',
      'assignment.plannedStartDate',
      'assignment.plannedEndDate',
      'assignment.actualStartDate',
      'assignment.actualEndDate',
      'assignment.assignedBy',
      'assignedUser.uuid as assignedByUuid',
      'assignedUser.fullName as assignedByName',
      'assignment.assignedAt',

      'assignment.releasedBy',
      'releasedUser.uuid as releasedByUuid',
      'releasedUser.fullName as releasedByName',
      'assignment.releasedAt',
      'assignment.notes',
      'assignment.isActive',
      'assignment.createdAt',
      'assignment.updatedAt',
    ])
    .where('assignment.uuid', uuid)
    .whereNull('assignment.deletedAt')
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
    return {
      valid: false,
      message: 'Request detail wajib dipilih.',
    };
  }

  if (!payload.equipmentUnitUuid) {
    return {
      valid: false,
      message: 'Equipment unit wajib dipilih.',
    };
  }

  if (!payload.plannedStartDate) {
    return {
      valid: false,
      message: 'Planned start date wajib diisi.',
    };
  }

  if (!payload.plannedEndDate) {
    return {
      valid: false,
      message: 'Planned end date wajib diisi.',
    };
  }

  if (payload.plannedEndDate <= payload.plannedStartDate) {
    return {
      valid: false,
      message: 'Planned end date dan waktu harus lebih besar dari planned start date dan waktu.',
    };
  }

  return {
    valid: true,
  };
}

async function validateEquipmentSchedule(trx, payload) {
  const overlap = await trx('equipmentAssignments')
    .where('equipmentUnitId', payload.equipmentUnitId)
    .where('isActive', true)
    .whereNull('deletedAt')
    .whereNotIn('statusCode', [ASSIGNMENT_STATUS_CANCELLED])
    .where('plannedStartDate', '<=', payload.plannedEndDate)
    .andWhere((builder) => {
      builder.whereNull('actualEndDate').orWhereRaw(
        `
            GREATEST(
              plannedEndDate,
              actualEndDate
            ) >= ?
          `,
        [payload.plannedStartDate]
      );
    })
    .first(['id', 'uuid', 'statusCode', 'plannedStartDate', 'plannedEndDate', 'actualEndDate']);

  if (overlap) {
    if (!overlap.actualEndDate) {
      return {
        valid: false,
        message: 'Equipment unit masih memiliki assignment yang belum diselesaikan.',
      };
    }

    const availableAt =
      overlap.actualEndDate > overlap.plannedEndDate
        ? overlap.actualEndDate
        : overlap.plannedEndDate;

    return {
      valid: false,
      message:
        `Equipment unit belum tersedia pada periode tersebut. ` +
        `Unit baru dapat digunakan setelah ${availableAt}.`,
    };
  }

  return {
    valid: true,
  };
}

async function synchronizeRequestAssignmentStatus(trx, requestId) {
  const request = await trx('equipmentRequests')
    .where('id', requestId)
    .whereNull('deletedAt')
    .first(['status']);

  if (!request) {
    return {
      statusChanged: false,
      previousStatusCode: null,
      statusCode: null,
    };
  }

  const detailSummary = await trx('equipmentRequestDetails as detail')
    .leftJoin('equipmentAssignments as assignment', function () {
      this.on('assignment.requestDetailId', '=', 'detail.id')
        .andOnVal('assignment.isActive', '=', 1)
        .andOnNull('assignment.deletedAt')
        .andOnNotIn('assignment.statusCode', [ASSIGNMENT_STATUS_CANCELLED]);
    })
    .where('detail.requestId', requestId)
    .where('detail.isActive', true)
    .whereNull('detail.deletedAt')
    .countDistinct({
      detailCount: 'detail.id',
    })
    .countDistinct({
      assignedDetailCount: 'assignment.requestDetailId',
    })
    .first();

  const detailCount = Number(detailSummary?.detailCount) || 0;
  const assignedDetailCount = Number(detailSummary?.assignedDetailCount) || 0;

  if (detailCount === 0 || assignedDetailCount < detailCount) {
    return {
      statusChanged: false,
      previousStatusCode: request.status,
      statusCode: request.status,
    };
  }

  if (request.status === STATUS_ASSIGNED) {
    return {
      statusChanged: false,
      previousStatusCode: STATUS_ASSIGNED,
      statusCode: STATUS_ASSIGNED,
    };
  }

  await updateRequestStatusIfAvailable(trx, requestId, STATUS_ASSIGNED);

  return {
    statusChanged: true,
    previousStatusCode: request.status,
    statusCode: STATUS_ASSIGNED,
  };
}

async function synchronizeRequestOperationalStatus(trx, requestId) {
  const request = await trx('equipmentRequests')
    .where('id', requestId)
    .whereNull('deletedAt')
    .first(['status']);

  if (!request) {
    return {
      statusChanged: false,
      previousStatusCode: null,
      statusCode: null,
    };
  }

  const assignments = await trx('equipmentAssignments')
    .where('requestId', requestId)
    .where('isActive', true)
    .whereNull('deletedAt')
    .whereNotIn('statusCode', [ASSIGNMENT_STATUS_CANCELLED])
    .select(['statusCode']);

  if (assignments.length === 0) {
    return {
      statusChanged: false,
      previousStatusCode: request.status,
      statusCode: request.status,
    };
  }

  const completedCount = assignments.filter(
    (assignment) => assignment.statusCode === ASSIGNMENT_STATUS_COMPLETED
  ).length;

  const hasInOperation = assignments.some(
    (assignment) => assignment.statusCode === ASSIGNMENT_STATUS_IN_OPERATION
  );

  let nextStatusCode = request.status;

  if (completedCount === assignments.length) {
    nextStatusCode = STATUS_COMPLETED;
  } else if (completedCount > 0) {
    nextStatusCode = STATUS_PARTIALLY_COMPLETED;
  } else if (hasInOperation) {
    nextStatusCode = STATUS_IN_PROGRESS;
  } else {
    nextStatusCode = STATUS_ASSIGNED;
  }

  if (request.status === nextStatusCode) {
    return {
      statusChanged: false,
      previousStatusCode: request.status,
      statusCode: request.status,
    };
  }

  await updateRequestStatusIfAvailable(trx, requestId, nextStatusCode);

  return {
    statusChanged: true,
    previousStatusCode: request.status,
    statusCode: nextStatusCode,
  };
}

async function updateRequestStatusIfAvailable(trx, requestId, statusCode) {
  const status = await trx('equipmentRequestStatuses')
    .where('code', statusCode)
    .where('isActive', true)
    .whereNull('deletedAt')
    .first('code');

  if (!status) {
    return;
  }

  await trx('equipmentRequests').where('id', requestId).whereNull('deletedAt').update({
    status: statusCode,
    updatedAt: db.fn.now(),
  });
}

function normalizeMonitoringFilters(query = {}) {
  const startDate = query.startDate ? normalizeDate(query.startDate) : null;

  const endDate = query.endDate ? normalizeDate(query.endDate) : null;

  if (query.startDate && !startDate) {
    return {
      valid: false,
      message: 'Query startDate tidak valid.',
    };
  }

  if (query.endDate && !endDate) {
    return {
      valid: false,
      message: 'Query endDate tidak valid.',
    };
  }

  if (startDate && endDate && endDate < startDate) {
    return {
      valid: false,
      message: 'Query endDate tidak boleh lebih kecil dari startDate.',
    };
  }

  return {
    valid: true,
    companyUuid: normalizeNullableString(query.companyUuid),
    divisionUuid: normalizeNullableString(query.divisionUuid),
    startDate,
    endDate,
  };
}

function applyMonitoringFilters(
  query,
  filters,
  requestAlias = 'request',
  companyAlias = 'company',
  divisionAlias = 'division'
) {
  if (filters.companyUuid) {
    query.andWhere(`${companyAlias}.uuid`, filters.companyUuid);
  }

  if (filters.divisionUuid) {
    query.andWhere(`${divisionAlias}.uuid`, filters.divisionUuid);
  }

  if (filters.startDate) {
    query.andWhere(`${requestAlias}.endDate`, '>=', filters.startDate);
  }

  if (filters.endDate) {
    query.andWhere(`${requestAlias}.startDate`, '<=', filters.endDate);
  }
}

module.exports = router;
