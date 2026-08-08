"use strict";

const crypto = require("node:crypto");
const express = require("express");

const db = require("../../lib/db")();
const {
  authenticate: authentication,
  authorize: authorization,
} = require("../../modules/access/access.middleware");

const router = express.Router();

router.use(authentication);

let cachedPermissionPrimaryKey = null;

async function getPermissionPrimaryKey() {
  if (cachedPermissionPrimaryKey) {
    return cachedPermissionPrimaryKey;
  }

  const columnInfo = await db("permissions").columnInfo();

  if (columnInfo.id) {
    cachedPermissionPrimaryKey = "id";
    return cachedPermissionPrimaryKey;
  }

  if (columnInfo.permissionId) {
    cachedPermissionPrimaryKey = "permissionId";
    return cachedPermissionPrimaryKey;
  }

  throw new Error(
    'Primary key tabel "permissions" tidak ditemukan. Gunakan kolom "id" atau "permissionId".',
  );
}

/**
 * GET /menu
 *
 * Mendapatkan seluruh menu dalam bentuk flat list.
 */
router

  .get("/", authorization("MENU.VIEW"), async (req, res, next) => {
    try {
      const permissionPrimaryKey = await getPermissionPrimaryKey();

      const menus = await db("menus as m")
        .leftJoin("menus as parent", "parent.menuId", "m.parentId")
        .leftJoin(
          "permissions as permission",
          `permission.${permissionPrimaryKey}`,
          "m.permissionId",
        )
        .select([
          "m.menuId",
          "m.uuid",
          "m.parentId",
          "parent.uuid as parentUuid",
          "parent.menuName as parentMenuName",
          "m.code",
          "m.menuName",
          "m.route",
          "m.icon",
          "m.permissionId",
          "permission.code as permissionCode",
          "permission.label as permissionLabel",
          "m.sequence",
          "m.isActive",
          "m.createdAt",
          "m.updatedAt",
        ])
        .orderByRaw("CASE WHEN m.parentId IS NULL THEN 0 ELSE 1 END")
        .orderBy("m.parentId", "asc")
        .orderBy("m.sequence", "asc")
        .orderBy("m.menuId", "asc");

      return res.success(
        menus.map((menu) => ({
          ...menu,
          isActive: Boolean(menu.isActive),
        })),
      );
    } catch (error) {
      return next(error);
    }
  })

  /**
   * GET /menu/tree
   *
   * Mendapatkan seluruh menu dalam bentuk parent-child.
   */
  .get("/tree", async (req, res, next) => {
    try {
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
          "isActive",
          "createdAt",
          "updatedAt",
        ])
        .orderBy("sequence", "asc")
        .orderBy("menuId", "asc");

      return res.success(buildMenuTree(menuRows));
    } catch (error) {
      return next(error);
    }
  })

  /**
   * GET /menu/:uuid
   *
   * Mendapatkan detail satu menu.
   */
  .get("/:uuid", authorization("MENU.VIEW"), async (req, res, next) => {
    try {
      const permissionPrimaryKey = await getPermissionPrimaryKey();

      const menu = await db("menus as m")
        .leftJoin("menus as parent", "parent.menuId", "m.parentId")
        .leftJoin(
          "permissions as permission",
          `permission.${permissionPrimaryKey}`,
          "m.permissionId",
        )
        .select([
          "m.menuId",
          "m.uuid",
          "m.parentId",
          "parent.uuid as parentUuid",
          "parent.menuName as parentMenuName",
          "m.code",
          "m.menuName",
          "m.route",
          "m.icon",
          "m.permissionId",
          "permission.code as permissionCode",
          "permission.label as permissionLabel",
          "m.sequence",
          "m.isActive",
          "m.createdAt",
          "m.updatedAt",
        ])
        .where("m.uuid", req.params.uuid)
        .first();

      if (!menu) {
        return res.fail("Menu tidak ditemukan");
      }

      return res.success({
        ...menu,
        isActive: Boolean(menu.isActive),
      });
    } catch (error) {
      return next(error);
    }
  })

  /**
   * POST /menu
   *
   * Membuat menu baru.
   */
  .post("/", authorization("MENU.CREATE"), async (req, res, next) => {
    try {
      const payload = normalizePayload(req.body);
      const validationMessage = validatePayload(payload);

      if (validationMessage) {
        return res.incomplete(validationMessage);
      }

      const duplicateCode = await db("menus")
        .select(["menuId"])
        .whereRaw("LOWER(code) = LOWER(?)", [payload.code])
        .first();

      if (duplicateCode) {
        return res.fail(`Code menu "${payload.code}" sudah digunakan`);
      }

      const parentMenu = await getParentMenu(payload.parentUuid);

      if (payload.parentUuid && !parentMenu) {
        return res.fail("Parent menu tidak ditemukan");
      }

      const permission = await getPermission(payload.permissionId);

      if (payload.permissionId !== null && !permission) {
        return res.fail("Permission tidak ditemukan");
      }

      const uuid = crypto.randomUUID();

      await db("menus").insert({
        uuid,
        parentId: parentMenu?.menuId ?? null,
        code: payload.code,
        menuName: payload.menuName,
        route: payload.route,
        icon: payload.icon,
        permissionId: payload.permissionId,
        sequence: payload.sequence,
        isActive: payload.isActive,
      });

      const createdMenu = await db("menus")
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
          "isActive",
          "createdAt",
          "updatedAt",
        ])
        .where("uuid", uuid)
        .first();

      return res.success(
        {
          ...createdMenu,
          isActive: Boolean(createdMenu.isActive),
        },
        "Menu berhasil dibuat",
        201,
      );
    } catch (error) {
      return next(error);
    }
  })

  /**
   * PUT /menu/:uuid
   *
   * Memperbarui menu.
   *
   * Karena menggunakan PUT, kirim payload lengkap.
   */
  .put("/:uuid", authorization("MENU.UPDATE"), async (req, res, next) => {
    try {
      const existingMenu = await db("menus")
        .select(["menuId", "uuid", "parentId", "code", "menuName", "isActive"])
        .where("uuid", req.params.uuid)
        .first();

      if (!existingMenu) {
        return res.fail("Menu tidak ditemukan");
      }

      const payload = normalizePayload(req.body);
      const validationMessage = validatePayload(payload);

      if (validationMessage) {
        return res.incomplete(validationMessage);
      }

      const duplicateCode = await db("menus")
        .select(["menuId"])
        .whereRaw("LOWER(code) = LOWER(?)", [payload.code])
        .whereNot("menuId", existingMenu.menuId)
        .first();

      if (duplicateCode) {
        return res.fail(`Code menu "${payload.code}" sudah digunakan`);
      }

      const parentMenu = await getParentMenu(payload.parentUuid);

      if (payload.parentUuid && !parentMenu) {
        return res.fail("Parent menu tidak ditemukan");
      }

      if (parentMenu?.menuId === existingMenu.menuId) {
        return res.fail(
          "Menu tidak boleh menjadi parent untuk dirinya sendiri",
        );
      }

      if (parentMenu) {
        const circularReference = await isCircularParent(
          existingMenu.menuId,
          parentMenu.menuId,
        );

        if (circularReference) {
          return res.fail(
            "Parent menu tidak boleh berasal dari child menu yang sedang diedit",
          );
        }
      }

      const permission = await getPermission(payload.permissionId);

      if (payload.permissionId !== null && !permission) {
        return res.fail("Permission tidak ditemukan");
      }

      await db("menus")
        .where("menuId", existingMenu.menuId)
        .update({
          parentId: parentMenu?.menuId ?? null,
          code: payload.code,
          menuName: payload.menuName,
          route: payload.route,
          icon: payload.icon,
          permissionId: payload.permissionId,
          sequence: payload.sequence,
          isActive: payload.isActive,
        });

      const updatedMenu = await db("menus")
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
          "isActive",
          "createdAt",
          "updatedAt",
        ])
        .where("menuId", existingMenu.menuId)
        .first();

      return res.success(
        {
          ...updatedMenu,
          isActive: Boolean(updatedMenu.isActive),
        },
        "Menu berhasil diperbarui",
      );
    } catch (error) {
      return next(error);
    }
  })

  /**
   * DELETE /menu/:uuid
   *
   * Tidak menghapus data secara fisik.
   * Hanya mengubah isActive menjadi false.
   */
  .delete("/:uuid", authorization("MENU.DELETE"), async (req, res, next) => {
    const protectedMenuCodes = ["SYSTEM.MANAGEMENT", "SYSTEM.MANAGEMENT.MENU"];
    try {
      const menu = await db("menus")
        .select(["menuId", "uuid", "menuName", "code", "isActive"])
        .where("uuid", req.params.uuid)
        .first();

      if (!menu) {
        return res.fail("Menu tidak ditemukan");
      }

      if (protectedMenuCodes.includes(menu.code)) {
        return res.fail(`Menu "${menu.menuName}" tidak dapat dinonaktifkan`);
      }

      if (!Boolean(menu.isActive)) {
        return res.success(
          {
            uuid: menu.uuid,
            isActive: false,
          },
          "Menu sudah dalam keadaan tidak aktif",
        );
      }

      const activeChildMenu = await db("menus")
        .select(["menuId", "uuid", "menuName"])
        .where("parentId", menu.menuId)
        .where("isActive", true)
        .first();

      if (activeChildMenu) {
        return res.fail(
          "Menu tidak dapat dinonaktifkan karena masih memiliki child menu aktif",
        );
      }

      await db("menus").where("menuId", menu.menuId).update({
        isActive: false,
      });

      return res.success(
        {
          uuid: menu.uuid,
          isActive: false,
        },
        "Menu berhasil dinonaktifkan",
      );
    } catch (error) {
      return next(error);
    }
  });

