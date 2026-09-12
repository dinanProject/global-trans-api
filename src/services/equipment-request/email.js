'use strict';

const { queueTemplateEmails } = require('../email/notification');

const MODULE_CODE = 'EQUIPMENT_REQUEST';
const TEMPLATE_APPROVAL_REQUIRED = 'EQUIPMENT_REQUEST_APPROVAL_REQUIRED';
const TEMPLATE_STATUS_CHANGED = 'EQUIPMENT_REQUEST_STATUS_CHANGED';
const TEMPLATE_FINAL_DECISION = 'EQUIPMENT_REQUEST_FINAL_DECISION';
const TEMPLATE_OPERATION_READY = 'EQUIPMENT_REQUEST_OPERATION_READY';
const TEMPLATE_OPERATION_STARTED = 'EQUIPMENT_OPERATION_STARTED';
const TEMPLATE_OPERATION_COMPLETED = 'EQUIPMENT_OPERATION_COMPLETED';

const DEFAULT_FROM_NAME = process.env.MAIL_FROM_NAME || 'Global Trans Reservation';

async function enqueueRequestActionNotifications(trx, { equipmentRequest, transition, actionUserId, remarks }) {
  const requestContext = await findRequestContext(trx, equipmentRequest.id);

  if (!requestContext) {
    return;
  }

  const actionUser = actionUserId ? await findUserById(trx, actionUserId) : null;

  const currentRequest = {
    ...requestContext,
    status: transition.toStatusCode,
    statusName: transition.toStatusName || transition.toStatusCode,
  };

  const actionCode = transition.actionCode;

  /*
   * SUBMIT:
   * - Exxon approver menerima action-required email.
   * - Global Trans reviewer menerima visibility/review email, tanpa approval action.
   *
   * APPROVE_CLIENT tidak lagi mencari next GTSI approver karena Global Trans
   * bukan approval step pada flow baru.
   */
  if (actionCode === 'SUBMIT') {
    const [nextApprovers, globalReviewers] = await Promise.all([findNextApproverRecipients(trx, equipmentRequest.id), findGlobalReviewRecipients(trx)]);

    if (nextApprovers.length > 0) {
      await queueTemplateEmails(
        trx,
        nextApprovers.map((recipient) => ({
          templateCode: TEMPLATE_APPROVAL_REQUIRED,
          moduleCode: MODULE_CODE,
          referenceId: equipmentRequest.id,
          referenceUuid: equipmentRequest.uuid,
          contextCode: 'APPROVAL_REQUIRED_SUBMIT',
          contextId: equipmentRequest.id,
          recipientUserId: recipient.id,
          toEmail: recipient.email,
          payload: buildPayload({
            request: currentRequest,
            recipient,
            actionUser,
            transition,
            remarks,
          }),
          fromName: buildFromName(actionUser),
        })),
        { buildFallbackTemplate }
      );
    }

    if (globalReviewers.length > 0) {
      await queueTemplateEmails(
        trx,
        globalReviewers.map((recipient) => ({
          templateCode: TEMPLATE_STATUS_CHANGED,
          moduleCode: MODULE_CODE,
          referenceId: equipmentRequest.id,
          referenceUuid: equipmentRequest.uuid,
          contextCode: 'GLOBAL_REVIEW_VISIBILITY_SUBMIT',
          contextId: equipmentRequest.id,
          recipientUserId: recipient.id,
          toEmail: recipient.email,
          payload: buildPayload({
            request: currentRequest,
            recipient,
            actionUser,
            transition,
            remarks,
          }),
          fromName: buildFromName(actionUser),
        })),
        { buildFallbackTemplate }
      );
    }
  }

  /*
   * Requester menerima hasil perubahan status,
   * kecuali saat SUBMIT.
   */
  if (['APPROVE_CLIENT', 'REJECT_CLIENT', 'APPROVE_GTSI', 'REJECT_GTSI'].includes(actionCode)) {
    const requester = await findUserById(trx, equipmentRequest.requestBy);

    if (requester?.email) {
      await queueTemplateEmails(
        trx,
        [
          {
            templateCode: TEMPLATE_STATUS_CHANGED,
            moduleCode: MODULE_CODE,
            referenceId: equipmentRequest.id,
            referenceUuid: equipmentRequest.uuid,
            contextCode: `REQUESTER_${actionCode}`,
            contextId: equipmentRequest.id,
            recipientUserId: requester.id,
            toEmail: requester.email,
            payload: buildPayload({
              request: currentRequest,
              recipient: requester,
              actionUser,
              transition,
              remarks,
            }),
            fromName: buildFromName(actionUser),
          },
        ],
        { buildFallbackTemplate }
      );
    }
  }

  /*
   * Exxon adalah final approver. Setelah approve/reject, Global Trans reviewer
   * menerima final-decision visibility email. Tidak ada approval lanjutan.
   */
  if (actionCode === 'APPROVE_CLIENT' || actionCode === 'REJECT_CLIENT') {
    const globalReviewers = await findGlobalReviewRecipients(trx);

    if (globalReviewers.length > 0) {
      await queueTemplateEmails(
        trx,
        globalReviewers.map((recipient) => ({
          templateCode: TEMPLATE_FINAL_DECISION,
          moduleCode: MODULE_CODE,
          referenceId: equipmentRequest.id,
          referenceUuid: equipmentRequest.uuid,
          contextCode: `GLOBAL_REVIEW_${actionCode}`,
          contextId: equipmentRequest.id,
          recipientUserId: recipient.id,
          toEmail: recipient.email,
          payload: buildPayload({
            request: currentRequest,
            recipient,
            actionUser,
            transition,
            remarks,
          }),
          fromName: buildFromName(actionUser),
        })),
        { buildFallbackTemplate }
      );
    }
  }

  /*
   * Legacy safety: keep the old GTSI final-decision email path for historical
   * records only. Active transitions for these actions are disabled by migration.
   */
  if (actionCode === 'APPROVE_GTSI' || actionCode === 'REJECT_GTSI') {
    const clientApprovers = await findClientApproverRecipients(trx, equipmentRequest.id);

    if (clientApprovers.length > 0) {
      await queueTemplateEmails(
        trx,
        clientApprovers.map((recipient) => ({
          templateCode: TEMPLATE_FINAL_DECISION,
          moduleCode: MODULE_CODE,
          referenceId: equipmentRequest.id,
          referenceUuid: equipmentRequest.uuid,
          contextCode: `CLIENT_APPROVER_${actionCode}`,
          contextId: equipmentRequest.id,
          recipientUserId: recipient.id,
          toEmail: recipient.email,
          payload: buildPayload({
            request: currentRequest,
            recipient,
            actionUser,
            transition,
            remarks,
          }),
          fromName: buildFromName(actionUser),
        })),
        { buildFallbackTemplate }
      );
    }
  }
}

