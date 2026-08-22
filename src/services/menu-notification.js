'use strict';

const { randomUUID } = require('crypto');

async function resolveMenuCode(trx, { menuCode, menuPermissionCode } = {}) {
  if (menuCode) {
    return menuCode;
  }

  if (!menuPermissionCode) {
    return null;
  }

  const menu = await trx('menus as m')
    .join('permissions as p', 'p.permissionId', 'm.permissionId')
    .where('p.code', menuPermissionCode)
    .where('m.isActive', true)
    .orderBy('m.sequence', 'asc')
    .orderBy('m.menuId', 'asc')
    .first('m.code');

  return menu?.code ?? null;
}

async function createMenuNotifications(trx, notifications = []) {
  if (!Array.isArray(notifications) || notifications.length === 0) {
    return;
  }

  const normalized = [];

  for (const notification of notifications) {
    if (!notification?.recipientUserId || !notification?.moduleCode) {
      continue;
    }

    const menuCode = await resolveMenuCode(trx, notification);

    if (!menuCode) {
      continue;
    }

    normalized.push({
      ...notification,
      menuCode,
    });
  }

  if (normalized.length === 0) {
    return;
  }

  const now = trx.fn.now();

  const rows = normalized.map((notification) => ({
    uuid: randomUUID(),
    recipientUserId: notification.recipientUserId,
    moduleCode: notification.moduleCode,
    menuCode: notification.menuCode,
    referenceId: notification.referenceId ?? null,
    referenceUuid: notification.referenceUuid ?? null,
    contextCode: notification.contextCode ?? null,
    isRead: false,
    readAt: null,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  }));

  await trx('userMenuNotifications').insert(rows);
}

async function getUnreadMenuCounts(trx, recipientUserId) {
  if (!recipientUserId) {
    return new Map();
  }

  const rows = await trx('userMenuNotifications')
    .select('menuCode')
    .count({ unreadCount: 'id' })
    .where({
      recipientUserId,
      isRead: false,
      isActive: true,
    })
    .whereNull('deletedAt')
    .groupBy('menuCode');

  return new Map(rows.map((row) => [String(row.menuCode), Number(row.unreadCount) || 0]));
}

async function getUnreadMenuSnapshot(trx, recipientUserId) {
  if (!recipientUserId) {
    return new Map();
  }

  const groupedRows = await trx('userMenuNotifications')
    .select('menuCode')
    .count({ unreadCount: 'id' })
    .max({ latestNotificationId: 'id' })
    .where({
      recipientUserId,
      isRead: false,
      isActive: true,
    })
    .whereNull('deletedAt')
    .groupBy('menuCode');

  if (groupedRows.length === 0) {
    return new Map();
  }

  const latestIds = groupedRows
    .map((row) => Number(row.latestNotificationId))
    .filter((id) => Number.isFinite(id));
  const latestRows =
    latestIds.length > 0
      ? await trx('userMenuNotifications').select('id', 'referenceUuid').whereIn('id', latestIds)
      : [];
  const latestReferenceById = new Map(
    latestRows.map((row) => [Number(row.id), row.referenceUuid ?? null])
  );
  const unreadReferenceRows = await trx('userMenuNotifications')
    .distinct('menuCode', 'referenceUuid')
    .where({
      recipientUserId,
      isRead: false,
      isActive: true,
    })
    .whereNotNull('referenceUuid')
    .whereNull('deletedAt');
  const unreadReferencesByMenu = unreadReferenceRows.reduce((result, row) => {
    const menuCode = String(row.menuCode);
    const references = result.get(menuCode) ?? [];

    references.push(row.referenceUuid);
    result.set(menuCode, references);

    return result;
  }, new Map());

  return new Map(
    groupedRows.map((row) => {
      const latestNotificationId = Number(row.latestNotificationId);
      const menuCode = String(row.menuCode);

      return [
        menuCode,
        {
          unreadCount: Number(row.unreadCount) || 0,
          latestReferenceUuid: latestReferenceById.get(latestNotificationId) ?? null,
          unreadReferenceUuids: unreadReferencesByMenu.get(menuCode) ?? [],
        },
      ];
    })
  );
}

function applyUnreadCounts(menus, unreadCounts) {
  return (menus || []).map((menu) => {
    const child = applyUnreadCounts(menu.child || [], unreadCounts);

    const ownUnreadCount = Number(unreadCounts.get(String(menu.code)) || 0);
    const childUnreadCount = child.reduce(
      (total, item) => total + Number(item.unreadCount || 0),
      0
    );

    return {
      ...menu,
      unreadCount: child.length > 0 ? childUnreadCount : ownUnreadCount,
      child,
    };
  });
}

async function deactivateReferenceNotifications(
  trx,
  { referenceUuid, moduleCode, menuCode, menuPermissionCode } = {}
) {
  if (!referenceUuid) {
    return 0;
  }

  const resolvedMenuCode = await resolveMenuCode(trx, {
    menuCode,
    menuPermissionCode,
  });

  if (!resolvedMenuCode) {
    return 0;
  }

  const query = trx('userMenuNotifications')
    .where({
      menuCode: resolvedMenuCode,
      referenceUuid,
      isActive: true,
    })
    .whereNull('deletedAt');

  if (moduleCode) {
    query.where('moduleCode', moduleCode);
  }

  return query.update({
    isActive: false,
    updatedAt: trx.fn.now(),
  });
}

async function markReferenceAsRead(
  trx,
  { recipientUserId, referenceUuid, menuCode, menuPermissionCode } = {}
) {
  if (!recipientUserId || !referenceUuid) {
    return 0;
  }

  const resolvedMenuCode = await resolveMenuCode(trx, {
    menuCode,
    menuPermissionCode,
  });

  if (!resolvedMenuCode) {
    return 0;
  }

  return trx('userMenuNotifications')
    .where({
      recipientUserId,
      menuCode: resolvedMenuCode,
      referenceUuid,
      isRead: false,
      isActive: true,
    })
    .whereNull('deletedAt')
    .update({
      isRead: true,
      readAt: trx.fn.now(),
      updatedAt: trx.fn.now(),
    });
}

module.exports = {
  createMenuNotifications,
  getUnreadMenuCounts,
  getUnreadMenuSnapshot,
  applyUnreadCounts,
  deactivateReferenceNotifications,
  markReferenceAsRead,
};
