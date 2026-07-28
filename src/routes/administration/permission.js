"use strict";

const crypto = require("node:crypto");
const express = require("express");

const db = require("../../lib/db")();
const authentication = require("../../lib/authentication");

const router = express.Router();

router.use(authentication);

router

  /**
   * GET /permission
   */
  .get("/", async (req, res, next) => {
    try {
      const search = normalizeNullableString(req.query.search);
      const moduleName = normalizeNullableString(req.query.module);
      const isActive = normalizeOptionalBoolean(req.query.isActive);

      const query = db("permissions as p")
        .select([
          "p.permissionId",
          "p.uuid",
          "p.code",
          "p.scope",
          "p.label",
          "p.module",
          "p.action",
          "p.description",
          "p.isSystem",
          "p.isActive",
          "p.createdAt",
          "p.updatedAt",
        ])
        .orderBy("p.module", "asc")
        .orderBy("p.action", "asc")
        .orderBy("p.label", "asc");

      if (search) {
        query.where((builder) => {
          builder
            .whereRaw("LOWER(p.code) LIKE LOWER(?)", [`%${search}%`])
            .orWhereRaw("LOWER(p.label) LIKE LOWER(?)", [`%${search}%`])
            .orWhereRaw("LOWER(p.description) LIKE LOWER(?)", [`%${search}%`]);
        });
      }

      if (moduleName) {
        query.whereRaw("LOWER(p.module) = LOWER(?)", [moduleName]);
      }

      if (isActive !== null) {
        query.where("p.isActive", isActive);
      }

      const rows = await query;

      return res.success(rows.map(normalizePermissionResponse));
    } catch (error) {
      return next(error);
    }
  })

  /**
   * GET /permission/modules
   */
  .get("/modules", async (req, res, next) => {
    try {
      const rows = await db("permissions")
        .distinct("module")
        .whereNotNull("module")
        .where("module", "<>", "")
        .orderBy("module", "asc");

      return res.success(rows.map((row) => row.module));
    } catch (error) {
      return next(error);
    }
  })

  /**
   * GET /permission/:uuid
   */
  .get("/:uuid", async (req, res, next) => {
    try {
      const permission = await db("permissions as p")
        .select([
          "p.permissionId",
          "p.uuid",
          "p.code",
          "p.scope",
          "p.label",
          "p.module",
          "p.action",
          "p.description",
          "p.isSystem",
          "p.isActive",
          "p.createdAt",
          "p.updatedAt",
        ])
        .where("p.uuid", req.params.uuid)
        .first();

      if (!permission) {
        return res.fail("Permission tidak ditemukan");
      }

      return res.success(normalizePermissionResponse(permission));
    } catch (error) {
      return next(error);
    }
  })

  /**
   * POST /permission
   */
  .post("/", async (req, res, next) => {
    try {
      const payload = normalizePayload(req.body);
      const validationMessage = validatePayload(payload);

      if (validationMessage) {
        return res.incomplete(validationMessage);
      }

      const duplicateCode = await db("permissions")
        .select(["permissionId"])
        .whereRaw("LOWER(code) = LOWER(?)", [payload.code])
        .first();

      if (duplicateCode) {
        return res.fail(`Code permission "${payload.code}" sudah digunakan`);
      }

      const uuid = crypto.randomUUID();

      await db("permissions").insert({
        uuid,
        code: payload.code,
        scope: payload.scope,
        label: payload.label,
        module: payload.module,
        action: payload.action,
        description: payload.description,
        isSystem: false,
        isActive: payload.isActive,
      });

      const createdPermission = await db("permissions")
        .select([
          "permissionId",
          "uuid",
          "code",
          "scope",
          "label",
          "module",
          "action",
          "description",
          "isSystem",
          "isActive",
          "createdAt",
          "updatedAt",
        ])
        .where("uuid", uuid)
        .first();

      return res.success(
        normalizePermissionResponse(createdPermission),
        "Permission berhasil dibuat",
        201,
      );
    } catch (error) {
      return next(error);
    }
  })

  /**
   * PUT /permission/:uuid
   */
  .put("/:uuid", async (req, res, next) => {
    try {
      const existingPermission = await db("permissions")
        .select([
          "permissionId",
          "uuid",
          "code",
          "label",
          "isSystem",
          "isActive",
        ])
        .where("uuid", req.params.uuid)
        .first();

      if (!existingPermission) {
        return res.fail("Permission tidak ditemukan");
      }

      const payload = normalizePayload(req.body);
      const validationMessage = validatePayload(payload);

      if (validationMessage) {
        return res.incomplete(validationMessage);
      }

      const duplicateCode = await db("permissions")
        .select(["permissionId"])
        .whereRaw("LOWER(code) = LOWER(?)", [payload.code])
        .whereNot("permissionId", existingPermission.permissionId)
        .first();

      if (duplicateCode) {
        return res.fail(`Code permission "${payload.code}" sudah digunakan`);
      }

      if (
        Boolean(existingPermission.isSystem) &&
        payload.code !== existingPermission.code
      ) {
        return res.fail("Code permission system tidak dapat diubah");
      }

      await db("permissions")
        .where("permissionId", existingPermission.permissionId)
        .update({
          code: payload.code,
          scope: payload.scope,
          label: payload.label,
          module: payload.module,
          action: payload.action,
          description: payload.description,
          isActive: payload.isActive,
          updatedAt: db.fn.now(),
        });

      const updatedPermission = await db("permissions")
        .select([
          "permissionId",
          "uuid",
          "code",
          "scope",
          "label",
          "module",
          "action",
          "description",
          "isSystem",
          "isActive",
          "createdAt",
          "updatedAt",
        ])
        .where("permissionId", existingPermission.permissionId)
        .first();

      return res.success(
        normalizePermissionResponse(updatedPermission),
        "Permission berhasil diperbarui",
      );
    } catch (error) {
      return next(error);
    }
  })

  /**
   * DELETE /permission/:uuid
   */
  .delete("/:uuid", async (req, res, next) => {
    try {
      const permission = await db("permissions")
        .select([
          "permissionId",
          "uuid",
          "code",
          "label",
          "isSystem",
          "isActive",
        ])
        .where("uuid", req.params.uuid)
        .first();

      if (!permission) {
        return res.fail("Permission tidak ditemukan");
      }

      if (Boolean(permission.isSystem)) {
        return res.fail(
          `Permission system "${permission.label}" tidak dapat dinonaktifkan`,
        );
      }

      if (!Boolean(permission.isActive)) {
        return res.success(
          {
            uuid: permission.uuid,
            isActive: false,
          },
          "Permission sudah dalam keadaan tidak aktif",
        );
      }

      const usedByMenu = await db("menus")
        .select(["menuId", "menuName"])
        .where("permissionId", permission.permissionId)
        .first();

      if (usedByMenu) {
        return res.fail(
          `Permission masih digunakan oleh menu "${usedByMenu.menuName}"`,
        );
      }

      await db("permissions")
        .where("permissionId", permission.permissionId)
        .update({
          isActive: false,
          updatedAt: db.fn.now(),
        });

      return res.success(
        {
          uuid: permission.uuid,
          isActive: false,
        },
        "Permission berhasil dinonaktifkan",
      );
    } catch (error) {
      return next(error);
    }
  });