async function enqueueOperationNotifications(trx, { requestId, actionUserId, previousStatusCode = 'APPROVED' }) {
  const requestContext = await findRequestContext(trx, requestId);

  if (!requestContext) {
    return;
  }

  const requester = await findUserById(trx, requestContext.requestBy);

  if (!requester?.email) {
    return;
  }

  const actionUser = actionUserId ? await findUserById(trx, actionUserId) : null;

  const operations = await findOperationNotificationDetails(trx, requestId);

  if (operations.length === 0) {
    return;
  }

  const operationDetailsText = buildOperationDetailsText(operations);

  const payload = enrichPayload({
    recipientName: requester.fullName || 'User',
    recipientEmail: requester.email,
    requestNo: requestContext.requestNo,
    requestUuid: requestContext.uuid,
    companyName: requestContext.companyName || '-',
    divisionName: requestContext.divisionName || '-',
    requesterName: requestContext.requesterName || '-',
    requesterEmail: requestContext.requesterEmail || null,
    actorName: actionUser?.fullName || 'System',
    actorEmail: actionUser?.email || null,
    statusCode: 'APPROVED',
    statusName: 'Scheduled',
    actionCode: 'OPERATION_READY',
    actionName: 'Operation Ready',
    fromStatusCode: previousStatusCode,
    toStatusCode: 'APPROVED',
    remarks: '-',
    startDate: formatDateOnly(requestContext.startDate),
    endDate: formatDateOnly(requestContext.endDate),
    purpose: requestContext.purpose || '-',
    notes: requestContext.notes || '-',
    operationCount: operations.length,
    operationDetailsText,
    operationDetailsHtml: escapeHtml(operationDetailsText).replace(/\n/g, '<br>'),
    requestUrl: buildFrontendUrl('/equipment-request/requests'),
  });

  await queueTemplateEmails(
    trx,
    [
      {
        templateCode: TEMPLATE_OPERATION_READY,
        moduleCode: MODULE_CODE,
        referenceId: requestContext.id,
        referenceUuid: requestContext.uuid,
        contextCode: 'REQUESTER_OPERATION_READY',
        contextId: requestContext.id,
        recipientUserId: requester.id,
        toEmail: requester.email,
        payload,
        fromName: buildFromName(actionUser),
      },
    ],
    { buildFallbackTemplate }
  );
}

