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

  const permissionIds = new Set(
    permissionRows.map((item) => String(item.permissionId)),
  );

  /*
   * Ambil seluruh menu aktif terlebih dahulu.
   * Setelah itu baru filter berdasarkan permission user
   * dan sertakan parent dari menu yang diizinkan.
   */
  const allMenuRows = await db("menus")
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
    .orderBy("sequence", "asc")
    .orderBy("menuId", "asc");

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

    /*
     * Menu root tanpa permission yang mempunyai route dianggap public,
     * misalnya Dashboard.
     *
     * Parent/container tanpa permission seperti Organization dan
     * Administration tidak otomatis ditampilkan.
     */
    const isPublicRootMenu =
      menu.permissionId === null && !menu.parentId && Boolean(menu.route);

    if (hasPermission || isPublicRootMenu) {
      addMenuAndParents(menu);
    }
  }

  const menuRows = allMenuRows.filter((menu) =>
    allowedMenuIds.has(String(menu.menuId)),
  );

  const menus = buildMenuTree(menuRows);
  return {
    user,
    menus,
  };
}

module.exports = {
  getBootstrap,
};
