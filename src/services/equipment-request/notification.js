'use strict';

const { createMenuNotifications, deactivateReferenceNotifications } = require('../menu-notification');

const MODULE_CODE = 'EQUIPMENT_REQUEST';
const HOLDER_COMPANY_TYPE = 1;
const APPROVAL_MENU_PERMISSION_CODE = 'EQUIPMENT_APPROVAL.VIEW';
const OPERATIONS_MENU_PERMISSION_CODE = 'EQUIPMENT_OPERATION.VIEW';
const OPERATIONS_MENU_ROUTES = [
  '/equipment-request/operations',
  '/main/equipment-request/operations',
  'equipment-request/operations',
  'main/equipment-request/operations',
];
const APPROVAL_DECISION_ACTIONS = new Set(['REJECT_CLIENT']);

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

  if (actionCode === 'APPROVE_CLIENT') {
    const operationMenuCode = await findOperationMenuCode(trx);
    const recipients = await findOperationRecipients(trx);

    if (operationMenuCode && recipients.length > 0) {
      await createMenuNotifications(
        trx,
        recipients.map((recipient) => ({
          recipientUserId: recipient.id,
          moduleCode: MODULE_CODE,
          menuCode: operationMenuCode,
          menuPermissionCode: OPERATIONS_MENU_PERMISSION_CODE,
          referenceId: equipmentRequest.id,
          referenceUuid: equipmentRequest.uuid,
          contextCode: 'OPERATIONS_READY_APPROVED',
        }))
      );
    }

    return;
  }

  if (actionCode !== 'SUBMIT') {
    return;
  }

  const [approvers, globalReviewers] = await Promise.all([findNextApproverRecipients(trx, equipmentRequest.id), findGlobalReviewRecipients(trx)]);
  const recipientsById = new Map();

  approvers.forEach((recipient) => {
    recipientsById.set(Number(recipient.id), {
      ...recipient,
      contextCode: 'APPROVAL_REQUIRED_SUBMIT',
    });
  });

  globalReviewers.forEach((recipient) => {
    if (!recipientsById.has(Number(recipient.id))) {
      recipientsById.set(Number(recipient.id), {
        ...recipient,
        contextCode: 'GLOBAL_REVIEW_VISIBILITY_SUBMIT',
      });
    }
  });

  const recipients = [...recipientsById.values()];

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
      contextCode: recipient.contextCode,
    }))
  );
}

async function deactivateOperationMenuNotifications(trx, equipmentRequest) {
  if (!equipmentRequest?.uuid) {
    return 0;
  }

  const operationMenuCode = await findOperationMenuCode(trx);

  if (!operationMenuCode) {
    return 0;
  }

  return deactivateReferenceNotifications(trx, {
    moduleCode: MODULE_CODE,
    menuCode: operationMenuCode,
    referenceUuid: equipmentRequest.uuid,
  });
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
          rowBuilder.where('user.companyId', approval.companyId).where('userRole.roleId', approval.roleId);
        });
      });
    })
    .distinct(['user.id']);
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
    .where('company.isActive', true)
    .where('company.type', HOLDER_COMPANY_TYPE)
    .where('role.isActive', true)
    .where('permission.isActive', true)
    .where('permission.code', APPROVAL_MENU_PERMISSION_CODE)
    .distinct(['user.id']);
}

async function findOperationMenuCode(trx) {
  const menu = await trx('menus as menu')
    .where('menu.isActive', true)
    .whereIn('menu.route', OPERATIONS_MENU_ROUTES)
    .orderBy('menu.sequence', 'asc')
    .orderBy('menu.menuId', 'asc')
    .first('menu.code');

  if (menu?.code) {
    return menu.code;
  }

  const fallbackMenu = await trx('menus as menu')
    .join('permissions as permission', 'permission.permissionId', 'menu.permissionId')
    .where('menu.isActive', true)
    .where('permission.isActive', true)
    .where('permission.code', OPERATIONS_MENU_PERMISSION_CODE)
    .orderBy('menu.sequence', 'asc')
    .orderBy('menu.menuId', 'asc')
    .first('menu.code');

  return fallbackMenu?.code ?? null;
}

async function findOperationRecipients(trx) {
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
    .where('company.isActive', true)
    .where('company.type', HOLDER_COMPANY_TYPE)
    .where('role.isActive', true)
    .where('permission.isActive', true)
    .where('permission.code', OPERATIONS_MENU_PERMISSION_CODE)
    .distinct(['user.id']);
}

module.exports = {
  enqueueRequestActionMenuNotifications,
  deactivateOperationMenuNotifications,
};