async function enqueueOperationStartedNotifications(trx, { requestId, actionUserId, previousStatusCode = 'ASSIGNED' }) {
  const requestContext = await findRequestContext(trx, requestId);

  if (!requestContext) {
    return;
  }

  const requester = await findUserById(trx, requestContext.requestBy);

  if (!requester?.email) {
    return;
  }

  const actionUser = actionUserId ? await findUserById(trx, actionUserId) : null;

  const operations = await findOperationNotificationDetails(trx, requestId);

  const startedOperations = operations.filter((operation) => operation.statusCode === 'IN_OPERATION' && operation.actualStartDate);

  if (startedOperations.length === 0) {
    return;
  }

  const operationDetailsText = buildOperationStartedDetailsText(startedOperations);

  const payload = enrichPayload({
    recipientName: requester.fullName || 'User',
    recipientEmail: requester.email,

    requestNo: requestContext.requestNo,
    requestUuid: requestContext.uuid,

    companyName: requestContext.companyName || '-',
    divisionName: requestContext.divisionName || '-',

    requesterName: requestContext.requesterName || '-',
    requesterEmail: requestContext.requesterEmail || null,

    actorName: actionUser?.fullName || 'System',
    actorEmail: actionUser?.email || null,

    statusCode: 'IN_PROGRESS',
    statusName: 'In Progress',

    actionCode: 'START_OPERATION',
    actionName: 'Start Operation',

    fromStatusCode: previousStatusCode,
    toStatusCode: 'IN_PROGRESS',

    remarks: '-',

    startDate: formatDateOnly(requestContext.startDate),
    endDate: formatDateOnly(requestContext.endDate),

    operationCount: startedOperations.length,
    operationDetailsText,
    operationDetailsHtml: escapeHtml(operationDetailsText).replace(/\n/g, '<br>'),

    requestUrl: buildFrontendUrl('/equipment-request/requests'),
  });

  await queueTemplateEmails(
    trx,
    [
      {
        templateCode: TEMPLATE_OPERATION_STARTED,
        moduleCode: MODULE_CODE,
        referenceId: requestContext.id,
        referenceUuid: requestContext.uuid,
        contextCode: 'REQUESTER_START_OPERATION',
        contextId: requestContext.id,
        recipientUserId: requester.id,
        toEmail: requester.email,
        payload,
        fromName: buildFromName(actionUser),
      },
    ],
    { buildFallbackTemplate }
  );
}

async function enqueueOperationCompletedNotifications(trx, { requestId, actionUserId, previousStatusCode = 'IN_PROGRESS' }) {
  const requestContext = await findRequestContext(trx, requestId);

  if (!requestContext) {
    return;
  }

  const requester = await findUserById(trx, requestContext.requestBy);

  if (!requester?.email) {
    return;
  }

  const actionUser = actionUserId ? await findUserById(trx, actionUserId) : null;

  const operations = await findOperationNotificationDetails(trx, requestId);

  const completedOperations = operations.filter((operation) => operation.statusCode === 'COMPLETED' && operation.actualEndDate);

  if (completedOperations.length === 0) {
    return;
  }

  const completionDetailsText = buildOperationCompletedDetailsText(completedOperations);

  const completionDetailsHtml = buildOperationCompletedDetailsHtml(completedOperations);

  const payload = enrichPayload({
    recipientName: requester.fullName || 'User',
    recipientEmail: requester.email,

    requestNo: requestContext.requestNo,
    requestUuid: requestContext.uuid,

    companyName: requestContext.companyName || '-',
    divisionName: requestContext.divisionName || '-',

    requesterName: requestContext.requesterName || '-',
    requesterEmail: requestContext.requesterEmail || null,

    actorName: actionUser?.fullName || 'System',
    actorEmail: actionUser?.email || null,

    statusCode: 'COMPLETED',
    statusName: 'Completed',

    actionCode: 'COMPLETE',
    actionName: 'Complete Operation',

    fromStatusCode: previousStatusCode,
    toStatusCode: 'COMPLETED',

    remarks: '-',

    startDate: formatDateOnly(requestContext.startDate),
    endDate: formatDateOnly(requestContext.endDate),

    completionCount: completedOperations.length,
    overallSlaStatus: getOverallCompletionSlaStatus(completedOperations),

    completionDetailsText,
    completionDetailsHtml,

    requestUrl: buildFrontendUrl('/equipment-request/requests'),
  });

  await queueTemplateEmails(
    trx,
    [
      {
        templateCode: TEMPLATE_OPERATION_COMPLETED,
        moduleCode: MODULE_CODE,
        referenceId: requestContext.id,
        referenceUuid: requestContext.uuid,
        contextCode: 'REQUESTER_COMPLETE_OPERATION',
        contextId: requestContext.id,
        recipientUserId: requester.id,
        toEmail: requester.email,
        payload,
        fromName: buildFromName(actionUser),
      },
    ],
    { buildFallbackTemplate }
  );
}

