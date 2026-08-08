"use strict";

const crypto = require("node:crypto");
const express = require("express");

const db = require("../../lib/db")();
const authentication = require("../../lib/authentication");
const authorization = require("../../lib/authorization");

const router = express.Router();

router.use(authentication);

router

  /**
   * GET /division
   *
   * Mendapatkan seluruh division.
   *
   * Query parameter opsional:
   *
   * search
   * companyUuid
   * isActive
   */
  .get(
    "/",
    authorization(
      [
        "DIVISION.VIEW",
        "EQUIPMENT_REQUEST.VIEW",
        "EQUIPMENT_REQUEST.CREATE",
        "EQUIPMENT_REQUEST.UPDATE",
      ],
      {
        requireAll: false,
      },
    ),
    async (req, res, next) => {
      try {
        const filters = normalizeListFilters(req.query);

        const query = db("divisions as division")
          .join("companies as company", "company.id", "division.companyId")
          .select([
            "division.id",
            "division.uuid",
            "division.companyId",
            "company.uuid as companyUuid",
            "company.code as companyCode",
            "company.name as companyName",
            "division.code",
            "division.name",
            "division.description",
            "division.isActive",
            "division.createdAt",
            "division.updatedAt",
          ])
          .whereNull("division.deletedAt")
          .whereNull("company.deletedAt");

        if (filters.companyId) {
          query.where("division.companyId", filters.companyId);
        }

        if (filters.companyUuid) {
          query.where("company.uuid", filters.companyUuid);
        }

        if (filters.isActive !== null) {
          query.where("division.isActive", filters.isActive);
        }

        if (filters.search) {
          query.andWhere((builder) => {
            builder
              .whereRaw("LOWER(division.code) LIKE ?", [
                `%${filters.search.toLowerCase()}%`,
              ])
              .orWhereRaw("LOWER(division.name) LIKE ?", [
                `%${filters.search.toLowerCase()}%`,
              ])
              .orWhereRaw("LOWER(company.name) LIKE ?", [
                `%${filters.search.toLowerCase()}%`,
              ]);
          });
        }

        const divisions = await query
          .orderBy("company.name", "asc")
          .orderBy("division.name", "asc")
          .orderBy("division.id", "asc");

        return res.success(
          divisions.map((division) => ({
            ...division,
            isActive: Boolean(division.isActive),
          })),
        );
      } catch (error) {
        return next(error);
      }
    },
  )

  /**
   * GET /division/:uuid
   *
   * Mendapatkan detail satu division.
   */
  .get("/:uuid", authorization("DIVISION.VIEW"), async (req, res, next) => {
    try {
      const division = await getDivisionDetail(req.params.uuid);

      if (!division) {
        return res.fail("Division tidak ditemukan");
      }

      return res.success({
        ...division,
        isActive: Boolean(division.isActive),
      });
    } catch (error) {
      return next(error);
    }
  })

  /**
   * POST /division
   *
   * Membuat division baru.
   */
  .post("/", authorization("DIVISION.CREATE"), async (req, res, next) => {
    try {
      const payload = normalizePayload(req.body);
      const validationMessage = validatePayload(payload);

      if (validationMessage) {
        return res.incomplete(validationMessage);
      }

      const company = await getCompany(payload.companyUuid);

      if (!company) {
        return res.fail("Company tidak ditemukan");
      }

      if (!Boolean(company.isActive)) {
        return res.fail(`Company "${company.name}" sedang tidak aktif`);
      }

      const duplicateCode = await db("divisions")
        .select(["id"])
        .where("companyId", company.id)
        .whereNull("deletedAt")
        .whereRaw("LOWER(code) = LOWER(?)", [payload.code])
        .first();

      if (duplicateCode) {
        return res.fail(
          `Code division "${payload.code}" sudah digunakan pada company "${company.name}"`,
        );
      }

      const duplicateName = await db("divisions")
        .select(["id"])
        .where("companyId", company.id)
        .whereNull("deletedAt")
        .whereRaw("LOWER(name) = LOWER(?)", [payload.name])
        .first();

      if (duplicateName) {
        return res.fail(
          `Nama division "${payload.name}" sudah digunakan pada company "${company.name}"`,
        );
      }

      const uuid = crypto.randomUUID();

      await db("divisions").insert({
        uuid,
        companyId: company.id,
        code: payload.code,
        name: payload.name,
        description: payload.description,
        isActive: payload.isActive,
      });

      const createdDivision = await getDivisionDetail(uuid);

      return res.success(
        {
          ...createdDivision,
          isActive: Boolean(createdDivision.isActive),
        },
        "Division berhasil dibuat",
        201,
      );
    } catch (error) {
      return next(error);
    }
  })

  /**
   * PUT /division/:uuid
   *
   * Memperbarui division.
   *
   * Karena menggunakan PUT, kirim payload lengkap.
   */
  .put("/:uuid", authorization("DIVISION.UPDATE"), async (req, res, next) => {
    try {
      const existingDivision = await db("divisions")
        .select(["id", "uuid", "companyId", "code", "name", "isActive"])
        .where("uuid", req.params.uuid)
        .whereNull("deletedAt")
        .first();

      if (!existingDivision) {
        return res.fail("Division tidak ditemukan");
      }

      const payload = normalizePayload(req.body);
      const validationMessage = validatePayload(payload);

      if (validationMessage) {
        return res.incomplete(validationMessage);
      }

      const company = await getCompany(payload.companyUuid);

      if (!company) {
        return res.fail("Company tidak ditemukan");
      }

      if (!Boolean(company.isActive)) {
        return res.fail(`Company "${company.name}" sedang tidak aktif`);
      }

      const duplicateCode = await db("divisions")
        .select(["id"])
        .where("companyId", company.id)
        .whereNull("deletedAt")
        .whereRaw("LOWER(code) = LOWER(?)", [payload.code])
        .whereNot("id", existingDivision.id)
        .first();

      if (duplicateCode) {
        return res.fail(
          `Code division "${payload.code}" sudah digunakan pada company "${company.name}"`,
        );
      }

      const duplicateName = await db("divisions")
        .select(["id"])
        .where("companyId", company.id)
        .whereNull("deletedAt")
        .whereRaw("LOWER(name) = LOWER(?)", [payload.name])
        .whereNot("id", existingDivision.id)
        .first();

      if (duplicateName) {
        return res.fail(
          `Nama division "${payload.name}" sudah digunakan pada company "${company.name}"`,
        );
      }

      const isBeingDeactivated =
        Boolean(existingDivision.isActive) && !payload.isActive;

      if (isBeingDeactivated) {
        const dependencyMessage = await getDeactivateDependencyMessage(
          existingDivision.id,
        );

        if (dependencyMessage) {
          return res.fail(dependencyMessage);
        }
      }

      await db("divisions").where("id", existingDivision.id).update({
        companyId: company.id,
        code: payload.code,
        name: payload.name,
        description: payload.description,
        isActive: payload.isActive,
        updatedAt: db.fn.now(),
      });

      const updatedDivision = await getDivisionDetail(existingDivision.uuid);

      return res.success(
        {
          ...updatedDivision,
          isActive: Boolean(updatedDivision.isActive),
        },
        "Division berhasil diperbarui",
      );
    } catch (error) {
      return next(error);
    }
  })

  /**
   * DELETE /division/:uuid
   *
   * Soft delete:
   *
   * isActive = false
   * deletedAt = current timestamp
   *
   * Division tidak dapat dihapus apabila masih memiliki:
   *
   * - department aktif
   * - user aktif
   */
  .delete(
    "/:uuid",
    authorization("DIVISION.DELETE"),
    async (req, res, next) => {
      try {
        const division = await db("divisions")
          .select([
            "id",
            "uuid",
            "companyId",
            "code",
            "name",
            "isActive",
            "deletedAt",
          ])
          .where("uuid", req.params.uuid)
          .first();

        if (!division || division.deletedAt) {
          return res.fail("Division tidak ditemukan");
        }

        const dependencyMessage = await getDeleteDependencyMessage(division.id);

        if (dependencyMessage) {
          return res.fail(dependencyMessage);
        }

        await db("divisions").where("id", division.id).update({
          isActive: false,
          deletedAt: db.fn.now(),
          updatedAt: db.fn.now(),
        });

        return res.success(
          {
            uuid: division.uuid,
            isActive: false,
          },
          "Division berhasil dihapus",
        );
      } catch (error) {
        return next(error);
      }
    },
  );

