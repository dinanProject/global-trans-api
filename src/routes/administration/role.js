"use strict";

const express = require("express");
const { randomUUID } = require("crypto");

const router = express.Router();

const authentication = require("../../lib/authentication");
const db = require("../../lib/db")();

router.use(authentication);

/**
 * GET /role
 *
 * Query:
 * - search
 * - companyUuid
 * - isActive
 */
router
  .get("/", async (req, res) => {
    try {
      const { search, companyUuid, isActive } = req.query;

      const query = createRoleDetailQuery();

      if (!isSystemDeveloper(req)) {
        query.andWhere("role.code", "<>", "SYSTEM_DEVELOPER");
      }

      if (search) {
        const normalizedSearch = `%${String(search).trim()}%`;

        query.andWhere((builder) => {
          builder
            .where("role.code", "like", normalizedSearch)
            .orWhere("role.name", "like", normalizedSearch)
            .orWhere("role.description", "like", normalizedSearch)
            .orWhere("company.code", "like", normalizedSearch)
            .orWhere("company.name", "like", normalizedSearch);
        });
      }

      if (companyUuid) {
        query.andWhere("company.uuid", String(companyUuid).trim());
      }

      if (isActive !== undefined) {
        query.andWhere("role.isActive", parseBooleanQuery(isActive));
      }

      const roles = await query
        .orderBy("company.name", "asc")
        .orderBy("role.name", "asc");

      return res.success(roles.map(normalizeRoleRow));
    } catch (error) {
      console.error("GET /role error:", error);

      return res.fail(error.message || "Failed to load roles.");
    }
  })

  /**
   * GET /role/options
   */
  .get("/options", async (req, res) => {
    try {
      const companies = await db("companies")
        .select(["uuid", "code", "name"])
        .where("isActive", true)
        .whereNull("deletedAt")
        .orderBy("name", "asc");

      return res.success({
        companies,
      });
    } catch (error) {
      console.error("GET /role/options error:", error);

      return res.fail(error.message || "Failed to load role options.");
    }
  })

  /**
   * GET /role/:uuid
   */
  .get("/:uuid", async (req, res) => {
    try {
      const role = await findRoleByUuid(req.params.uuid);

      if (!role) {
        return res.incomplete("Role tidak ditemukan.");
      }

      return res.success(role);
    } catch (error) {
      console.error("GET /role/:uuid error:", error);

      return res.fail(error.message || "Failed to load role.");
    }
  })

  /**
   * POST /role
   *
   * Payload:
   * {
   *   code: string,
   *   name: string,
   *   description?: string | null,
   *   companyUuid: string,
   *   isActive: boolean
   * }
   */
  .post("/", async (req, res) => {
    const trx = await db.transaction();

    try {
      const payload = normalizePayload(req.body);
      const validation = validatePayload(payload);

      if (!validation.valid) {
        await trx.rollback();

        return res.incomplete(validation.message);
      }

      if (payload.code === "SYSTEM_DEVELOPER") {
        await trx.rollback();

        return res.incomplete(
          "Role SYSTEM_DEVELOPER hanya boleh dikelola melalui deployment sistem.",
        );
      }

      const company = await findActiveCompany(trx, payload.companyUuid);

      if (!company) {
        await trx.rollback();

        return res.incomplete("Company tidak valid atau tidak aktif.");
      }

      const duplicateCode = await trx("roles")
        .whereRaw("UPPER(code) = ?", [payload.code])
        .first("id");

      if (duplicateCode) {
        await trx.rollback();

        return res.incomplete(`Role code "${payload.code}" sudah digunakan.`);
      }

      const duplicateName = await trx("roles")
        .where("companyId", company.id)
        .whereRaw("UPPER(name) = ?", [payload.name.toUpperCase()])
        .first("id");

      if (duplicateName) {
        await trx.rollback();

        return res.incomplete(
          `Role name "${payload.name}" sudah digunakan pada company tersebut.`,
        );
      }

      const uuid = randomUUID();
      const now = db.fn.now();

      await trx("roles").insert({
        uuid,
        companyId: company.id,
        code: payload.code,
        name: payload.name,
        description: payload.description,
        isSystem: false,
        isActive: payload.isActive,
        createdAt: now,
        updatedAt: now,
      });

      await trx.commit();

      return res.success(await findRoleByUuid(uuid));
    } catch (error) {
      await trx.rollback();

      console.error("POST /role error:", error);

      return res.fail(error.message || "Failed to create role.");
    }
  })

  /**
   * PUT /role/:uuid
   */
  .put("/:uuid", async (req, res) => {
    const trx = await db.transaction();

    try {
      const existingRole = await trx("roles")
        .where("uuid", req.params.uuid)
        .first();

      if (!existingRole) {
        await trx.rollback();

        return res.incomplete("Role tidak ditemukan.");
      }

      if (existingRole.isSystem && !isSystemDeveloper(req)) {
        await trx.rollback();

        return res.unauthorized(
          "Hanya System Developer yang dapat mengubah system role.",
        );
      }

      const payload = normalizePayload(req.body, {
        fallbackCompanyUuid: null,
      });

      if (existingRole.isSystem) {
        payload.companyUuid = null;
      }

      const validation = validatePayload(payload, {
        companyRequired: !existingRole.isSystem,
      });

      if (!validation.valid) {
        await trx.rollback();

        return res.incomplete(validation.message);
      }

      if (
        payload.code === "SYSTEM_DEVELOPER" &&
        existingRole.code !== "SYSTEM_DEVELOPER"
      ) {
        await trx.rollback();

        return res.incomplete(
          "Code SYSTEM_DEVELOPER tidak dapat digunakan oleh role lain.",
        );
      }

      let company = null;

      if (!existingRole.isSystem) {
        company = await findActiveCompany(trx, payload.companyUuid);

        if (!company) {
          await trx.rollback();

          return res.incomplete("Company tidak valid atau tidak aktif.");
        }
      }

      const duplicateCode = await trx("roles")
        .whereRaw("UPPER(code) = ?", [payload.code])
        .whereNot("id", existingRole.id)
        .first("id");

      if (duplicateCode) {
        await trx.rollback();

        return res.incomplete(`Role code "${payload.code}" sudah digunakan.`);
      }

      if (company) {
        const duplicateName = await trx("roles")
          .where("companyId", company.id)
          .whereRaw("UPPER(name) = ?", [payload.name.toUpperCase()])
          .whereNot("id", existingRole.id)
          .first("id");

        if (duplicateName) {
          await trx.rollback();

          return res.incomplete(
            `Role name "${payload.name}" sudah digunakan pada company tersebut.`,
          );
        }
      }

      const targetCompanyId = existingRole.isSystem ? null : company.id;

      if (Number(existingRole.companyId) !== Number(targetCompanyId)) {
        const assignedUser = await trx("userRoles")
          .where("roleId", existingRole.id)
          .first("id");

        if (assignedUser) {
          await trx.rollback();

          return res.incomplete(
            "Company role tidak dapat diubah karena role sudah diberikan kepada user.",
          );
        }
      }

      if (existingRole.isActive && !payload.isActive) {
        const activeUser = await trx("userRoles as userRole")
          .join("users as user", "user.id", "userRole.userId")
          .where("userRole.roleId", existingRole.id)
          .where("user.isActive", true)
          .whereNull("user.deletedAt")
          .first("userRole.id");

        if (activeUser) {
          await trx.rollback();

          return res.incomplete(
            "Role tidak dapat dinonaktifkan karena masih diberikan kepada user aktif.",
          );
        }
      }

      await trx("roles").where("id", existingRole.id).update({
        companyId: targetCompanyId,
        code: payload.code,
        name: payload.name,
        description: payload.description,
        isActive: payload.isActive,
        updatedAt: db.fn.now(),
      });

      await trx.commit();

      return res.success(await findRoleByUuid(req.params.uuid));
    } catch (error) {
      await trx.rollback();

      console.error("PUT /role/:uuid error:", error);

      return res.fail(error.message || "Failed to update role.");
    }
  })

  /**
   * DELETE /role/:uuid
   *
   * Deactivate role. Roles are not physically deleted because userRoles and
   * rolePermissions use the role id as an audit/history reference.
   */
  .delete("/:uuid", async (req, res) => {
    const trx = await db.transaction();

    try {
      const role = await trx("roles").where("uuid", req.params.uuid).first();

      if (!role) {
        await trx.rollback();

        return res.incomplete("Role tidak ditemukan.");
      }

      if (role.isSystem) {
        await trx.rollback();

        return res.incomplete("System role tidak dapat dinonaktifkan.");
      }

      const activeUser = await trx("userRoles as userRole")
        .join("users as user", "user.id", "userRole.userId")
        .where("userRole.roleId", role.id)
        .where("user.isActive", true)
        .whereNull("user.deletedAt")
        .first("userRole.id");

      if (activeUser) {
        await trx.rollback();

        return res.incomplete(
          "Role tidak dapat dinonaktifkan karena masih diberikan kepada user aktif.",
        );
      }

      await trx("roles").where("id", role.id).update({
        isActive: false,
        updatedAt: db.fn.now(),
      });

      await trx.commit();

      return res.success({
        uuid: role.uuid,
      });
    } catch (error) {
      await trx.rollback();

      console.error("DELETE /role/:uuid error:", error);

      return res.fail(error.message || "Failed to deactivate role.");
    }
  });

