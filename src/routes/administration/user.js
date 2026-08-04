"use strict";

const express = require("express");
const bcrypt = require("bcrypt");
const { randomUUID } = require("crypto");

const router = express.Router();

const authentication = require("../../lib/authentication");
const authorization = require("../../lib/authorization");
const db = require("../../lib/db")();

router.use(authentication);

/**
 * GET /user
 *
 * Query:
 * - search
 * - companyUuid
 * - roleUuid
 * - isActive
 */
router
  .get("/", async (req, res) => {
    try {
      const { search, companyUuid, roleUuid, isActive } = req.query;

      const query = db("users as user")
        .join("companies as company", "company.id", "user.companyId")
        .leftJoin("divisions as division", "division.id", "user.divisionId")
        .leftJoin("userRoles as userRole", "userRole.userId", "user.id")
        .leftJoin("roles as role", "role.id", "userRole.roleId")
        .select([
          "user.uuid",
          "user.email",
          "user.fullName",
          "user.phone",
          "user.isActive",
          "user.lastLoginAt",
          "user.createdAt",
          "user.updatedAt",
          "company.uuid as companyUuid",
          "company.code as companyCode",
          "company.name as companyName",
          "division.uuid as divisionUuid",
          "division.code as divisionCode",
          "division.name as divisionName",
        ])
        .select(db.raw("COUNT(DISTINCT role.id) as roleCount"))
        .select(
          db.raw(
            "GROUP_CONCAT(DISTINCT role.name ORDER BY role.name SEPARATOR ', ') as roleNames",
          ),
        )
        .whereNull("user.deletedAt")
        .whereNull("company.deletedAt")
        .groupBy([
          "user.id",
          "user.uuid",
          "user.email",
          "user.fullName",
          "user.phone",
          "user.isActive",
          "user.lastLoginAt",
          "user.createdAt",
          "user.updatedAt",
          "company.uuid",
          "company.code",
          "company.name",
          "division.uuid",
          "division.code",
          "division.name",
        ]);

      if (!isSystemDeveloper(req)) {
        query.whereNotExists(function () {
          this.select(db.raw("1"))
            .from("userRoles as protectedUserRole")
            .join(
              "roles as protectedRole",
              "protectedRole.id",
              "protectedUserRole.roleId",
            )
            .whereRaw("protectedUserRole.userId = user.id")
            .where("protectedRole.code", "SYSTEM_DEVELOPER");
        });
      }

      if (search) {
        const normalizedSearch = `%${String(search).trim()}%`;

        query.andWhere((builder) => {
          builder
            .where("user.fullName", "like", normalizedSearch)
            .orWhere("user.email", "like", normalizedSearch)
            .orWhere("user.phone", "like", normalizedSearch)
            .orWhere("company.name", "like", normalizedSearch)
            .orWhere("company.code", "like", normalizedSearch)
            .orWhere("division.name", "like", normalizedSearch)
            .orWhere("role.name", "like", normalizedSearch)
            .orWhere("role.code", "like", normalizedSearch);
        });
      }

      if (companyUuid) {
        query.andWhere("company.uuid", String(companyUuid).trim());
      }

      if (roleUuid) {
        query.andWhereExists(function () {
          this.select(db.raw("1"))
            .from("userRoles as roleFilter")
            .join(
              "roles as filteredRole",
              "filteredRole.id",
              "roleFilter.roleId",
            )
            .whereRaw("roleFilter.userId = user.id")
            .where("filteredRole.uuid", String(roleUuid).trim());
        });
      }

      if (isActive !== undefined) {
        query.andWhere("user.isActive", parseBooleanQuery(isActive));
      }

      const users = await query.orderBy("user.fullName", "asc");

      return res.success(users.map(normalizeListRow));
    } catch (error) {
      console.error("GET /user error:", error);

      return res.fail(error.message || "Failed to load users.");
    }
  })

  /**
   * GET /user/options
   *
   * Query:
   * - companyUuid (optional)
   *
   * Without companyUuid, roles from every company are returned with their
   * companyUuid. This keeps older frontends working. The frontend should
   * filter them after company selection, or call this endpoint again with
   * companyUuid to receive only roles belonging to that company.
   */
  .get("/options", async (req, res) => {
    try {
      const companyUuid = normalizeNullableString(req.query.companyUuid);
      const actorIsSystemDeveloper = isSystemDeveloper(req);

      let selectedCompany = null;

      if (companyUuid) {
        selectedCompany = await db("companies")
          .where("uuid", companyUuid)
          .where("isActive", true)
          .whereNull("deletedAt")
          .first(["id", "uuid"]);

        if (!selectedCompany) {
          return res.incomplete("Company tidak ditemukan atau tidak aktif.");
        }
      }

      const companiesQuery = db("companies")
        .select(["uuid", "code", "name"])
        .where("isActive", true)
        .whereNull("deletedAt")
        .orderBy("name", "asc");

      const divisionsQuery = db("divisions as division")
        .join("companies as company", "company.id", "division.companyId")
        .select([
          "division.uuid",
          "division.code",
          "division.name",
          "company.uuid as companyUuid",
        ])
        .where("division.isActive", true)
        .whereNull("division.deletedAt")
        .where("company.isActive", true)
        .whereNull("company.deletedAt")
        .modify((builder) => {
          if (selectedCompany) {
            builder.where("division.companyId", selectedCompany.id);
          }
        })
        .orderBy("division.name", "asc");

      const rolesQuery = db("roles as role")
        .leftJoin("companies as company", "company.id", "role.companyId")
        .select([
          "role.uuid",
          "role.code",
          "role.name",
          "role.description",
          "role.isSystem",
          "role.isActive",
          "company.uuid as companyUuid",
          "company.code as companyCode",
          "company.name as companyName",
        ])
        .where("role.isActive", true)
        .modify((builder) => {
          if (selectedCompany) {
            builder.where("role.companyId", selectedCompany.id);
          }

          if (!actorIsSystemDeveloper) {
            builder.whereNot("role.code", "SYSTEM_DEVELOPER");
          }
        })
        .orderBy("role.name", "asc");

      const [companies, divisions, roles] = await Promise.all([
        companiesQuery,
        divisionsQuery,
        rolesQuery,
      ]);

      return res.success({
        companies,
        divisions,
        roles,
      });
    } catch (error) {
      console.error("GET /user/options error:", error);

      return res.fail(error.message || "Failed to load user options.");
    }
  })

  /**
   * GET /user/:uuid
   */
  .get("/:uuid", async (req, res) => {
    try {
      const user = await findUserByUuid(req.params.uuid);

      if (!user) {
        return res.incomplete("User tidak ditemukan.");
      }

      return res.success(user);
    } catch (error) {
      console.error("GET /user/:uuid error:", error);

      return res.fail(error.message || "Failed to load user.");
    }
  })

  /**
   * POST /user
   */
  .post("/", async (req, res) => {
    const trx = await db.transaction();

    try {
      const payload = normalizePayload(req.body, true);
      const validation = validatePayload(payload, true);

      if (!validation.valid) {
        await trx.rollback();

        return res.incomplete(validation.message);
      }

      const relations = await validateRelations(trx, payload, req);

      if (!relations.valid) {
        await trx.rollback();

        return res.incomplete(relations.message);
      }

      const duplicateEmail = await trx("users")
        .whereRaw("LOWER(email) = ?", [payload.email])
        .whereNull("deletedAt")
        .first("id");

      if (duplicateEmail) {
        await trx.rollback();

        return res.incomplete(`Email "${payload.email}" sudah digunakan.`);
      }

      const uuid = randomUUID();
      const now = db.fn.now();
      const passwordHash = await bcrypt.hash(payload.password, 12);

      const insertedIds = await trx("users").insert({
        uuid,
        companyId: relations.company.id,
        divisionId: relations.division?.id ?? null,
        departmentId: null,
        email: payload.email,
        password: passwordHash,
        fullName: payload.fullName,
        phone: payload.phone,
        isActive: payload.isActive,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });

      const userId = Array.isArray(insertedIds) ? insertedIds[0] : insertedIds;

      await replaceUserRoles(trx, userId, relations.roles);
      await trx.commit();

      return res.success(await findUserByUuid(uuid));
    } catch (error) {
      await trx.rollback();

      console.error("POST /user error:", error);

      return res.fail(error.message || "Failed to create user.");
    }
  })

  /**
   * PUT /user/:uuid
   */
  .put("/:uuid", async (req, res) => {
    const trx = await db.transaction();

    try {
      const existingUser = await trx("users")
        .where("uuid", req.params.uuid)
        .whereNull("deletedAt")
        .first();

      if (!existingUser) {
        await trx.rollback();

        return res.incomplete("User tidak ditemukan.");
      }

      const payload = normalizePayload(req.body, false);
      const validation = validatePayload(payload, false);

      if (!validation.valid) {
        await trx.rollback();

        return res.incomplete(validation.message);
      }

      const relations = await validateRelations(trx, payload, req);

      if (!relations.valid) {
        await trx.rollback();

        return res.incomplete(relations.message);
      }

      const existingSystemDeveloperRole = await trx("userRoles as userRole")
        .join("roles as role", "role.id", "userRole.roleId")
        .where("userRole.userId", existingUser.id)
        .where("role.code", "SYSTEM_DEVELOPER")
        .first("userRole.id");

      if (existingSystemDeveloperRole && !isSystemDeveloper(req)) {
        await trx.rollback();

        return res.unauthorized(
          "Global Admin tidak dapat mengubah akun System Developer.",
        );
      }

      const duplicateEmail = await trx("users")
        .whereRaw("LOWER(email) = ?", [payload.email])
        .whereNot("id", existingUser.id)
        .whereNull("deletedAt")
        .first("id");

      if (duplicateEmail) {
        await trx.rollback();

        return res.incomplete(`Email "${payload.email}" sudah digunakan.`);
      }

      await trx("users")
        .where("id", existingUser.id)
        .update({
          companyId: relations.company.id,
          divisionId: relations.division?.id ?? null,
          departmentId: null,
          email: payload.email,
          fullName: payload.fullName,
          phone: payload.phone,
          isActive: payload.isActive,
          updatedAt: db.fn.now(),
        });

      await replaceUserRoles(trx, existingUser.id, relations.roles);

      if (!payload.isActive) {
        await revokeRefreshTokens(trx, existingUser.id);
      }

      await trx.commit();

      return res.success(await findUserByUuid(req.params.uuid));
    } catch (error) {
      await trx.rollback();

      console.error("PUT /user/:uuid error:", error);

      return res.fail(error.message || "Failed to update user.");
    }
  })

  /**
   * PUT /user/:uuid/roles
   *
   * Payload:
   * {
   *   roleUuids: string[]
   * }
   */
  .put("/:uuid/roles", async (req, res) => {
    const trx = await db.transaction();

    try {
      const user = await trx("users")
        .where("uuid", req.params.uuid)
        .whereNull("deletedAt")
        .first(["id", "uuid", "companyId"]);

      if (!user) {
        await trx.rollback();

        return res.incomplete("User tidak ditemukan.");
      }

      const roleUuids = normalizeUuidArray(req.body?.roleUuids);

      if (!roleUuids.length) {
        await trx.rollback();

        return res.incomplete("Minimal satu role wajib dipilih.");
      }

      const currentSystemDeveloperRole = await trx("userRoles as userRole")
        .join("roles as role", "role.id", "userRole.roleId")
        .where("userRole.userId", user.id)
        .where("role.code", "SYSTEM_DEVELOPER")
        .first("userRole.id");

      if (currentSystemDeveloperRole && !isSystemDeveloper(req)) {
        await trx.rollback();

        return res.unauthorized(
          "Global Admin tidak dapat mengubah role System Developer.",
        );
      }

      const roles = await trx("roles")
        .select(["id", "uuid", "code", "companyId", "isSystem"])
        .whereIn("uuid", roleUuids)
        .where("isActive", true);

      const roleValidation = validateRoleSelection(
        roles,
        roleUuids,
        user.companyId,
        req,
      );

      if (!roleValidation.valid) {
        await trx.rollback();

        return res.incomplete(roleValidation.message);
      }

      await replaceUserRoles(trx, user.id, roles);
      await revokeRefreshTokens(trx, user.id);
      await trx.commit();

      return res.success(await findUserByUuid(user.uuid));
    } catch (error) {
      await trx.rollback();

      console.error("PUT /user/:uuid/roles error:", error);

      return res.fail(error.message || "Failed to update user roles.");
    }
  })

  /**
   * PUT /user/:uuid/reset-password
   */
  .put(
    "/:uuid/reset-password",
    authorization("USER.RESET_PASSWORD", {
      holderOnly: true,
    }),
    async (req, res) => {
      const trx = await db.transaction();

      try {
        const password = normalizeRequiredString(req.body?.password);

        if (password.length < 8 || password.length > 100) {
          await trx.rollback();

          return res.incomplete("Password harus 8 sampai 100 karakter.");
        }

        const user = await trx("users")
          .where("uuid", req.params.uuid)
          .whereNull("deletedAt")
          .first(["id", "uuid"]);

        if (!user) {
          await trx.rollback();

          return res.incomplete("User tidak ditemukan.");
        }

        const systemDeveloperRole = await trx("userRoles as userRole")
          .join("roles as role", "role.id", "userRole.roleId")
          .where("userRole.userId", user.id)
          .where("role.code", "SYSTEM_DEVELOPER")
          .first("userRole.id");

        if (systemDeveloperRole && !isSystemDeveloper(req)) {
          await trx.rollback();

          return res.unauthorized(
            "Global Admin tidak dapat mereset password System Developer.",
          );
        }

        await trx("users")
          .where("id", user.id)
          .update({
            password: await bcrypt.hash(password, 12),
            updatedAt: db.fn.now(),
          });

        await revokeRefreshTokens(trx, user.id);
        await trx.commit();

        return res.success({
          uuid: user.uuid,
        });
      } catch (error) {
        await trx.rollback();

        console.error("PUT /user/:uuid/reset-password error:", error);

        return res.fail(error.message || "Failed to reset password.");
      }
    },
  )

  /**
   * PUT /user/:uuid/reset-default-password
   */
  .put(
    "/:uuid/reset-default-password",
    authorization("USER.RESET_PASSWORD", {
      holderOnly: true,
    }),
    async (req, res) => {
      const trx = await db.transaction();

      try {
        const defaultPassword = normalizeRequiredString(
          process.env.DEFAULT_USER_PASSWORD,
        );

        if (defaultPassword.length < 8 || defaultPassword.length > 100) {
          await trx.rollback();

          return res.fail("Default user password configuration is invalid.");
        }

        const user = await trx("users")
          .where("uuid", req.params.uuid)
          .whereNull("deletedAt")
          .first(["id", "uuid", "fullName", "email", "isActive"]);

        if (!user) {
          await trx.rollback();

          return res.incomplete("User tidak ditemukan.");
        }

        const systemDeveloperRole = await trx("userRoles as userRole")
          .join("roles as role", "role.id", "userRole.roleId")
          .where("userRole.userId", user.id)
          .where("role.code", "SYSTEM_DEVELOPER")
          .first("userRole.id");

        if (systemDeveloperRole && !isSystemDeveloper(req)) {
          await trx.rollback();

          return res.unauthorized(
            "Global Admin tidak dapat mereset password System Developer.",
          );
        }

        await trx("users")
          .where("id", user.id)
          .update({
            password: await bcrypt.hash(defaultPassword, 12),
            updatedAt: db.fn.now(),
          });

        await revokeRefreshTokens(trx, user.id);
        await trx.commit();

        return res.success(
          {
            uuid: user.uuid,
            fullName: user.fullName,
            email: user.email,
          },
          "Password berhasil dikembalikan ke default.",
        );
      } catch (error) {
        await trx.rollback();

        console.error("PUT /user/:uuid/reset-default-password error:", error);

        return res.fail(
          error.message || "Failed to reset password to default.",
        );
      }
    },
  )

  /**
   * DELETE /user/:uuid
   *
   * Soft delete / deactivate.
   */
  .delete("/:uuid", async (req, res) => {
    const trx = await db.transaction();

    try {
      const user = await trx("users")
        .where("uuid", req.params.uuid)
        .whereNull("deletedAt")
        .first(["id", "uuid", "isActive"]);

      if (!user) {
        await trx.rollback();

        return res.incomplete("User tidak ditemukan.");
      }

      if (!Boolean(user.isActive)) {
        await trx.commit();

        return res.success({
          uuid: user.uuid,
          isActive: false,
        });
      }

      const systemDeveloperRole = await trx("userRoles as userRole")
        .join("roles as role", "role.id", "userRole.roleId")
        .where("userRole.userId", user.id)
        .where("role.code", "SYSTEM_DEVELOPER")
        .first("userRole.id");

      if (systemDeveloperRole && !isSystemDeveloper(req)) {
        await trx.rollback();

        return res.unauthorized(
          "Global Admin tidak dapat menonaktifkan System Developer.",
        );
      }

      const authenticatedUser = req.getUser?.();
      const authenticatedUserId =
        authenticatedUser?.userId ?? authenticatedUser?.id;

      if (Number(authenticatedUserId) === Number(user.id)) {
        await trx.rollback();

        return res.incomplete(
          "User tidak dapat menonaktifkan akunnya sendiri.",
        );
      }

      await trx("users").where("id", user.id).update({
        isActive: false,
        updatedAt: db.fn.now(),
      });

      await revokeRefreshTokens(trx, user.id);

      await trx.commit();

      return res.success({
        uuid: user.uuid,
        isActive: false,
      });
    } catch (error) {
      await trx.rollback();

      console.error("DELETE /user/:uuid error:", error);

      return res.fail(error.message || "Failed to deactivate user.");
    }
  });
