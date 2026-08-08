"use strict";

const express = require("express");

const route = express.Router();

const {
  authenticate: authentication,
  authorize: authorization,
} = require("../../modules/access/access.middleware");
const db = require("../../lib/db")();

route
  /**
   * List users and their assigned roles.
   *
   * GET /user-role
   */
  .get(
    "/",
    authentication,
    authorization("USER.ROLE.ASSIGN", {
      holderOnly: true,
    }),
    async function (req, res, next) {
      try {
        const search = String(req.query.search || "").trim();
        const isActive = req.query.isActive;

        const query = db("users as u")
          .leftJoin("companies as c", function () {
            this.on("c.id", "=", "u.companyId").andOnNull("c.deletedAt");
          })
          .leftJoin("divisions as d", function () {
            this.on("d.id", "=", "u.divisionId").andOnNull("d.deletedAt");
          })
          .select([
            "u.id",
            "u.uuid",
            "u.fullName",
            "u.email",
            "u.phone",
            "u.isActive",
            "u.createdAt",

            "c.uuid as companyUuid",
            "c.code as companyCode",
            "c.name as companyName",

            "d.uuid as divisionUuid",
            "d.code as divisionCode",
            "d.name as divisionName",
          ])
          .whereNull("u.deletedAt");

        if (search) {
          query.andWhere(function () {
            this.where("u.fullName", "like", `%${search}%`)
              .orWhere("u.email", "like", `%${search}%`)
              .orWhere("c.name", "like", `%${search}%`)
              .orWhere("d.name", "like", `%${search}%`);
          });
        }

        if (isActive !== undefined && isActive !== null && isActive !== "") {
          query.andWhere(
            "u.isActive",
            String(isActive).toLowerCase() === "true",
          );
        }

        const users = await query.orderBy("u.fullName", "asc");

        if (!users.length) {
          return res.success([]);
        }

        const userIds = users.map((user) => user.id);

        const assignedRoles = await db("userRoles as ur")
          .join("roles as r", "r.id", "ur.roleId")
          .select([
            "ur.userId",
            "r.uuid",
            "r.code",
            "r.name",
            "r.description",
            "r.isSystem",
            "r.isActive",
          ])
          .whereIn("ur.userId", userIds)
          .where("r.isActive", true)
          .orderBy("r.name", "asc");

        const rolesByUser = new Map();

        for (const role of assignedRoles) {
          if (!rolesByUser.has(role.userId)) {
            rolesByUser.set(role.userId, []);
          }

          rolesByUser.get(role.userId).push({
            uuid: role.uuid,
            code: role.code,
            name: role.name,
            description: role.description,
            isSystem: Boolean(role.isSystem),
            isActive: Boolean(role.isActive),
          });
        }

        return res.success(
          users.map((user) => ({
            uuid: user.uuid,
            fullName: user.fullName,
            email: user.email,
            phone: user.phone,
            isActive: Boolean(user.isActive),
            createdAt: user.createdAt,

            company: user.companyUuid
              ? {
                  uuid: user.companyUuid,
                  code: user.companyCode,
                  name: user.companyName,
                }
              : null,

            division: user.divisionUuid
              ? {
                  uuid: user.divisionUuid,
                  code: user.divisionCode,
                  name: user.divisionName,
                }
              : null,

            roles: rolesByUser.get(user.id) || [],
          })),
        );
      } catch (err) {
        next(err);
      }
    },
  )

  /**
   * Get user and all assignable roles.
   *
   * GET /user-role/:userUuid
   */
  .get(
    "/:userUuid",
    authentication,
    authorization("USER.ROLE.ASSIGN", {
      holderOnly: true,
    }),
    async function (req, res, next) {
      try {
        const { userUuid } = req.params;

        const user = await db("users as u")
          .leftJoin("companies as c", function () {
            this.on("c.id", "=", "u.companyId").andOnNull("c.deletedAt");
          })
          .leftJoin("divisions as d", function () {
            this.on("d.id", "=", "u.divisionId").andOnNull("d.deletedAt");
          })
          .select([
            "u.id",
            "u.uuid",
            "u.fullName",
            "u.email",
            "u.phone",
            "u.isActive",

            "c.uuid as companyUuid",
            "c.code as companyCode",
            "c.name as companyName",

            "d.uuid as divisionUuid",
            "d.code as divisionCode",
            "d.name as divisionName",
          ])
          .where("u.uuid", userUuid)
          .whereNull("u.deletedAt")
          .first();

        if (!user) {
          return res.fail("User not found.");
        }

        const roles = await db("roles")
          .select([
            "id",
            "uuid",
            "code",
            "name",
            "description",
            "isSystem",
            "isActive",
          ])
          .where("isActive", true)
          .orderBy("name", "asc");

        const assignedRows = await db("userRoles")
          .select("roleId")
          .where("userId", user.id);

        const assignedRoleIds = new Set(
          assignedRows.map((item) => item.roleId),
        );

        return res.success({
          user: {
            uuid: user.uuid,
            fullName: user.fullName,
            email: user.email,
            phone: user.phone,
            isActive: Boolean(user.isActive),

            company: user.companyUuid
              ? {
                  uuid: user.companyUuid,
                  code: user.companyCode,
                  name: user.companyName,
                }
              : null,

            division: user.divisionUuid
              ? {
                  uuid: user.divisionUuid,
                  code: user.divisionCode,
                  name: user.divisionName,
                }
              : null,
          },

          roles: roles.map((role) => ({
            uuid: role.uuid,
            code: role.code,
            name: role.name,
            description: role.description,
            isSystem: Boolean(role.isSystem),
            isActive: Boolean(role.isActive),
            assigned: assignedRoleIds.has(role.id),
          })),
        });
      } catch (err) {
        next(err);
      }
    },
  )

  /**
   * Replace all roles assigned to a user.
   *
   * PUT /user-role/:userUuid
   *
   * {
   *   "roleUuids": ["uuid-1", "uuid-2"]
   * }
   */
  .put(
    "/:userUuid",
    authentication,
    authorization("USER.ROLE.ASSIGN", {
      holderOnly: true,
    }),
    async function (req, res, next) {
      const trx = await db.transaction();

      try {
        const { userUuid } = req.params;
        const { roleUuids } = req.body;

        if (!Array.isArray(roleUuids)) {
          await trx.rollback();

          return res.incomplete("roleUuids must be provided as an array.");
        }

        const normalizedRoleUuids = [
          ...new Set(
            roleUuids
              .filter((uuid) => typeof uuid === "string")
              .map((uuid) => uuid.trim())
              .filter(Boolean),
          ),
        ];

        const user = await trx("users")
          .select(["id", "uuid", "fullName", "email", "isActive"])
          .where("uuid", userUuid)
          .whereNull("deletedAt")
          .forUpdate()
          .first();

        if (!user) {
          await trx.rollback();

          return res.fail("User not found.");
        }

        if (!user.isActive) {
          await trx.rollback();

          return res.incomplete(
            "Roles cannot be assigned to an inactive user.",
          );
        }

        let roles = [];

        if (normalizedRoleUuids.length) {
          roles = await trx("roles")
            .select([
              "id",
              "uuid",
              "code",
              "name",
              "description",
              "isSystem",
              "isActive",
            ])
            .whereIn("uuid", normalizedRoleUuids)
            .where("isActive", true);

          if (roles.length !== normalizedRoleUuids.length) {
            await trx.rollback();

            return res.incomplete(
              "One or more selected roles are invalid or inactive.",
            );
          }
        }

        const access = req.getData()?.access;

        if (access?.user?.id === user.id && roles.length === 0) {
          await trx.rollback();

          return res.incomplete(
            "You cannot remove all roles from your own account.",
          );
        }

        await trx("userRoles").where("userId", user.id).delete();

        if (roles.length) {
          await trx("userRoles").insert(
            roles.map((role) => ({
              userId: user.id,
              roleId: role.id,
              createdAt: new Date(),
            })),
          );
        }

        await trx.commit();

        return res.success(
          {
            user: {
              uuid: user.uuid,
              fullName: user.fullName,
              email: user.email,
            },

            roles: roles.map((role) => ({
              uuid: role.uuid,
              code: role.code,
              name: role.name,
              description: role.description,
              isSystem: Boolean(role.isSystem),
              isActive: Boolean(role.isActive),
            })),
          },
          "User roles updated successfully.",
        );
      } catch (err) {
        await trx.rollback();
        next(err);
      }
    },
  );

module.exports = route;