function createRoleDetailQuery() {
  return db("roles as role")
    .leftJoin("companies as company", "company.id", "role.companyId")
    .leftJoin(
      "rolePermissions as rolePermission",
      "rolePermission.roleId",
      "role.id",
    )
    .leftJoin("userRoles as userRole", "userRole.roleId", "role.id")
    .select([
      "role.uuid",
      "role.code",
      "role.name",
      "role.description",
      "role.isSystem",
      "role.isActive",
      "role.createdAt",
      "role.updatedAt",
      "company.uuid as companyUuid",
      "company.code as companyCode",
      "company.name as companyName",
    ])
    .select(
      db.raw("COUNT(DISTINCT rolePermission.permissionId) as permissionCount"),
    )
    .select(db.raw("COUNT(DISTINCT userRole.userId) as userCount"))
    .groupBy([
      "role.id",
      "role.uuid",
      "role.code",
      "role.name",
      "role.description",
      "role.isSystem",
      "role.isActive",
      "role.createdAt",
      "role.updatedAt",
      "company.uuid",
      "company.code",
      "company.name",
    ]);
}

async function findRoleByUuid(uuid) {
  const role = await createRoleDetailQuery().where("role.uuid", uuid).first();

  return role ? normalizeRoleRow(role) : null;
}

