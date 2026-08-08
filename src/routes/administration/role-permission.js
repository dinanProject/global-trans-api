"use strict";

const express = require("express");

const db = require("../../lib/db")();
const {
  authenticate: authentication,
} = require("../../modules/access/access.middleware");

const router = express.Router();

router.use(authentication);

router
  .get("/", async (req, res, next) => {
    try {
      const roles = await db("roles as r")
        .leftJoin("rolePermissions as rp", "rp.roleId", "r.id")
        .leftJoin("userRoles as ur", "ur.roleId", "r.id")

        .select([
          "r.uuid",

          "r.code",

          "r.name",

          "r.description",

          "r.isSystem",

          "r.isActive",
        ])

        .countDistinct({
          permissionCount: "rp.permissionId",
        })

        .countDistinct({
          userCount: "ur.userId",
        })

        .groupBy([
          "r.id",

          "r.uuid",

          "r.code",

          "r.name",

          "r.description",

          "r.isSystem",

          "r.isActive",
        ])

        .orderBy("r.name", "asc");

      return res.success(
        roles.map((role) => ({
          uuid: role.uuid,

          code: role.code,

          name: role.name,

          description: role.description,

          isSystem: Boolean(role.isSystem),

          isActive: Boolean(role.isActive),

          permissionCount: Number(role.permissionCount || 0),

          userCount: Number(role.userCount || 0),
        })),
      );
    } catch (error) {
      return next(error);
    }
  })
  /**
   * GET /role-permission/:roleUuid
   */
  .get("/:roleUuid", async (req, res, next) => {
    try {
      const role = await db("roles")
        .select(["id", "uuid", "code", "name", "isSystem", "isActive"])
        .where("uuid", req.params.roleUuid)
        .first();

      if (!role) {
        return res.fail("Role tidak ditemukan");
      }

      const permissions = await db("permissions as p")
        .leftJoin("rolePermissions as rp", function joinRolePermission() {
          this.on("rp.permissionId", "=", "p.permissionId").andOn(
            "rp.roleId",
            "=",
            db.raw("?", [role.id]),
          );
        })
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
          "rp.id as rolePermissionId",
          "rp.dataScope",
        ])
        .orderBy("p.module", "asc")
        .orderBy("p.action", "asc");

      return res.success({
        role: {
          uuid: role.uuid,
          code: role.code,
          name: role.name,
          isSystem: Boolean(role.isSystem),
          isActive: Boolean(role.isActive),
        },
        permissions: permissions.map((permission) => ({
          permissionId: permission.permissionId,
          uuid: permission.uuid,
          code: permission.code,
          scope: permission.scope,
          label: permission.label,
          module: permission.module,
          action: permission.action,
          description: permission.description,
          isSystem: Boolean(permission.isSystem),
          isActive: Boolean(permission.isActive),
          assigned: permission.rolePermissionId !== null,
          dataScope: permission.dataScope,
        })),
      });
    } catch (error) {
      return next(error);
    }
  })

  /**
   * PUT /role-permission/:roleUuid
   *
   * Payload sederhana:
   *
   * {
   *   "permissionUuids": [
   *     "permission-uuid-1",
   *     "permission-uuid-2"
   *   ]
   * }
   *
   * Atau payload dengan data scope:
   *
   * {
   *   "permissions": [
   *     {
   *       "uuid": "permission-uuid-1",
   *       "dataScope": "ALL"
   *     }
   *   ]
   * }
   */
  .put("/:roleUuid", async (req, res, next) => {
    const trx = await db.transaction();

    try {
      const role = await trx("roles")
        .select(["id", "uuid", "code", "name"])
        .where("uuid", req.params.roleUuid)
        .first();

      if (!role) {
        await trx.rollback();
        return res.fail("Role tidak ditemukan");
      }

      const assignments = normalizeAssignments(req.body);

      if (!assignments.valid) {
        await trx.rollback();
        return res.incomplete(assignments.message);
      }

      const requestedAssignments = assignments.items;
      const permissionUuids = requestedAssignments.map((item) => item.uuid);

      const permissions = permissionUuids.length
        ? await trx("permissions")
            .select(["permissionId", "uuid", "code", "label", "isActive"])
            .whereIn("uuid", permissionUuids)
        : [];

      if (permissions.length !== permissionUuids.length) {
        await trx.rollback();
        return res.fail("Salah satu permission tidak ditemukan");
      }

      const inactivePermission = permissions.find(
        (permission) => !Boolean(permission.isActive),
      );

      if (inactivePermission) {
        await trx.rollback();
        return res.fail(`Permission "${inactivePermission.label}" tidak aktif`);
      }

      const permissionMap = new Map(
        permissions.map((permission) => [permission.uuid, permission]),
      );

      await trx("rolePermissions").where("roleId", role.id).delete();

      if (requestedAssignments.length > 0) {
        await trx("rolePermissions").insert(
          requestedAssignments.map((assignment) => {
            const permission = permissionMap.get(assignment.uuid);

            return {
              roleId: role.id,
              permissionId: permission.permissionId,
              dataScopeId: null,
              dataScope: assignment.dataScope,
              createdAt: trx.fn.now(),
            };
          }),
        );
      }

      await trx.commit();

      return res.success(
        {
          roleUuid: role.uuid,
          permissionCount: requestedAssignments.length,
        },
        "Permission role berhasil diperbarui",
      );
    } catch (error) {
      await trx.rollback();
      return next(error);
    }
  });

function normalizeAssignments(body = {}) {
  if (Array.isArray(body.permissions)) {
    const assignmentMap = new Map();

    for (const item of body.permissions) {
      if (!item || typeof item.uuid !== "string") {
        return {
          valid: false,
          message: "Setiap permission wajib memiliki uuid",
          items: [],
        };
      }

      const uuid = item.uuid.trim();
      const dataScope = normalizeDataScope(item.dataScope);

      if (!uuid) {
        return {
          valid: false,
          message: "UUID permission tidak boleh kosong",
          items: [],
        };
      }

      if (!dataScope) {
        return {
          valid: false,
          message: "dataScope harus OWN, COMPANY, atau ALL",
          items: [],
        };
      }

      assignmentMap.set(uuid, {
        uuid,
        dataScope,
      });
    }

    return {
      valid: true,
      message: null,
      items: [...assignmentMap.values()],
    };
  }

  if (Array.isArray(body.permissionUuids)) {
    const permissionUuids = [
      ...new Set(
        body.permissionUuids
          .filter((value) => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ];

    return {
      valid: true,
      message: null,
      items: permissionUuids.map((uuid) => ({
        uuid,
        dataScope: "ALL",
      })),
    };
  }

  return {
    valid: false,
    message: "Kirim permissionUuids berupa array atau permissions berupa array",
    items: [],
  };
}

function normalizeDataScope(value) {
  if (typeof value !== "string") {
    return "ALL";
  }

  const normalizedValue = value.trim().toUpperCase();

  if (["OWN", "COMPANY", "ALL"].includes(normalizedValue)) {
    return normalizedValue;
  }

  return null;
}

module.exports = router;
