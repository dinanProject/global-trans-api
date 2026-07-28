"use strict";

const db = require("./db")();

async function getUserAccess(userId, trx = db) {
  const user = await trx("users as u")
    .leftJoin("companies as c", function () {
      this.on("c.id", "=", "u.companyId").andOnNull("c.deletedAt");
    })
    .leftJoin("divisions as d", function () {
      this.on("d.id", "=", "u.divisionId").andOnNull("d.deletedAt");
    })
    .select([
      "u.id",
      "u.uuid",
      "u.email",
      "u.fullName",
      "u.phone",
      "u.companyId",
      "u.divisionId",
      "u.departmentId",
      "u.isActive",
      "u.lastLoginAt",

      "c.uuid as companyUuid",
      "c.code as companyCode",
      "c.name as companyName",
      "c.type as companyType",
      "c.isActive as companyIsActive",

      "d.uuid as divisionUuid",
      "d.code as divisionCode",
      "d.name as divisionName",
    ])
    .where("u.id", userId)
    .where("u.isActive", true)
    .whereNull("u.deletedAt")
    .first();

  if (!user) {
    return null;
  }

  const roles = await trx("userRoles as ur")
    .join("roles as r", "r.id", "ur.roleId")
    .select([
      "r.id",
      "r.uuid",
      "r.code",
      "r.name",
      "r.description",
      "r.isSystem",
      "r.isActive",
    ])
    .where("ur.userId", user.id)
    .where("r.isActive", true)
    .distinct()
    .orderBy("r.name", "asc");

  const permissions = await trx("userRoles as ur")
    .join("roles as r", "r.id", "ur.roleId")
    .join("rolePermissions as rp", "rp.roleId", "r.id")
    .join("permissions as p", "p.permissionId", "rp.permissionId")
    .select([
      "p.permissionId as id",
      "p.uuid",
      "p.code",
      "p.scope",
      "p.label",
      "p.module",
      "p.action",
      "p.description",
    ])
    .where("ur.userId", user.id)
    .where("r.isActive", true)
    .where("p.isActive", true)
    .distinct()
    .orderBy("p.code", "asc");

  return {
    user: {
      id: user.id,
      uuid: user.uuid,
      email: user.email,
      fullName: user.fullName,
      phone: user.phone,
      companyId: user.companyId,
      divisionId: user.divisionId,
      departmentId: user.departmentId,
      isActive: Boolean(user.isActive),
      lastLoginAt: user.lastLoginAt,
    },

    company: user.companyId
      ? {
          id: user.companyId,
          uuid: user.companyUuid,
          code: user.companyCode,
          name: user.companyName,
          type: user.companyType,
          isActive: Boolean(user.companyIsActive),
        }
      : null,

    division: user.divisionId
      ? {
          id: user.divisionId,
          uuid: user.divisionUuid,
          code: user.divisionCode,
          name: user.divisionName,
        }
      : null,

    roles: roles.map((role) => ({
      id: role.id,
      uuid: role.uuid,
      code: role.code,
      name: role.name,
      description: role.description,
      isSystem: Boolean(role.isSystem),
      isActive: Boolean(role.isActive),
    })),

    permissions,

    roleCodes: roles.map((role) => role.code),

    permissionCodes: permissions.map((permission) => permission.code),
  };
}

module.exports = {
  getUserAccess,
};