async function findActiveCompany(trx, companyUuid) {
  if (!companyUuid) {
    return null;
  }

  return trx("companies")
    .where("uuid", companyUuid)
    .where("isActive", true)
    .whereNull("deletedAt")
    .first(["id", "uuid", "code", "name"]);
}

function normalizePayload(payload = {}) {
  return {
    code: normalizeRequiredString(payload.code).toUpperCase(),
    name: normalizeRequiredString(payload.name),
    description: normalizeNullableString(payload.description),
    companyUuid: normalizeNullableString(payload.companyUuid),
    isActive: normalizeBoolean(payload.isActive, true),
  };
}

function validatePayload(payload, options = {}) {
  const companyRequired = options.companyRequired !== false;

  if (!payload.code) {
    return invalid("Role code wajib diisi.");
  }

  if (payload.code.length > 50) {
    return invalid("Role code maksimal 50 karakter.");
  }

  if (!/^[A-Z0-9._-]+$/.test(payload.code)) {
    return invalid(
      "Role code hanya boleh berisi huruf besar, angka, titik, underscore, dan dash.",
    );
  }

  if (!payload.name) {
    return invalid("Role name wajib diisi.");
  }

  if (payload.name.length > 100) {
    return invalid("Role name maksimal 100 karakter.");
  }

  if (payload.description && payload.description.length > 255) {
    return invalid("Description maksimal 255 karakter.");
  }

  if (companyRequired && !payload.companyUuid) {
    return invalid("Company wajib dipilih untuk business role.");
  }

  return {
    valid: true,
  };
}

function normalizeRoleRow(row) {
  return {
    ...row,
    permissionCount: Number(row.permissionCount || 0),
    userCount: Number(row.userCount || 0),
  };
}

function invalid(message) {
  return {
    valid: false,
    message,
  };
}

function normalizeRequiredString(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function normalizeNullableString(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const normalizedValue = String(value).trim();

  return normalizedValue || null;
}

function normalizeBoolean(value, defaultValue = false) {
  if (value === null || value === undefined || value === "") {
    return defaultValue;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value === 1;
  }

  return ["true", "1", "yes", "y"].includes(String(value).trim().toLowerCase());
}

function parseBooleanQuery(value) {
  const normalizedValue = String(value).trim().toLowerCase();

  if (["true", "1", "yes", "y"].includes(normalizedValue)) {
    return true;
  }

  if (["false", "0", "no", "n"].includes(normalizedValue)) {
    return false;
  }

  throw new Error("Query isActive harus berupa true atau false.");
}

function isSystemDeveloper(req) {
  const data = req.getData?.();

  const roleCodes = data?.access?.roleCodes ?? data?.roleCodes ?? [];

  return roleCodes.includes("SYSTEM_DEVELOPER");
}

module.exports = router;
