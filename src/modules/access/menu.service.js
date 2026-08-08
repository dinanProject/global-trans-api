"use strict";

const db = require("../../lib/db")();

function buildMenuTree(rows) {
  const menuMap = new Map();
  const roots = [];

  for (const row of rows) {
    menuMap.set(row.menuId, {
      menuId: row.menuId,
      uuid: row.uuid,
      parentId: row.parentId,
      code: row.code,
      menuName: row.menuName,
      route: row.route,
      icon: row.icon,
      permissionId: row.permissionId,
      permissionCode: row.permissionCode,
      sequence: row.sequence,
      child: [],
    });
  }

  for (const row of rows) {
    const menu = menuMap.get(row.menuId);

    if (row.parentId && menuMap.has(row.parentId)) {
      menuMap.get(row.parentId).child.push(menu);
    } else {
      roots.push(menu);
    }
  }

  return roots;
}

function removeEmptyParents(menus) {
  return menus
    .map((menu) => ({
      ...menu,
      child: removeEmptyParents(menu.child || []),
    }))
    .filter((menu) => Boolean(menu.route) || menu.child.length > 0);
}

async function getMenusForAccess(access, trx = db) {
  if (!access) {
    return [];
  }

  const permissionIds = new Set(
    (access.permissions || []).map((permission) => String(permission.id)),
  );

  const allMenuRows = await trx("menus as m")
    .leftJoin("permissions as p", "p.permissionId", "m.permissionId")
    .select([
      "m.menuId",
      "m.uuid",
      "m.parentId",
      "m.code",
      "m.menuName",
      "m.route",
      "m.icon",
      "m.permissionId",
      "p.code as permissionCode",
      "m.sequence",
    ])
    .where("m.isActive", true)
    .orderBy("m.sequence", "asc")
    .orderBy("m.menuId", "asc");

  const menuById = new Map(
    allMenuRows.map((menu) => [String(menu.menuId), menu]),
  );

  const allowedMenuIds = new Set();

  function addMenuAndParents(menu) {
    let currentMenu = menu;

    while (currentMenu) {
      const currentMenuId = String(currentMenu.menuId);

      if (allowedMenuIds.has(currentMenuId)) {
        break;
      }

      allowedMenuIds.add(currentMenuId);

      if (!currentMenu.parentId) {
        break;
      }

      currentMenu = menuById.get(String(currentMenu.parentId));
    }
  }

  for (const menu of allMenuRows) {
    const hasPermission =
      menu.permissionId !== null &&
      permissionIds.has(String(menu.permissionId));

    const isPublicRootMenu =
      menu.permissionId === null && !menu.parentId && Boolean(menu.route);

    if (hasPermission || isPublicRootMenu) {
      addMenuAndParents(menu);
    }
  }

  const menuRows = allMenuRows.filter((menu) =>
    allowedMenuIds.has(String(menu.menuId)),
  );

  return removeEmptyParents(buildMenuTree(menuRows));
}

module.exports = {
  getMenusForAccess,
};
