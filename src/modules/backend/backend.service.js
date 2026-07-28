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

async function getBootstrap(authUser) {
  const user = await db("users")
    .select([
      "id as userId",
      "uuid",
      "companyId",
      "divisionId",
      "departmentId",
      "email",
      "fullName",
      "phone",
    ])
    .where("id", authUser.userId)
    .where("isActive", true)
    .first();

  if (!user) {
    throw new Error("User tidak ditemukan atau tidak aktif");
  }

  const permissionRows = await db("rolePermissions as rp")
    .distinct("rp.permissionId")
    .join("userRoles as ur", "ur.roleId", "rp.roleId")
    .where("ur.userId", authUser.userId);

  const permissionIds = permissionRows.map((item) => item.permissionId);

  const menuRows = await db("menus")
    .select([
      "menuId",
      "uuid",
      "parentId",
      "code",
      "menuName",
      "route",
      "icon",
      "permissionId",
      "sequence",
    ])
    .where("isActive", true)
    .where((builder) => {
      builder.whereNull("permissionId");

      if (permissionIds.length > 0) {
        builder.orWhereIn("permissionId", permissionIds);
      }
    })
    .orderBy("sequence", "asc")
    .orderBy("menuId", "asc");

  const menus = buildMenuTree(menuRows);

  return {
    user,
    menus,
  };
  // return {
  //   user,
  //   menus: buildMenuTree(menuRows),
  // };
}

module.exports = {
  getBootstrap,
};