async function findRequestContext(trx, requestId) {
  const request = await trx('equipmentRequests as request')
    .leftJoin('companies as company', 'company.id', 'request.companyId')
    .leftJoin('divisions as division', 'division.id', 'request.divisionId')
    .leftJoin('users as requester', 'requester.id', 'request.requestBy')
    .leftJoin('equipmentRequestStatuses as status', function () {
      this.on('status.code', '=', 'request.status').andOnVal('status.isActive', '=', 1).andOnNull('status.deletedAt');
    })
    .where('request.id', requestId)
    .whereNull('request.deletedAt')
    .first([
      'request.id',
      'request.uuid',
      'request.requestNo',
      'request.companyId',
      'company.code as companyCode',
      'company.name as companyName',
      'request.divisionId',
      'division.code as divisionCode',
      'division.name as divisionName',
      'request.requestBy',
      'requester.fullName as requesterName',
      'requester.email as requesterEmail',
      'request.requestDate',
      'request.startDate',
      'request.endDate',
      'request.purpose',
      'request.notes',
      'request.status',
      'status.name as statusName',
      'request.currentApprovalLevel',
    ]);

  if (!request) {
    return null;
  }

  const details = await trx('equipmentRequestDetails as detail')
    .leftJoin('equipmentCategories as category', 'category.id', 'detail.equipmentCategoryId')
    .leftJoin('equipmentUnits as unit', 'unit.id', 'detail.equipmentUnitId')
    .where('detail.requestId', request.id)
    .where('detail.isActive', true)
    .whereNull('detail.deletedAt')
    .select([
      'detail.quantity',
      'detail.rate',
      'detail.remarks',
      'category.code as categoryCode',
      'category.name as categoryName',
      'unit.unitCode',
      'unit.unitName',
    ]);

  return {
    ...request,
    details,
  };
}

async function findOperationNotificationDetails(trx, requestId) {
  return trx('equipmentOperations as operation')
    .join('equipmentRequestDetails as detail', 'detail.id', 'operation.requestDetailId')
    .join('equipmentUnits as unit', 'unit.id', 'operation.equipmentUnitId')
    .leftJoin('equipmentCategories as category', 'category.id', 'detail.equipmentCategoryId')
    .where('operation.requestId', requestId)
    .where('operation.isActive', true)
    .whereNull('operation.deletedAt')
    .whereNotIn('operation.statusCode', ['REPLACED', 'CANCELLED'])
    .select([
      'operation.uuid',
      'operation.statusCode',
      'operation.plannedStartDate',
      'operation.plannedEndDate',
      'operation.actualStartDate',
      'operation.actualEndDate',
      'operation.notes',
      'category.code as categoryCode',
      'category.name as categoryName',
      'unit.unitCode',
      'unit.unitName',
      'unit.assetNumber',
    ])
    .orderBy([
      {
        column: 'detail.id',
        order: 'asc',
      },
      {
        column: 'operation.id',
        order: 'asc',
      },
    ]);
}

async function findNextApproverRecipients(trx, requestId) {
  const nextApproval = await trx('equipmentRequestApprovals')
    .where('requestId', requestId)
    .where('status', 'PENDING')
    .where('isActive', true)
    .whereNull('deletedAt')
    .orderBy('approvalLevel', 'asc')
    .first(['approvalLevel']);

  if (!nextApproval) {
    return [];
  }

  const approvalRows = await trx('equipmentRequestApprovals')
    .where('requestId', requestId)
    .where('approvalLevel', nextApproval.approvalLevel)
    .where('status', 'PENDING')
    .where('isActive', true)
    .whereNull('deletedAt')
    .select(['companyId', 'roleId']);

  if (approvalRows.length === 0) {
    return [];
  }

  const recipientQuery = trx('users as user')
    .join('userRoles as userRole', function () {
      this.on('userRole.userId', '=', 'user.id');
    })
    .where('user.isActive', true)
    .whereNull('user.deletedAt')
    .whereNotNull('user.email')
    .where((builder) => {
      approvalRows.forEach((approval) => {
        builder.orWhere((rowBuilder) => {
          rowBuilder.where('user.companyId', approval.companyId).where('userRole.roleId', approval.roleId);
        });
      });
    })
    .distinct(['user.id', 'user.uuid', 'user.fullName', 'user.email', 'user.companyId']);

  return recipientQuery;
}

