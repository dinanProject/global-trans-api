'use strict';

const express = require('express');
const router = express.Router();

const { authenticate: authentication, authorize: authorization } = require('../../modules/access/access.middleware');
const db = require('../../lib/db')();
const { buildXlsx } = require('../../services/equipment-request/report-xlsx');

const HOLDER_COMPANY_TYPE = 1;
const REMINDER_DAYS = Number(process.env.EQUIPMENT_OPERATION_REMINDER_DAYS || 3);

router.use(authentication);

router.get('/filters', authorization('EQUIPMENT_REPORT.VIEW'), async (req, res) => {
  try {
    const access = await getRequestAccess(req);

    const companyQuery = db('companies as company')
      .select(['company.id', 'company.uuid', 'company.code', 'company.name'])
      .where('company.isActive', 1)
      .whereNull('company.deletedAt');

    if (!isHolderAccess(access)) {
      if (!access.company?.id) companyQuery.whereRaw('1 = 0');
      else companyQuery.where('company.id', access.company.id);
    }

    const divisionQuery = db('divisions as division')
      .join('companies as company', 'company.id', 'division.companyId')
      .select(['division.id', 'division.uuid', 'division.code', 'division.name', 'company.uuid as companyUuid'])
      .where('division.isActive', 1)
      .whereNull('division.deletedAt')
      .whereNull('company.deletedAt');

    if (!isHolderAccess(access)) {
      if (!access.company?.id) divisionQuery.whereRaw('1 = 0');
      else divisionQuery.where('division.companyId', access.company.id);
    }

    const [companies, divisions, categories, statuses] = await Promise.all([
      companyQuery.orderBy('company.name', 'asc'),
      divisionQuery.orderBy('division.name', 'asc'),
      db('equipmentCategories as category')
        .select(['category.id', 'category.uuid', 'category.code', 'category.name'])
        .where('category.isActive', 1)
        .whereNull('category.deletedAt')
        .orderBy('category.name', 'asc'),
      db('equipmentRequestStatuses as status')
        .select(['status.code', 'status.name', 'status.sortOrder'])
        .where('status.isActive', 1)
        .whereNull('status.deletedAt')
        .orderBy('status.sortOrder', 'asc'),
    ]);

    return res.success({ companies, divisions, categories, statuses });
  } catch (error) {
    console.error('GET /equipment-request/report/filters error:', error);
    return res.fail(error.message || 'Failed to load report filters.');
  }
});