function normalizePayload(body = {}) {
  const moduleName = normalizeRequiredString(body.module).toUpperCase();
  const action = normalizeRequiredString(body.action).toUpperCase();

  return {
    code: normalizeRequiredString(
      body.code || `${moduleName}.${action}`,
    ).toUpperCase(),
    scope: normalizeScope(body.scope),
    label: normalizeRequiredString(body.label),
    module: moduleName,
    action,
    description: normalizeNullableString(body.description),
    isActive: normalizeBoolean(body.isActive, true),
  };
}

function validatePayload(payload) {
  if (!payload.code) {
    return "Code permission wajib diisi";
  }

  if (!payload.label) {
    return "Label permission wajib diisi";
  }

  if (!payload.module) {
    return "Module permission wajib diisi";
  }

  if (!payload.action) {
    return "Action permission wajib diisi";
  }

  if (!["OWN", "COMPANY", "ALL"].includes(payload.scope)) {
    return "Scope harus OWN, COMPANY, atau ALL";
  }

  return null;
}

function normalizePermissionResponse(permission) {
  return {
    ...permission,
    isSystem: Boolean(permission.isSystem),
    isActive: Boolean(permission.isActive),
  };
}

function normalizeScope(value) {
  const normalizedValue = normalizeRequiredString(value).toUpperCase();

  if (["OWN", "COMPANY", "ALL"].includes(normalizedValue)) {
    return normalizedValue;
  }

  return "ALL";
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

  return value.trim() || null;
}

function normalizeOptionalBoolean(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  return normalizeBoolean(value, null);
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