async function findGlobalReviewRecipients(trx) {
  return trx('users as user')
    .join('companies as company', function () {
      this.on('company.id', '=', 'user.companyId').andOnNull('company.deletedAt');
    })
    .join('userRoles as userRole', 'userRole.userId', 'user.id')
    .join('roles as role', 'role.id', 'userRole.roleId')
    .join('rolePermissions as rolePermission', 'rolePermission.roleId', 'role.id')
    .join('permissions as permission', 'permission.permissionId', 'rolePermission.permissionId')
    .where('user.isActive', true)
    .whereNull('user.deletedAt')
    .whereNotNull('user.email')
    .where('company.isActive', true)
    .where('company.type', 1)
    .where('role.isActive', true)
    .where('permission.isActive', true)
    .where('permission.code', 'EQUIPMENT_APPROVAL.VIEW')
    .distinct(['user.id', 'user.uuid', 'user.fullName', 'user.email', 'user.companyId']);
}

async function findClientApproverRecipients(trx, requestId) {
  const clientApproval = await trx('equipmentRequestApprovals')
    .where('requestId', requestId)
    .where('approvalLevel', 1)
    .where('isActive', true)
    .whereNull('deletedAt')
    .first(['companyId', 'roleId']);

  if (!clientApproval) {
    return [];
  }

  return trx('users as user')
    .join('userRoles as userRole', 'userRole.userId', 'user.id')
    .where('user.companyId', clientApproval.companyId)
    .where('userRole.roleId', clientApproval.roleId)
    .where('user.isActive', true)
    .whereNull('user.deletedAt')
    .whereNotNull('user.email')
    .distinct(['user.id', 'user.uuid', 'user.fullName', 'user.email', 'user.companyId']);
}

async function findUserById(trx, userId) {
  if (!userId) {
    return null;
  }

  return trx('users').where('id', userId).whereNull('deletedAt').first(['id', 'uuid', 'fullName', 'email', 'companyId']);
}

function buildPayload({ request, recipient, actionUser, transition, remarks }) {
  const detailsText = buildDetailsText(request.details || []);

  return enrichPayload({
    recipientName: recipient?.fullName || 'User',
    recipientEmail: recipient?.email || null,
    requestNo: request.requestNo,
    requestUuid: request.uuid,
    companyName: request.companyName || '-',
    divisionName: request.divisionName || '-',
    requesterName: request.requesterName || '-',
    requesterEmail: request.requesterEmail || null,
    actorName: actionUser?.fullName || 'System',
    actorEmail: actionUser?.email || null,
    statusCode: request.status,
    statusName: request.statusName || request.status,
    actionCode: transition.actionCode,
    actionName: transition.actionName || transition.actionCode,
    fromStatusCode: transition.fromStatusCode,
    toStatusCode: transition.toStatusCode,
    remarks: remarks || '-',
    startDate: formatDateOnly(request.startDate),
    endDate: formatDateOnly(request.endDate),
    purpose: request.purpose || '-',
    notes: request.notes || '-',
    detailsText,
    detailsHtml: escapeHtml(detailsText).replace(/\n/g, '<br>'),
    approvalUrl: buildFrontendUrl('/equipment-request/approvals'),
    requestUrl: buildFrontendUrl('/equipment-request/requests'),
  });
}

