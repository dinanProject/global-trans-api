'use strict';

const {
  createMenuNotifications,
  deactivateReferenceNotifications,
} = require('../menu-notification');

const MODULE_CODE = 'EQUIPMENT_REQUEST';
const APPROVAL_MENU_PERMISSION_CODE = 'EQUIPMENT_APPROVAL.VIEW';
const APPROVAL_DECISION_ACTIONS = new Set([
  'APPROVE_CLIENT',
  'APPROVE_GTSI',
  'REJECT_CLIENT',
  'REJECT_GTSI',
]);

async function enqueueRequestActionMenuNotifications(trx, { equipmentRequest, transition }) {
  if (!equipmentRequest?.id || !equipmentRequest?.uuid || !transition?.actionCode) {
    return;
  }

  const actionCode = transition.actionCode;

  if (APPROVAL_DECISION_ACTIONS.has(actionCode)) {
    await deactivateReferenceNotifications(trx, {
      moduleCode: MODULE_CODE,
      menuPermissionCode: APPROVAL_MENU_PERMISSION_CODE,
      referenceUuid: equipmentRequest.uuid,
    });
  }

  if (!['SUBMIT', 'APPROVE_CLIENT'].includes(actionCode)) {
    return;
  }

  const recipients = await findNextApproverRecipients(trx, equipmentRequest.id);

  if (recipients.length === 0) {
    return;
  }

  await createMenuNotifications(
    trx,
    recipients.map((recipient) => ({
      recipientUserId: recipient.id,
      moduleCode: MODULE_CODE,
      menuPermissionCode: APPROVAL_MENU_PERMISSION_CODE,
      referenceId: equipmentRequest.id,
      referenceUuid: equipmentRequest.uuid,
      contextCode: `APPROVAL_REQUIRED_${actionCode}`,
    }))
  );
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

  return trx('users as user')
    .join('userRoles as userRole', 'userRole.userId', 'user.id')
    .where('user.isActive', true)
    .whereNull('user.deletedAt')
    .where((builder) => {
      approvalRows.forEach((approval) => {
        builder.orWhere((rowBuilder) => {
          rowBuilder
            .where('user.companyId', approval.companyId)
            .where('userRole.roleId', approval.roleId);
        });
      });
    })
    .distinct(['user.id']);
}

module.exports = {
  enqueueRequestActionMenuNotifications,
};
