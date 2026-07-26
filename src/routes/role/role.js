"use strict";

const crypto = require("node:crypto");
const express = require("express");

const db = require("../../lib/db")();
const authentication = require("../../lib/authentication");
const router = express.Router();

router.use(authentication);

/**
 * GET /role
 *
 * Mendapatkan seluruh role.
 */
router

  .get("/", async (req, res, next) => {
    try {
      const roles = await db("roles")
        .select([
          "id",
          "uuid",
          "code",
          "name",
          "description",
          "isSystem",
          "isActive",
          "createdAt",
          "updatedAt",
        ])
        .orderBy("isSystem", "desc")
        .orderBy("name", "asc")
        .orderBy("id", "asc");

      return res.success(roles.map(normalizeRoleResponse));
    } catch (error) {
      return next(error);
    }
  })

  /**
   * GET /role/:uuid
   *
   * Mendapatkan detail satu role.
   */
  .get("/:uuid", async (req, res, next) => {
    try {
      const role = await db("roles")
        .select([
          "id",
          "uuid",
          "code",
          "name",
          "description",
          "isSystem",
          "isActive",
          "createdAt",
          "updatedAt",
        ])
        .where("uuid", req.params.uuid)
        .first();

      if (!role) {
        return res.fail("Role tidak ditemukan");
      }

      return res.success(normalizeRoleResponse(role));
    } catch (error) {
      return next(error);
    }
  })

  /**
   * POST /role
   *
   * Membuat role baru.
   */
  .post("/", async (req, res, next) => {
    try {
      const payload = normalizePayload(req.body);
      const validationMessage = validatePayload(payload);

      if (validationMessage) {
        return res.incomplete(validationMessage);
      }

      const duplicateCode = await db("roles")
        .select(["id"])
        .whereRaw("LOWER(code) = LOWER(?)", [payload.code])
        .first();

      if (duplicateCode) {
        return res.fail(`Code role "${payload.code}" sudah digunakan`);
      }

      const duplicateName = await db("roles")
        .select(["id"])
        .whereRaw("LOWER(name) = LOWER(?)", [payload.name])
        .first();

      if (duplicateName) {
        return res.fail(`Nama role "${payload.name}" sudah digunakan`);
      }

      const uuid = crypto.randomUUID();

      await db("roles").insert({
        uuid,
        code: payload.code,
        name: payload.name,
        description: payload.description,

        // Role yang dibuat melalui API bukan system role.
        isSystem: false,

        isActive: payload.isActive,
      });

      const createdRole = await db("roles")
        .select([
          "id",
          "uuid",
          "code",
          "name",
          "description",
          "isSystem",
          "isActive",
          "createdAt",
          "updatedAt",
        ])
        .where("uuid", uuid)
        .first();

      return res.success(
        normalizeRoleResponse(createdRole),
        "Role berhasil dibuat",
        201,
      );
    } catch (error) {
      return next(error);
    }
  })

  /**
   * PUT /role/:uuid
   *
   * Memperbarui role.
   *
   * Karena menggunakan PUT, kirim payload lengkap.
   */
  .put("/:uuid", async (req, res, next) => {
    try {
      const existingRole = await db("roles")
        .select([
          "id",
          "uuid",
          "code",
          "name",
          "description",
          "isSystem",
          "isActive",
        ])
        .where("uuid", req.params.uuid)
        .first();

      if (!existingRole) {
        return res.fail("Role tidak ditemukan");
      }

      const payload = normalizePayload(req.body);
      const validationMessage = validatePayload(payload);

      if (validationMessage) {
        return res.incomplete(validationMessage);
      }

      const duplicateCode = await db("roles")
        .select(["id"])
        .whereRaw("LOWER(code) = LOWER(?)", [payload.code])
        .whereNot("id", existingRole.id)
        .first();

      if (duplicateCode) {
        return res.fail(`Code role "${payload.code}" sudah digunakan`);
      }

      const duplicateName = await db("roles")
        .select(["id"])
        .whereRaw("LOWER(name) = LOWER(?)", [payload.name])
        .whereNot("id", existingRole.id)
        .first();

      if (duplicateName) {
        return res.fail(`Nama role "${payload.name}" sudah digunakan`);
      }

      const updatePayload = {
        name: payload.name,
        description: payload.description,
        isActive: payload.isActive,
      };

      /*
       * Code system role tidak boleh diubah.
       *
       * Untuk role biasa, code masih dapat diperbarui selama tidak duplikat.
       */
      if (!Boolean(existingRole.isSystem)) {
        updatePayload.code = payload.code;
      }

      await db("roles").where("id", existingRole.id).update(updatePayload);

      const updatedRole = await db("roles")
        .select([
          "id",
          "uuid",
          "code",
          "name",
          "description",
          "isSystem",
          "isActive",
          "createdAt",
          "updatedAt",
        ])
        .where("id", existingRole.id)
        .first();

      return res.success(
        normalizeRoleResponse(updatedRole),
        "Role berhasil diperbarui",
      );
    } catch (error) {
      return next(error);
    }
  })

  /**
   * DELETE /role/:uuid
   *
   * Tidak menghapus role secara fisik.
   * Hanya mengubah isActive menjadi false.
   */
  .delete("/:uuid", async (req, res, next) => {
    try {
      const role = await db("roles")
        .select(["id", "uuid", "code", "name", "isSystem", "isActive"])
        .where("uuid", req.params.uuid)
        .first();

      if (!role) {
        return res.fail("Role tidak ditemukan");
      }

      if (Boolean(role.isSystem)) {
        return res.fail(`System role "${role.name}" tidak dapat dinonaktifkan`);
      }

      if (!Boolean(role.isActive)) {
        return res.success(
          {
            uuid: role.uuid,
            isActive: false,
          },
          "Role sudah dalam keadaan tidak aktif",
        );
      }

      const activeUserRole = await db("user_roles")
        .select(["id"])
        .where("roleId", role.id)
        .first();

      if (activeUserRole) {
        return res.fail(
          "Role tidak dapat dinonaktifkan karena masih digunakan oleh user",
        );
      }

      await db("roles").where("id", role.id).update({
        isActive: false,
      });

      return res.success(
        {
          uuid: role.uuid,
          isActive: false,
        },
        "Role berhasil dinonaktifkan",
      );
    } catch (error) {
      return next(error);
    }
  });

function normalizePayload(body = {}) {
  return {
    code: normalizeRequiredString(body.code).toUpperCase(),
    name: normalizeRequiredString(body.name),
    description: normalizeNullableString(body.description),
    isActive: normalizeBoolean(body.isActive, true),
  };
}

function validatePayload(payload) {
  if (!payload.code) {
    return "Code role wajib diisi";
  }

  if (!payload.name) {
    return "Nama role wajib diisi";
  }

  return null;
}

function normalizeRoleResponse(role) {
  return {
    ...role,
    isSystem: Boolean(role.isSystem),
    isActive: Boolean(role.isActive),
  };
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