async function getParentMenu(parentUuid) {
  if (!parentUuid) {
    return null;
  }

  return db("menus")
    .select(["menuId", "uuid", "parentId", "menuName", "isActive"])
    .where("uuid", parentUuid)
    .first();
}

async function getPermission(permissionId) {
  if (permissionId === null) {
    return null;
  }

  const permissionPrimaryKey = await getPermissionPrimaryKey();

  return db("permissions")
    .select([
      `${permissionPrimaryKey} as permissionId`,
      "uuid",
      "code",
      "label",
    ])
    .where(permissionPrimaryKey, permissionId)
    .first();
}

/**
 * Mencegah struktur circular.
 *
 * Contoh:
 *
 * A
 * └── B
 *     └── C
 *
 * A tidak boleh dijadikan child dari B atau C.
 */
async function isCircularParent(menuId, candidateParentId) {
  let currentMenuId = candidateParentId;
  const visitedMenuIds = new Set();

  while (currentMenuId) {
    if (currentMenuId === menuId) {
      return true;
    }

    if (visitedMenuIds.has(currentMenuId)) {
      return true;
    }

    visitedMenuIds.add(currentMenuId);

    const currentMenu = await db("menus")
      .select(["parentId"])
      .where("menuId", currentMenuId)
      .first();

    currentMenuId = currentMenu?.parentId ?? null;
  }

  return false;
}