router.get('/export', authorization('EQUIPMENT_REPORT.VIEW'), async (req, res) => {
  try {
    const access = await getRequestAccess(req);
    const filters = normalizeFilters(req.query);
    const validation = validateFilters(filters);
    if (!validation.valid) return res.incomplete(validation.message);

    const query = db('equipmentRequestDetails as detail')
      .join('equipmentRequests as request', function () {
        this.on('request.id', '=', 'detail.requestId').andOnNull('request.deletedAt');
      })
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
        this.on('requestStatus.code', '=', 'request.status').andOnNull('requestStatus.deletedAt');
      })
      .leftJoin('equipmentCategories as category', function () {
        this.on('category.id', '=', 'detail.equipmentCategoryId').andOnNull('category.deletedAt');
      })
      .leftJoin('equipmentUnits as unit', function () {
        this.on('unit.id', '=', 'detail.equipmentUnitId').andOnNull('unit.deletedAt');
      })
      .leftJoin('equipmentOperations as operation', function () {
        this.on('operation.requestDetailId', '=', 'detail.id').andOnVal('operation.isActive', '=', 1).andOnNull('operation.deletedAt');
      })
      .select([
        'request.id as requestId',
        'request.requestNo',
        'request.requestDate',
        'request.startDate as requestStartDate',
        'request.endDate as requestEndDate',
        'request.status as requestStatusCode',
        'requestStatus.name as requestStatusName',
        'request.notes as requestNotes',
        'company.name as companyName',
        'division.name as divisionName',
        'requester.fullName as requesterName',
        'category.name as equipmentCategoryName',
        'unit.unitCode',
        'unit.unitName',
        'detail.requiredCapacityValue',
        'detail.requiredCapacityUnit',
        'detail.remarks as detailRemarks',
        'operation.statusCode as operationStatusCode',
        'operation.plannedStartDate',
        'operation.plannedEndDate',
        'operation.actualEndDate',
      ])
      .where('detail.isActive', 1)
      .whereNull('detail.deletedAt');

    applyRequestScope(query, access, 'request');

    if (filters.startDate) query.andWhere('request.requestDate', '>=', `${filters.startDate} 00:00:00`);
    if (filters.endDate) query.andWhere('request.requestDate', '<=', `${filters.endDate} 23:59:59`);
    if (filters.companyUuid) query.andWhere('company.uuid', filters.companyUuid);
    if (filters.divisionUuid) query.andWhere('division.uuid', filters.divisionUuid);
    if (filters.status) query.andWhere('request.status', filters.status);
    if (filters.categoryUuid) query.andWhere('category.uuid', filters.categoryUuid);

    const records = await query.orderBy([
      { column: 'request.requestDate', order: 'desc' },
      { column: 'request.requestNo', order: 'asc' },
      { column: 'detail.id', order: 'asc' },
    ]);

    const requestIds = [...new Set(records.map((record) => Number(record.requestId)).filter(Boolean))];
    const approvals = requestIds.length
      ? await db('equipmentRequestApprovals as approval')
          .leftJoin('users as approvalUser', function () {
            this.on('approvalUser.id', '=', 'approval.userId').andOnNull('approvalUser.deletedAt');
          })
          .select(['approval.requestId', 'approval.actionDate', 'approvalUser.fullName as approvedByName'])
          .whereIn('approval.requestId', requestIds)
          .where('approval.approvalLevel', 1)
          .where('approval.status', 'APPROVED')
          .whereNull('approval.deletedAt')
          .orderBy('approval.actionDate', 'desc')
      : [];

    const approvalByRequestId = new Map();
    approvals.forEach((approval) => {
      const key = Number(approval.requestId);
      if (!approvalByRequestId.has(key)) approvalByRequestId.set(key, approval);
    });

    const now = new Date();
    const rows = records.map((record) => {
      const approval = approvalByRequestId.get(Number(record.requestId));
      const plannedStart = record.plannedStartDate || record.requestStartDate;
      const plannedEnd = record.plannedEndDate || record.requestEndDate;
      return [
        record.requestNo || '',
        formatDateTime(record.requestDate),
        record.companyName || '',
        record.divisionName || '',
        record.requesterName || '',
        record.equipmentCategoryName || '',
        record.unitCode || '',
        record.unitName || '',
        formatLiftingEstimation(record.requiredCapacityValue, record.requiredCapacityUnit),
        formatDateTime(plannedStart),
        formatDateTime(plannedEnd),
        deriveOperationalStatus(record, now),
        approval?.approvedByName || '',
        formatDateTime(approval?.actionDate),
        formatDateTime(record.actualEndDate),
        record.detailRemarks || record.requestNotes || '',
      ];
    });

    const headers = [
      'Request No',
      'Request Date',
      'Company',
      'Division',
      'Requester',
      'Equipment Category',
      'Unit Code',
      'Unit Name',
      'Lifting Estimation',
      'Planned Start',
      'Planned End',
      'Current / Operational Status',
      'Exxon Approved By',
      'Exxon Approval Date',
      'Completion Date',
      'Remarks',
    ];

    const workbook = buildXlsx({
      title: 'Global Trans - Equipment Request Report',
      subtitle: buildSubtitle(filters, rows.length),
      headers,
      rows,
      columnWidths: [22, 20, 24, 20, 22, 24, 14, 28, 18, 20, 20, 25, 22, 20, 20, 36],
    });

    const filename = `equipment-request-report-${fileTimestamp(new Date())}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=\"${filename}\"`);
    res.setHeader('Content-Length', workbook.length);
    return res.send(workbook);
  } catch (error) {
    console.error('GET /equipment-request/report/export error:', error);
    return res.fail(error.message || 'Failed to export equipment request report.');
  }
});

