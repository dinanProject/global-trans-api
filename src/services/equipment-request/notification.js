'use strict';

const {
  createMenuNotifications,
  deactivateReferenceNotifications,
} = require('../menu-notification');

const MODULE_CODE = 'EQUIPMENT_REQUEST';
const HOLDER_COMPANY_TYPE = 1;
const APPROVAL_MENU_PERMISSION_CODE = 'EQUIPMENT_APPROVAL.VIEW';
const ASSIGNMENT_MENU_PERMISSION_CODE = 'EQUIPMENT_REQUEST.ASSIGN';
const ASSIGNMENT_MENU_ROUTES = [
  '/equipment-request/assignments',
  '/main/equipment-request/assignments',
  'equipment-request/assignments',
  'main/equipment-request/assignments',
];
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

  if (actionCode === 'APPROVE_GTSI') {
    const [recipients, assignmentMenuCode] = await Promise.all([
      findAssignmentRecipients(trx),
      findAssignmentMenuCode(trx),
    ]);

    if (recipients.length === 0 || !assignmentMenuCode) {
      return;
    }

    await createMenuNotifications(
      trx,
      recipients.map((recipient) => ({
        recipientUserId: recipient.id,
        moduleCode: MODULE_CODE,
        menuCode: assignmentMenuCode,
        referenceId: equipmentRequest.id,
        referenceUuid: equipmentRequest.uuid,
        contextCode: 'ASSIGNMENT_REQUIRED_APPROVE_GTSI',
      }))
    );

    return;
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

async function deactivateAssignmentMenuNotifications(trx, equipmentRequest) {
  if (!equipmentRequest?.uuid) {
    return 0;
  }

  const assignmentMenuCode = await findAssignmentMenuCode(trx);

  if (!assignmentMenuCode) {
    return 0;
  }

  return deactivateReferenceNotifications(trx, {
    moduleCode: MODULE_CODE,
    menuCode: assignmentMenuCode,
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
          rowBuilder
            .where('user.companyId', approval.companyId)
            .where('userRole.roleId', approval.roleId);
        });
      });
    })
    .distinct(['user.id']);
}

async function findAssignmentMenuCode(trx) {
  const menu = await trx('menus as menu')
    .where('menu.isActive', true)
    .whereIn('menu.route', ASSIGNMENT_MENU_ROUTES)
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
    .where('permission.code', ASSIGNMENT_MENU_PERMISSION_CODE)
    .orderBy('menu.sequence', 'asc')
    .orderBy('menu.menuId', 'asc')
    .first('menu.code');

  return fallbackMenu?.code ?? null;
}

async function findAssignmentRecipients(trx) {
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
    .where('permission.code', ASSIGNMENT_MENU_PERMISSION_CODE)
    .distinct(['user.id']);
}

module.exports = {
  enqueueRequestActionMenuNotifications,
  deactivateAssignmentMenuNotifications,
};
