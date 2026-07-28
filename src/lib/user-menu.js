"use strict";

const db = require("./db")();

function buildMenuTree(menuRows) {
  const menuMap = new Map();
  const rootMenus = [];

  for (const row of menuRows) {
    menuMap.set(row.menuId, {
      id: row.menuId,
      uuid: row.uuid,
      parentId: row.parentId,
      code: row.code,
      menuName: row.menuName,
      route: row.route,
      icon: row.icon,
      permissionId: row.permissionId,
      permissionCode: row.permissionCode,
      sequence: row.sequence,
      children: [],
    });
  }

  for (const menu of menuMap.values()) {
    if (menu.parentId && menuMap.has(menu.parentId)) {
      menuMap.get(menu.parentId).children.push(menu);
    } else {
      rootMenus.push(menu);
    }
  }

  const sortMenus = (menus) => {
    menus.sort(
      (first, second) =>
        Number(first.sequence || 0) - Number(second.sequence || 0),
    );

    for (const menu of menus) {
      if (menu.children.length > 0) {
        sortMenus(menu.children);
      }
    }

    return menus;
  };

  return sortMenus(rootMenus);
}

/**
 * Remove empty parent menus.
 *
 * Parent menu without route should only be displayed when it has
 * at least one visible child.
 */
function removeEmptyParents(menus) {
  return menus
    .map((menu) => ({
      ...menu,
      children: removeEmptyParents(menu.children || []),
    }))
    .filter((menu) => {
      const hasRoute = Boolean(menu.route);
      const hasChildren = menu.children.length > 0;

      return hasRoute || hasChildren;
    });
}

async function getUserMenus(userId, trx = db) {
  const permissionRows = await trx("userRoles as ur")
    .join("roles as r", "r.id", "ur.roleId")
    .join("rolePermissions as rp", "rp.roleId", "r.id")
    .join("permissions as p", "p.permissionId", "rp.permissionId")
    .where("ur.userId", userId)
    .where("r.isActive", true)
    .distinct("p.permissionId");

  const permissionIds = permissionRows.map(
    (permission) => permission.permissionId,
  );

  const menusQuery = trx("menus as m")
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
    .orderBy("m.sequence", "asc");

  menusQuery.andWhere(function () {
    this.whereNull("m.permissionId");

    if (permissionIds.length > 0) {
      this.orWhereIn("m.permissionId", permissionIds);
    }
  });

  const menuRows = await menusQuery;

  const menuTree = buildMenuTree(menuRows);

  return removeEmptyParents(menuTree);
}

module.exports = {
  getUserMenus,
};