function buildMenuTree(rows) {
  const menuMap = new Map();
  const rootMenus = [];

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
      isActive: Boolean(row.isActive),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      child: [],
    });
  }

  for (const row of rows) {
    const menu = menuMap.get(row.menuId);

    if (row.parentId && menuMap.has(row.parentId)) {
      menuMap.get(row.parentId).child.push(menu);
    } else {
      rootMenus.push(menu);
    }
  }

  return rootMenus;
}

function normalizePayload(body = {}) {
  return {
    parentUuid: normalizeNullableString(body.parentUuid),
    code: normalizeRequiredString(body.code).toUpperCase(),

    // Tetap menerima "label" untuk compatibility apabila frontend
    // sebelumnya menggunakan field tersebut.
    menuName: normalizeRequiredString(body.menuName ?? body.label),

    route: normalizeNullableString(body.route),
    icon: normalizeNullableString(body.icon),
    permissionId: normalizeNullablePositiveInteger(body.permissionId),
    sequence: normalizeInteger(body.sequence),
    isActive: normalizeBoolean(body.isActive, true),
  };
}

function validatePayload(payload) {
  if (!payload.code) {
    return "Code menu wajib diisi";
  }

  if (!payload.menuName) {
    return "Nama menu wajib diisi";
  }

  if (!Number.isInteger(payload.sequence) || payload.sequence < 0) {
    return "Sequence harus berupa angka minimal 0";
  }

  return null;
}

function normalizeRequiredString(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function normalizeNullableString(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalizedValue = value.trim();

  return normalizedValue || null;
}

function normalizeNullablePositiveInteger(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const normalizedValue = Number(value);

  if (!Number.isInteger(normalizedValue) || normalizedValue < 1) {
    return null;
  }

  return normalizedValue;
}

function normalizeInteger(value) {
  if (value === null || value === undefined || value === "") {
    return 0;
  }

  return Number(value);
}

function normalizeBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value === 1;
  }

  if (typeof value === "string") {
    return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
  }

  return fallback;
}

module.exports = router;