async function findUserByUuid(uuid) {
  const user = await db("users as user")
    .join("companies as company", "company.id", "user.companyId")
    .leftJoin("divisions as division", "division.id", "user.divisionId")
    .select([
      "user.uuid",
      "user.email",
      "user.fullName",
      "user.phone",
      "user.isActive",
      "user.lastLoginAt",
      "user.createdAt",
      "user.updatedAt",
      "company.uuid as companyUuid",
      "company.code as companyCode",
      "company.name as companyName",
      "division.uuid as divisionUuid",
      "division.code as divisionCode",
      "division.name as divisionName",
    ])
    .where("user.uuid", uuid)
    .whereNull("user.deletedAt")
    .first();

  if (!user) {
    return null;
  }

  user.roles = await db("userRoles as userRole")
    .join("roles as role", "role.id", "userRole.roleId")
    .leftJoin("companies as roleCompany", "roleCompany.id", "role.companyId")
    .select([
      "role.uuid",
      "role.code",
      "role.name",
      "role.description",
      "role.isSystem",
      "roleCompany.uuid as companyUuid",
      "roleCompany.code as companyCode",
      "roleCompany.name as companyName",
    ])
    .where("userRole.userId", db("users").select("id").where("uuid", uuid))
    .orderBy("role.name", "asc");

  return user;
}

