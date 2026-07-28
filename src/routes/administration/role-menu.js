"use strict";

const express = require("express");

const db = require("../../lib/db")();
const authentication = require("../../lib/authentication");

const router = express.Router();

router.use(authentication);

router

  /**
   * GET /role-menu/:roleUuid
   *
   * Mendapatkan seluruh menu beserta status assigned untuk sebuah role.
   */
  .get("/:roleUuid", async (req, res, next) => {
    try {
      const role = await getRoleByUuid(req.params.roleUuid);

      if (!role) {
        return res.fail("Role tidak ditemukan");
      }

      const rows = await db("menus as m")
        .leftJoin("roleMenus as rm", function joinRoleMenus() {
          this.on("rm.menuId", "=", "m.menuId").andOn(
            "rm.roleId",
            "=",
            db.raw("?", [role.id]),
          );
        })
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
          "m.isActive",
          "rm.id as roleMenuId",
        ])
        .orderByRaw("CASE WHEN m.parentId IS NULL THEN 0 ELSE 1 END")
        .orderBy("m.parentId", "asc")
        .orderBy("m.sequence", "asc")
        .orderBy("m.menuId", "asc");

      return res.success({
        role: normalizeRoleResponse(role),
        menus: rows.map((row) => ({
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
          isActive: Boolean(row.isActive),
          assigned: row.roleMenuId !== null,
        })),
      });
    } catch (error) {
      return next(error);
    }
  })

  /**
   * PUT /role-menu/:roleUuid
   *
   * Payload:
   *
   * {
   *   "menuUuids": [
   *     "uuid-menu-1",
   *     "uuid-menu-2"
   *   ]
   * }
   *
   * Assignment bersifat replace-all.
   */
  .put("/:roleUuid", async (req, res, next) => {
    const trx = await db.transaction();

    try {
      const role = await trx("roles")
        .select(["id", "uuid", "code", "name", "isSystem", "isActive"])
        .where("uuid", req.params.roleUuid)
        .first();

      if (!role) {
        await trx.rollback();
        return res.fail("Role tidak ditemukan");
      }

      const menuUuids = normalizeUuidArray(req.body.menuUuids);

      if (!Array.isArray(req.body.menuUuids)) {
        await trx.rollback();
        return res.incomplete("menuUuids wajib berupa array");
      }

      const selectedMenus = menuUuids.length
        ? await trx("menus")
            .select(["menuId", "uuid", "parentId", "menuName", "isActive"])
            .whereIn("uuid", menuUuids)
        : [];

      if (selectedMenus.length !== menuUuids.length) {
        await trx.rollback();
        return res.fail("Salah satu menu tidak ditemukan");
      }

      const inactiveMenu = selectedMenus.find(
        (menu) => !Boolean(menu.isActive),
      );

      if (inactiveMenu) {
        await trx.rollback();
        return res.fail(
          `Menu "${inactiveMenu.menuName}" dalam keadaan tidak aktif`,
        );
      }

      /*
       * Agar parent menu ikut tersimpan ketika child dipilih.
       */
      const menuIds = await includeParentMenuIds(trx, selectedMenus);

      await trx("roleMenus").where("roleId", role.id).delete();

      if (menuIds.length > 0) {
        await trx("roleMenus").insert(
          menuIds.map((menuId) => ({
            roleId: role.id,
            menuId,
            createdAt: trx.fn.now(),
          })),
        );
      }

      await trx.commit();

      return res.success(
        {
          roleUuid: role.uuid,
          menuCount: menuIds.length,
        },
        "Menu role berhasil diperbarui",
      );
    } catch (error) {
      await trx.rollback();
      return next(error);
    }
  });

async function getRoleByUuid(uuid) {
  return db("roles")
    .select(["id", "uuid", "code", "name", "isSystem", "isActive"])
    .where("uuid", uuid)
    .first();
}

async function includeParentMenuIds(trx, selectedMenus) {
  const selectedIds = new Set(selectedMenus.map((menu) => Number(menu.menuId)));

  let pendingParentIds = selectedMenus
    .map((menu) => menu.parentId)
    .filter(Boolean)
    .map(Number)
    .filter((menuId) => !selectedIds.has(menuId));

  while (pendingParentIds.length > 0) {
    const uniqueParentIds = [...new Set(pendingParentIds)];

    const parentMenus = await trx("menus")
      .select(["menuId", "parentId"])
      .whereIn("menuId", uniqueParentIds);

    pendingParentIds = [];

    for (const parentMenu of parentMenus) {
      const parentMenuId = Number(parentMenu.menuId);

      selectedIds.add(parentMenuId);

      if (
        parentMenu.parentId &&
        !selectedIds.has(Number(parentMenu.parentId))
      ) {
        pendingParentIds.push(Number(parentMenu.parentId));
      }
    }
  }

  return [...selectedIds];
}

function normalizeUuidArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [
    ...new Set(
      value
        .filter((item) => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function normalizeRoleResponse(role) {
  return {
    uuid: role.uuid,
    code: role.code,
    name: role.name,
    isSystem: Boolean(role.isSystem),
    isActive: Boolean(role.isActive),
  };
}

module.exports = router;