function buildFrontendUrl(path) {
  const baseUrl = (process.env.APP_URL || process.env.FRONTEND_URL || process.env.APP_FRONTEND_URL || '').replace(/\/$/, '');

  if (!path) return baseUrl;
  if (/^https?:\/\//i.test(path)) return path;

  return baseUrl ? `${baseUrl}${path.startsWith('/') ? path : `/${path}`}` : path;
}

function enrichPayload(rawPayload = {}) {
  return {
    brandName: process.env.MAIL_COMPANY_NAME || 'PT Global Trans Servindo',
    brandLogoUrl: process.env.MAIL_LOGO_URL || '',
    supportEmail: process.env.MAIL_SUPPORT_EMAIL || 'support@globaltransgroup.id',
    currentYear: new Date().getFullYear(),

    approvalUrl: rawPayload.approvalUrl || buildFrontendUrl('/equipment-request/approvals'),

    requestUrl: rawPayload.requestUrl || buildFrontendUrl('/equipment-request/requests'),

    ...rawPayload,
  };
}

function buildDetailsText(details) {
  if (!details.length) {
    return '-';
  }

  return details
    .map((detail, index) => {
      const name = detail.categoryName || detail.unitName || 'Equipment';
      const unit = detail.unitName ? ` - ${detail.unitName}` : '';
      const quantity = detail.quantity ? ` x ${detail.quantity}` : '';

      return `${index + 1}. ${name}${unit}${quantity}`;
    })
    .join('\n');
}

function buildOperationDetailsText(operations) {
  if (!operations.length) {
    return '-';
  }

  return operations
    .map((operation, index) => {
      const equipmentName = operation.unitName || operation.categoryName || 'Equipment';

      const equipmentCode = operation.unitCode || operation.categoryCode || '-';

      const assetNumber = operation.assetNumber ? ` | Asset: ${operation.assetNumber}` : '';

      const period = `${formatDateOnly(operation.plannedStartDate)} sampai ${formatDateOnly(operation.plannedEndDate)}`;

      return [`${index + 1}. ${equipmentCode} - ${equipmentName}${assetNumber}`, `   Planned: ${period}`].join('\n');
    })
    .join('\n');
}

function buildOperationStartedDetailsText(operations) {
  if (!operations.length) {
    return '-';
  }

  return operations
    .map((operation, index) => {
      const equipmentName = operation.unitName || operation.categoryName || 'Equipment';

      const equipmentCode = operation.unitCode || operation.categoryCode || '-';

      const assetNumber = operation.assetNumber ? ` | Asset: ${operation.assetNumber}` : '';

      return [
        `${index + 1}. ${equipmentCode} - ${equipmentName}${assetNumber}`,
        `   Planned Start: ${formatDateOnly(operation.plannedStartDate)}`,
        `   Actual Start : ${formatDateTime(operation.actualStartDate)}`,
        `   Planned End  : ${formatDateOnly(operation.plannedEndDate)}`,
        `   SLA Status   : ${getStartSlaStatus(operation)}`,
      ].join('\n');
    })
    .join('\n');
}

function buildOperationCompletedDetailsText(operations) {
  if (!operations.length) {
    return '-';
  }

  return operations
    .map((operation, index) => {
      const equipmentName = operation.unitName || operation.categoryName || 'Equipment';

      const equipmentCode = operation.unitCode || operation.categoryCode || '-';

      const assetNumber = operation.assetNumber ? ` | Asset: ${operation.assetNumber}` : '';

      return [
        `${index + 1}. ${equipmentCode} - ${equipmentName}${assetNumber}`,
        `   Planned Start: ${formatDateOnly(operation.plannedStartDate)}`,
        `   Actual Start : ${formatDateTime(operation.actualStartDate)}`,
        `   Planned End  : ${formatDateOnly(operation.plannedEndDate)}`,
        `   Actual End   : ${formatDateTime(operation.actualEndDate)}`,
        `   SLA Status   : ${getCompletionSlaStatus(operation)}`,
      ].join('\n');
    })
    .join('\n');
}

function getStartSlaStatus(operation) {
  if (!operation.actualStartDate) {
    return 'Not Started';
  }

  if (!operation.plannedStartDate) {
    return 'Started';
  }

  const actualStartDate = formatDateOnly(operation.actualStartDate);
  const plannedStartDate = formatDateOnly(operation.plannedStartDate);
  return actualStartDate <= plannedStartDate ? 'On Time Start' : 'Late Start';
}

function buildOperationCompletedDetailsHtml(operations) {
  if (!operations.length) {
    return '-';
  }

  return operations
    .map((operation, index) => {
      const equipmentName = operation.unitName || operation.categoryName || 'Equipment';

      const equipmentCode = operation.unitCode || operation.categoryCode || '-';

      const assetNumber = operation.assetNumber || '-';
      const slaStatus = getCompletionSlaStatus(operation);

      return `
        <div style="margin-bottom:12px;padding:14px 16px;border:1px solid #e2e8f0;border-radius:8px;background:#ffffff;">
          <div style="margin-bottom:10px;font-size:13px;font-weight:700;color:#334155;">
            ${index + 1}. ${escapeHtml(equipmentCode)} - ${escapeHtml(equipmentName)}
          </div>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12px;line-height:1.6;color:#475569;">
            <tr>
              <td style="width:120px;padding:2px 0;color:#64748b;">Asset</td>
              <td style="padding:2px 0;font-weight:600;color:#334155;">${escapeHtml(assetNumber)}</td>
            </tr>
            <tr>
              <td style="padding:2px 0;color:#64748b;">Planned Start</td>
              <td style="padding:2px 0;">${escapeHtml(formatDateOnly(operation.plannedStartDate))}</td>
            </tr>
            <tr>
              <td style="padding:2px 0;color:#64748b;">Actual Start</td>
              <td style="padding:2px 0;">${escapeHtml(formatDateTime(operation.actualStartDate))}</td>
            </tr>
            <tr>
              <td style="padding:2px 0;color:#64748b;">Planned End</td>
              <td style="padding:2px 0;">${escapeHtml(formatDateOnly(operation.plannedEndDate))}</td>
            </tr>
            <tr>
              <td style="padding:2px 0;color:#64748b;">Actual End</td>
              <td style="padding:2px 0;">${escapeHtml(formatDateTime(operation.actualEndDate))}</td>
            </tr>
            <tr>
              <td style="padding:2px 0;color:#64748b;">SLA Status</td>
              <td style="padding:2px 0;font-weight:700;color:${slaStatus === 'Completed On Time' ? '#4f8a68' : '#b7791f'};">
                ${escapeHtml(slaStatus)}
              </td>
            </tr>
          </table>
        </div>
      `;
    })
    .join('');
}

function getCompletionSlaStatus(operation) {
  if (!operation.actualEndDate) {
    return 'Not Completed';
  }

  if (!operation.plannedEndDate) {
    return 'Completed';
  }

  const actualEndDate = formatDateOnly(operation.actualEndDate);

  const plannedEndDate = formatDateOnly(operation.plannedEndDate);

  return actualEndDate <= plannedEndDate ? 'Completed On Time' : 'Completed Late';
}

function getOverallCompletionSlaStatus(operations) {
  if (!operations.length) {
    return '-';
  }

  const hasLateCompletion = operations.some((operation) => getCompletionSlaStatus(operation) === 'Completed Late');

  return hasLateCompletion ? 'Completed Late' : 'Completed On Time';
}

function buildFromName(actionUser) {
  if (!actionUser?.fullName) {
    return DEFAULT_FROM_NAME;
  }

  return `${actionUser.fullName} via Global Trans`;
}

function buildFallbackTemplate(templateCode, payload) {
  if (templateCode === TEMPLATE_APPROVAL_REQUIRED) {
    return {
      subject: `Approval required: ${payload.requestNo}`,
      html: `<!doctype html><html><body><p>Halo {{recipientName}},</p><p>Equipment request <strong>{{requestNo}}</strong> dari {{companyName}} menunggu approval Anda.</p><p>Status saat ini: <strong>{{statusCode}}</strong></p><p>Periode: {{startDate}} sampai {{endDate}}</p><p>Detail:<br>{{detailsHtml}}</p><p><a href="{{approvalUrl}}">Buka halaman approval</a></p></body></html>`,
      text: `Halo {{recipientName}}, equipment request {{requestNo}} dari {{companyName}} menunggu approval Anda. Status: {{statusCode}}. Periode: {{startDate}} sampai {{endDate}}. Buka: {{approvalUrl}}`,
    };
  }

  if (templateCode === TEMPLATE_FINAL_DECISION) {
    return {
      subject: `Final decision: ${payload.requestNo} is ${payload.statusName}`,
      html: `<!doctype html><html><body><p>Halo {{recipientName}},</p><p>Equipment request <strong>{{requestNo}}</strong> yang sebelumnya Anda review telah mendapat keputusan final dari Global Trans.</p><p>Status akhir: <strong>{{statusName}}</strong></p><p>Action: {{actionName}}</p><p>Processed By: {{actorName}}</p><p>Periode: {{startDate}} sampai {{endDate}}</p><p>Email ini bersifat informasional dan tidak memerlukan tindakan lanjutan dari Anda.</p></body></html>`,
      text: `Halo {{recipientName}}, equipment request {{requestNo}} yang sebelumnya Anda review telah mendapat keputusan final dari Global Trans. Status akhir: {{statusName}}. Action: {{actionName}}. Processed By: {{actorName}}. Periode: {{startDate}} sampai {{endDate}}. Email ini bersifat informasional dan tidak memerlukan tindakan lanjutan dari Anda.`,
    };
  }

  if (templateCode === TEMPLATE_OPERATION_READY) {
    return {
      subject: `Operation scheduled: ${payload.requestNo}`,
      html: `<!doctype html>
<html>
  <body>
    <p>Halo {{recipientName}},</p>

    <p>
      Equipment untuk request
      <strong>{{requestNo}}</strong>
      telah dijadwalkan untuk operasi.
    </p>

    <p>
      Company: {{companyName}}<br>
      Division: {{divisionName}}<br>
      Status: <strong>{{statusName}}</strong><br>
      Planned Period: {{startDate}} sampai {{endDate}}
    </p>

    <p>
      Equipment Operation:<br>
      {{operationDetailsHtml}}
    </p>

    <p>
      <a href="{{requestUrl}}">
        Buka halaman request
      </a>
    </p>
  </body>
</html>`,
      text: `Halo {{recipientName}},

Equipment untuk request {{requestNo}} telah dijadwalkan untuk operasi.

Company: {{companyName}}
Division: {{divisionName}}
Status: {{statusName}}
Planned Period: {{startDate}} sampai {{endDate}}

Equipment Operation:
{{operationDetailsText}}

Buka halaman request:
{{requestUrl}}`,
    };
  }

  if (templateCode === TEMPLATE_OPERATION_STARTED) {
    return {
      subject: `Operation started: ${payload.requestNo}`,
      html: `<!doctype html>
<html>
  <body>
    <p>Halo {{recipientName}},</p>

    <p>
      Operasi equipment untuk request
      <strong>{{requestNo}}</strong>
      telah dimulai.
    </p>

    <p>
      Company: {{companyName}}<br>
      Division: {{divisionName}}<br>
      Status: <strong>{{statusName}}</strong><br>
      Periode: {{startDate}} sampai {{endDate}}<br>
      Started By: {{actorName}}
    </p>

    <p>
      Detail Operation:<br>
      {{operationDetailsHtml}}
    </p>

    <p>
      <a href="{{requestUrl}}">
        Buka halaman request
      </a>
    </p>
  </body>
</html>`,
      text: `Halo {{recipientName}},

Operasi equipment untuk request {{requestNo}} telah dimulai.

Company: {{companyName}}
Division: {{divisionName}}
Status: {{statusName}}
Periode: {{startDate}} sampai {{endDate}}
Started By: {{actorName}}

Detail Operation:
{{operationDetailsText}}

Buka halaman request:
{{requestUrl}}`,
    };
  }

  if (templateCode === TEMPLATE_OPERATION_COMPLETED) {
    return {
      subject: `Operation completed: ${payload.requestNo}`,

      html: `<!doctype html>
<html>
  <body>
    <p>Halo {{recipientName}},</p>

    <p>
      Seluruh operasi equipment untuk request
      <strong>{{requestNo}}</strong>
      telah selesai.
    </p>

    <p>
      Company: {{companyName}}<br>
      Division: {{divisionName}}<br>
      Status: <strong>{{statusName}}</strong><br>
      Period: {{startDate}} sampai {{endDate}}<br>
      Completed By: {{actorName}}<br>
      Overall SLA: <strong>{{overallSlaStatus}}</strong>
    </p>

    <p>
      Completion Detail:<br>
      {{completionDetailsHtml}}
    </p>

    <p>
      <a href="{{requestUrl}}">
        Buka halaman request
      </a>
    </p>
  </body>
</html>`,

      text: `Halo {{recipientName}},

Seluruh operasi equipment untuk request {{requestNo}} telah selesai.

Company: {{companyName}}
Division: {{divisionName}}
Status: {{statusName}}
Period: {{startDate}} sampai {{endDate}}
Completed By: {{actorName}}
Overall SLA: {{overallSlaStatus}}

Completion Detail:
{{completionDetailsText}}

Buka halaman request:
{{requestUrl}}`,
    };
  }

  return {
    subject: `Equipment request updated: ${payload.requestNo}`,
    html: `<!doctype html><html><body><p>Halo {{recipientName}},</p><p>Status equipment request <strong>{{requestNo}}</strong> berubah menjadi <strong>{{statusCode}}</strong>.</p><p>Action: {{actionName}}</p><p><a href="{{requestUrl}}">Buka halaman request</a></p></body></html>`,
    text: `Halo {{recipientName}}, status equipment request {{requestNo}} berubah menjadi {{statusCode}}. Action: {{actionName}}. Buka: {{requestUrl}}`,
  };
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatDateOnly(value) {
  if (!value) {
    return '-';
  }

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  return String(value).slice(0, 10);
}

function formatDateTime(value) {
  if (!value) {
    return '-';
  }

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat('id-ID', {
    timeZone: process.env.APP_TIMEZONE || 'Asia/Jakarta',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

module.exports = {
  enqueueRequestActionNotifications,
  enqueueOperationNotifications,
  enqueueOperationStartedNotifications,
  enqueueOperationCompletedNotifications,
};