async function validateRelations(trx, payload, req) {
  const company = await trx("companies")
    .where("uuid", payload.companyUuid)
    .where("isActive", true)
    .whereNull("deletedAt")
    .first(["id", "uuid", "code", "name"]);

  if (!company) {
    return {
      valid: false,
      message: "Company tidak valid atau tidak aktif.",
    };
  }

  let division = null;

  if (payload.divisionUuid) {
    division = await trx("divisions")
      .where("uuid", payload.divisionUuid)
      .where("companyId", company.id)
      .where("isActive", true)
      .whereNull("deletedAt")
      .first(["id", "uuid"]);

    if (!division) {
      return {
        valid: false,
        message: "Division tidak sesuai dengan company yang dipilih.",
      };
    }
  }

  const roles = await trx("roles")
    .select(["id", "uuid", "code", "companyId", "isSystem"])
    .whereIn("uuid", payload.roleUuids)
    .where("isActive", true);

  const roleValidation = validateRoleSelection(
    roles,
    payload.roleUuids,
    company.id,
    req,
  );

  if (!roleValidation.valid) {
    return roleValidation;
  }

  return {
    valid: true,
    company,
    division,
    roles,
  };
}

function validateRoleSelection(roles, requestedRoleUuids, companyId, req) {
  if (roles.length !== requestedRoleUuids.length) {
    return {
      valid: false,
      message: "Satu atau lebih role tidak valid atau tidak aktif.",
    };
  }

  if (
    !isSystemDeveloper(req) &&
    roles.some((role) => role.code === "SYSTEM_DEVELOPER")
  ) {
    return {
      valid: false,
      message: "Global Admin tidak dapat memberikan role SYSTEM_DEVELOPER.",
    };
  }

  const incompatibleRole = roles.find((role) => {
    if (role.code === "SYSTEM_DEVELOPER" && isSystemDeveloper(req)) {
      return false;
    }

    return Number(role.companyId) !== Number(companyId);
  });

  if (incompatibleRole) {
    return {
      valid: false,
      message: `Role "${incompatibleRole.code}" tidak sesuai dengan company user.`,
    };
  }

  return {
    valid: true,
  };
}