async function getDivisionDetail(uuid) {
  return db("divisions as division")
    .join("companies as company", "company.id", "division.companyId")
    .select([
      "division.id",
      "division.uuid",
      "division.companyId",
      "company.uuid as companyUuid",
      "company.code as companyCode",
      "company.name as companyName",
      "division.code",
      "division.name",
      "division.description",
      "division.isActive",
      "division.createdAt",
      "division.updatedAt",
    ])
    .where("division.uuid", uuid)
    .whereNull("division.deletedAt")
    .whereNull("company.deletedAt")
    .first();
}

async function getCompany(companyUuid) {
  if (!companyUuid) {
    return null;
  }

  return db("companies")
    .select(["id", "uuid", "code", "name", "type", "isActive"])
    .where("uuid", companyUuid)
    .whereNull("deletedAt")
    .first();
}

async function getDeactivateDependencyMessage(divisionId) {
  const activeDepartment = await db("departments")
    .select(["id", "name"])
    .where("divisionId", divisionId)
    .where("isActive", true)
    .whereNull("deletedAt")
    .first();

  if (activeDepartment) {
    return `Division tidak dapat dinonaktifkan karena masih memiliki department aktif, yaitu "${activeDepartment.name}"`;
  }

  const activeUser = await db("users")
    .select(["id", "fullName"])
    .where("divisionId", divisionId)
    .where("isActive", true)
    .whereNull("deletedAt")
    .first();

  if (activeUser) {
    return `Division tidak dapat dinonaktifkan karena masih digunakan oleh user aktif, yaitu "${activeUser.fullName}"`;
  }

  return null;
}