function normalizeFilters(query = {}) {
  return {
    startDate: normalizeDate(query.startDate),
    endDate: normalizeDate(query.endDate),
    companyUuid: normalizeString(query.companyUuid),
    divisionUuid: normalizeString(query.divisionUuid),
    status: normalizeString(query.status)?.toUpperCase() || null,
    categoryUuid: normalizeString(query.categoryUuid),
  };
}

function validateFilters(filters) {
  if (filters.startDate && filters.endDate && filters.startDate > filters.endDate) {
    return { valid: false, message: 'Request Date To tidak boleh lebih kecil dari Request Date From.' };
  }
  return { valid: true };
}

function deriveOperationalStatus(record, now) {
  const requestCode = String(record.requestStatusCode || '').toUpperCase();
  const operationCode = String(record.operationStatusCode || '').toUpperCase();

  if (operationCode === 'COMPLETED' || requestCode === 'COMPLETED') return 'Completed';
  if (requestCode === 'REJECTED') return 'Rejected';
  if (requestCode === 'DRAFT') return 'Draft';
  if (requestCode === 'CLIENT_REVIEW') return 'Exxon Approval';

  if (['APPROVED', 'ASSIGNED', 'IN_PROGRESS', 'PARTIALLY_COMPLETED'].includes(requestCode)) {
    const plannedStart = toDate(record.plannedStartDate || record.requestStartDate);
    const plannedEnd = toDate(record.plannedEndDate || record.requestEndDate);
    if (!plannedStart || !plannedEnd) return 'Approved / Authorized';
    if (now > plannedEnd) return 'Attention / Overdue';
    if (now >= plannedStart) return 'In Operation';
    const reminderMs = REMINDER_DAYS * 24 * 60 * 60 * 1000;
    if (plannedStart.getTime() - now.getTime() <= reminderMs) return 'Starting Soon';
    return 'Scheduled';
  }

  return record.requestStatusName || requestCode || '';
}

function buildSubtitle(filters, rowCount) {
  const range = filters.startDate || filters.endDate ? `Request Date: ${filters.startDate || 'Any'} to ${filters.endDate || 'Any'}` : 'Request Date: All';
  return `${range} | ${rowCount} row(s) | Generated ${formatDateTime(new Date())}`;
}

function formatLiftingEstimation(value, unit) {
  if (value === null || value === undefined || value === '') return '';
  const number = Number(value);
  const formatted = Number.isFinite(number) ? String(number) : String(value);
  return `${formatted}${unit ? ` ${String(unit).toUpperCase()}` : ''}`;
}

function formatDateTime(value) {
  const date = toDate(value);
  if (!date) return '';
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

function fileTimestamp(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${min}`;
}

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeString(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeDate(value) {
  const normalized = normalizeString(value);
  if (!normalized) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null;
}

function applyRequestScope(query, access, alias = 'request') {
  if (isHolderAccess(access)) return query;
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
  const userId = Number(rawUser.id || rawUser.userId || rawAccess.userId || requestData.userId || requestData.id);
  if (!userId) throw new Error('Authenticated user access was not found.');

  const existingCompany = rawAccess.company || requestData.company || {};
  const existingCompanyId = Number(existingCompany.id || existingCompany.companyId || rawAccess.companyId || requestData.companyId);
  const existingCompanyType = existingCompany.type === null || existingCompany.type === undefined ? null : Number(existingCompany.type);

  if (existingCompanyId && existingCompanyType !== null) {
    return {
      ...rawAccess,
      user: { ...rawUser, id: userId },
      company: { ...existingCompany, id: existingCompanyId, type: existingCompanyType },
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

  if (!userCompany) throw new Error('Authenticated user was not found.');

  return {
    ...rawAccess,
    user: { ...rawUser, id: userId },
    company: userCompany.companyId
      ? {
          ...existingCompany,
          id: Number(userCompany.companyId),
          uuid: userCompany.companyUuid,
          code: userCompany.companyCode,
          name: userCompany.companyName,
          type: userCompany.companyType === null || userCompany.companyType === undefined ? null : Number(userCompany.companyType),
        }
      : null,
  };
}

module.exports = router;