async function replaceUserRoles(trx, userId, roles) {
  await trx("userRoles").where("userId", userId).delete();

  if (!roles.length) {
    return;
  }

  await trx("userRoles").insert(
    roles.map((role) => ({
      userId,
      roleId: role.id,
      createdAt: db.fn.now(),
    })),
  );
}

async function revokeRefreshTokens(trx, userId) {
  await trx("refreshTokens")
    .where("userId", userId)
    .whereNull("revokedAt")
    .update({
      revokedAt: db.fn.now(),
    });
}

function normalizePayload(payload = {}, includePassword = false) {
  const normalizedPayload = {
    companyUuid: normalizeRequiredString(payload.companyUuid),
    divisionUuid: normalizeNullableString(payload.divisionUuid),
    email: normalizeRequiredString(payload.email).toLowerCase(),
    fullName: normalizeRequiredString(payload.fullName),
    phone: normalizeNullableString(payload.phone),
    isActive: normalizeBoolean(payload.isActive, true),
    roleUuids: normalizeUuidArray(payload.roleUuids),
  };

  if (includePassword) {
    normalizedPayload.password = normalizeRequiredString(payload.password);
  }

  return normalizedPayload;
}

function validatePayload(payload, includePassword) {
  if (!payload.companyUuid) {
    return invalid("Company wajib dipilih.");
  }

  if (!payload.fullName) {
    return invalid("Nama lengkap wajib diisi.");
  }

  if (payload.fullName.length > 150) {
    return invalid("Nama lengkap maksimal 150 karakter.");
  }

  if (!payload.email || !isValidEmail(payload.email)) {
    return invalid("Email tidak valid.");
  }

  if (payload.email.length > 150) {
    return invalid("Email maksimal 150 karakter.");
  }

  if (payload.phone && payload.phone.length > 30) {
    return invalid("Phone maksimal 30 karakter.");
  }

  if (!payload.roleUuids.length) {
    return invalid("Minimal satu role wajib dipilih.");
  }

  if (
    includePassword &&
    (payload.password.length < 8 || payload.password.length > 100)
  ) {
    return invalid("Password harus 8 sampai 100 karakter.");
  }

  return {
    valid: true,
  };
}

function normalizeUuidArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.map(normalizeRequiredString).filter(Boolean))];
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

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isSystemDeveloper(req) {
  const data = req.getData?.() || {};
  const roleCodes = data?.access?.roleCodes || data?.roleCodes || [];

  return Array.isArray(roleCodes) && roleCodes.includes("SYSTEM_DEVELOPER");
}

function normalizeListRow(row) {
  return {
    ...row,
    roleCount: Number(row.roleCount || 0),
    roleNames: row.roleNames || "",
  };
}

module.exports = router;