async function getDeleteDependencyMessage(divisionId) {
  const department = await db("departments")
    .select(["id", "name", "isActive"])
    .where("divisionId", divisionId)
    .whereNull("deletedAt")
    .first();

  if (department) {
    return `Division tidak dapat dihapus karena masih memiliki department "${department.name}"`;
  }

  const user = await db("users")
    .select(["id", "fullName", "isActive"])
    .where("divisionId", divisionId)
    .whereNull("deletedAt")
    .first();

  if (user) {
    return `Division tidak dapat dihapus karena masih digunakan oleh user "${user.fullName}"`;
  }

  return null;
}

function normalizePayload(body = {}) {
  return {
    companyUuid: normalizeRequiredString(body.companyUuid),
    code: normalizeRequiredString(body.code).toUpperCase(),
    name: normalizeRequiredString(body.name),
    description: normalizeNullableString(body.description),
    isActive: normalizeBoolean(body.isActive, true),
  };
}

function normalizeListFilters(query = {}) {
  return {
    search: normalizeNullableString(query.search),
    companyId: normalizeNullablePositiveInteger(query.companyId),
    companyUuid: normalizeNullableString(query.companyUuid),
    isActive: normalizeNullableBoolean(query.isActive),
  };
}

function validatePayload(payload) {
  if (!payload.companyUuid) {
    return "Company wajib dipilih";
  }

  if (!payload.code) {
    return "Code division wajib diisi";
  }

  if (!payload.name) {
    return "Nama division wajib diisi";
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
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function normalizeNullableBoolean(value) {
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
    const normalizedValue = value.trim().toLowerCase();

    if (["true", "1", "yes", "on"].includes(normalizedValue)) {
      return true;
    }

    if (["false", "0", "no", "off"].includes(normalizedValue)) {
      return false;
    }
  }

  return fallback;
}

module.exports = router;
