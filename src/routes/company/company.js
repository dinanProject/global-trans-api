"use strict";

const express = require("express");
const { randomUUID } = require("crypto");

const router = express.Router();

const authentication = require("../../lib/authentication");
const db = require("../../lib/db")();

router.use(authentication);

/**
 * GET /company
 *
 * Query:
 * - search
 * - type
 * - isActive
 */
router
  .get("/", async (req, res) => {
    try {
      const { search, type, isActive } = req.query;

      const query = db("companies as company")
        .leftJoin("sysLookups as companyType", function () {
          this.on("companyType.lookupId", "=", "company.type")
            .andOnVal("companyType.lookupGroup", "=", "company_type")
            .andOnVal("companyType.isActive", "=", 1);
        })
        .select([
          "company.id",
          "company.uuid",
          "company.code",
          "company.name",
          "company.type as typeId",
          "companyType.lookupCode as typeCode",
          "companyType.lookupValue as typeName",
          "company.isActive",
          "company.taxNumber",
          "company.email",
          "company.phone",
          "company.address",
          "company.city",
          "company.province",
          "company.postalCode",
          "company.createdAt",
          "company.updatedAt",
        ])
        .whereNull("company.deletedAt");

      if (search) {
        const normalizedSearch = `%${String(search).trim()}%`;

        query.andWhere((builder) => {
          builder
            .where("company.code", "like", normalizedSearch)
            .orWhere("company.name", "like", normalizedSearch)
            .orWhere("company.taxNumber", "like", normalizedSearch)
            .orWhere("company.email", "like", normalizedSearch)
            .orWhere("company.phone", "like", normalizedSearch)
            .orWhere("company.city", "like", normalizedSearch)
            .orWhere("company.province", "like", normalizedSearch);
        });
      }

      if (type) {
        query.andWhere(
          "companyType.lookupCode",
          String(type).trim().toUpperCase(),
        );
      }

      if (isActive !== undefined) {
        query.andWhere("company.isActive", parseBooleanQuery(isActive));
      }

      const companies = await query.orderBy("company.name", "asc");

      return res.success(companies);
    } catch (error) {
      console.error("GET /company error:", error);

      return res.fail(error.message || "Failed to load companies.");
    }
  })

  /**
   * GET /company/:uuid
   */
  .get("/:uuid", async (req, res) => {
    try {
      const company = await findCompanyByUuid(req.params.uuid);

      if (!company) {
        return res.incomplete("Company tidak ditemukan.");
      }

      return res.success(company);
    } catch (error) {
      console.error("GET /company/:uuid error:", error);

      return res.fail(error.message || "Failed to load company.");
    }
  })

  /**
   * POST /company
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

      const companyType = await trx("sysLookups")
        .where("lookupId", payload.typeId)
        .where("lookupGroup", "company_type")
        .where("isActive", 1)
        .whereNull("deletedAt")
        .first("lookupId");

      if (!companyType) {
        await trx.rollback();

        return res.incomplete("Company type tidak valid.");
      }

      const duplicateCode = await trx("companies")
        .whereRaw("UPPER(code) = ?", [payload.code])
        .whereNull("deletedAt")
        .first("id");

      if (duplicateCode) {
        await trx.rollback();

        return res.incomplete(
          `Company code "${payload.code}" sudah digunakan.`,
        );
      }

      const duplicateName = await trx("companies")
        .whereRaw("UPPER(name) = ?", [payload.name.toUpperCase()])
        .whereNull("deletedAt")
        .first("id");

      if (duplicateName) {
        await trx.rollback();

        return res.incomplete(
          `Company name "${payload.name}" sudah digunakan.`,
        );
      }

      const now = db.fn.now();
      const uuid = randomUUID();

      await trx("companies").insert({
        uuid,
        code: payload.code,
        name: payload.name,
        type: payload.typeId,
        isActive: payload.isActive,
        taxNumber: payload.taxNumber,
        email: payload.email,
        phone: payload.phone,
        address: payload.address,
        city: payload.city,
        province: payload.province,
        postalCode: payload.postalCode,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });

      await trx.commit();

      const company = await findCompanyByUuid(uuid);

      return res.success(company);
    } catch (error) {
      await trx.rollback();

      console.error("POST /company error:", error);

      return res.fail(error.message || "Failed to create company.");
    }
  })

  /**
   * PUT /company/:uuid
   */
  .put("/:uuid", async (req, res) => {
    const trx = await db.transaction();

    try {
      const existingCompany = await trx("companies")
        .where("uuid", req.params.uuid)
        .whereNull("deletedAt")
        .first();

      if (!existingCompany) {
        await trx.rollback();

        return res.incomplete("Company tidak ditemukan.");
      }

      const payload = normalizePayload(req.body);
      const validation = validatePayload(payload);

      if (!validation.valid) {
        await trx.rollback();

        return res.incomplete(validation.message);
      }

      const companyType = await trx("sysLookups")
        .where("lookupId", payload.typeId)
        .where("lookupGroup", "company_type")
        .where("isActive", 1)
        .whereNull("deletedAt")
        .first("lookupId");

      if (!companyType) {
        await trx.rollback();

        return res.incomplete("Company type tidak valid.");
      }

      const duplicateCode = await trx("companies")
        .whereRaw("UPPER(code) = ?", [payload.code])
        .whereNot("id", existingCompany.id)
        .whereNull("deletedAt")
        .first("id");

      if (duplicateCode) {
        await trx.rollback();

        return res.incomplete(
          `Company code "${payload.code}" sudah digunakan.`,
        );
      }

      const duplicateName = await trx("companies")
        .whereRaw("UPPER(name) = ?", [payload.name.toUpperCase()])
        .whereNot("id", existingCompany.id)
        .whereNull("deletedAt")
        .first("id");

      if (duplicateName) {
        await trx.rollback();

        return res.incomplete(
          `Company name "${payload.name}" sudah digunakan.`,
        );
      }

      if (existingCompany.isActive && !payload.isActive) {
        const activeDivision = await trx("divisions")
          .where("companyId", existingCompany.id)
          .where("isActive", true)
          .whereNull("deletedAt")
          .first("id");

        if (activeDivision) {
          await trx.rollback();

          return res.incomplete(
            "Company tidak dapat dinonaktifkan karena masih memiliki division aktif.",
          );
        }

        const activeUser = await trx("users")
          .where("companyId", existingCompany.id)
          .where("isActive", true)
          .whereNull("deletedAt")
          .first("id");

        if (activeUser) {
          await trx.rollback();

          return res.incomplete(
            "Company tidak dapat dinonaktifkan karena masih memiliki user aktif.",
          );
        }
      }

      await trx("companies").where("id", existingCompany.id).update({
        code: payload.code,
        name: payload.name,
        type: payload.typeId,
        isActive: payload.isActive,
        taxNumber: payload.taxNumber,
        email: payload.email,
        phone: payload.phone,
        address: payload.address,
        city: payload.city,
        province: payload.province,
        postalCode: payload.postalCode,
        updatedAt: db.fn.now(),
      });

      await trx.commit();

      const company = await findCompanyByUuid(req.params.uuid);

      return res.success(company);
    } catch (error) {
      await trx.rollback();

      console.error("PUT /company/:uuid error:", error);

      return res.fail(error.message || "Failed to update company.");
    }
  })

  /**
   * DELETE /company/:uuid
   *
   * Soft delete.
   */
  .delete("/:uuid", async (req, res) => {
    const trx = await db.transaction();

    try {
      const company = await trx("companies")
        .where("uuid", req.params.uuid)
        .whereNull("deletedAt")
        .first();

      if (!company) {
        await trx.rollback();

        return res.incomplete("Company tidak ditemukan.");
      }

      const division = await trx("divisions")
        .where("companyId", company.id)
        .whereNull("deletedAt")
        .first("id");

      if (division) {
        await trx.rollback();

        return res.incomplete(
          "Company tidak dapat dihapus karena masih digunakan oleh division.",
        );
      }

      const user = await trx("users")
        .where("companyId", company.id)
        .whereNull("deletedAt")
        .first("id");

      if (user) {
        await trx.rollback();

        return res.incomplete(
          "Company tidak dapat dihapus karena masih digunakan oleh user.",
        );
      }

      await trx("companies").where("id", company.id).update({
        isActive: false,
        deletedAt: db.fn.now(),
        updatedAt: db.fn.now(),
      });

      await trx.commit();

      return res.success({
        uuid: company.uuid,
      });
    } catch (error) {
      await trx.rollback();

      console.error("DELETE /company/:uuid error:", error);

      return res.fail(error.message || "Failed to delete company.");
    }
  });

async function findCompanyByUuid(uuid) {
  return db("companies as company")
    .leftJoin("sysLookups as companyType", function () {
      this.on("companyType.lookupId", "=", "company.type")
        .andOnVal("companyType.lookupGroup", "=", "company_type")
        .andOnVal("companyType.isActive", "=", 1);
    })
    .select([
      "company.id",
      "company.uuid",
      "company.code",
      "company.name",
      "company.type as typeId",
      "companyType.lookupCode as typeCode",
      "companyType.lookupValue as typeName",
      "company.isActive",
      "company.taxNumber",
      "company.email",
      "company.phone",
      "company.address",
      "company.city",
      "company.province",
      "company.postalCode",
      "company.createdAt",
      "company.updatedAt",
    ])
    .where("company.uuid", uuid)
    .whereNull("company.deletedAt")
    .first();
}

function normalizePayload(payload = {}) {
  return {
    code: normalizeRequiredString(payload.code).toUpperCase(),
    name: normalizeRequiredString(payload.name),
    typeId: normalizePositiveInteger(payload.typeId),
    isActive: normalizeBoolean(payload.isActive, true),
    taxNumber: normalizeNullableString(payload.taxNumber),
    email: normalizeNullableString(payload.email)?.toLowerCase() ?? null,
    phone: normalizeNullableString(payload.phone),
    address: normalizeNullableString(payload.address),
    city: normalizeNullableString(payload.city),
    province: normalizeNullableString(payload.province),
    postalCode: normalizeNullableString(payload.postalCode),
  };
}

function normalizePositiveInteger(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const normalizedValue = Number(value);

  if (!Number.isInteger(normalizedValue) || normalizedValue <= 0) {
    return null;
  }

  return normalizedValue;
}

function validatePayload(payload) {
  if (!payload.code) {
    return {
      valid: false,
      message: "Company code wajib diisi.",
    };
  }

  if (payload.code.length > 50) {
    return {
      valid: false,
      message: "Company code maksimal 50 karakter.",
    };
  }

  if (!payload.name) {
    return {
      valid: false,
      message: "Company name wajib diisi.",
    };
  }

  if (payload.name.length > 150) {
    return {
      valid: false,
      message: "Company name maksimal 150 karakter.",
    };
  }

  if (!payload.typeId) {
    return {
      valid: false,
      message: "Company type wajib diisi.",
    };
  }

  if (payload.taxNumber && payload.taxNumber.length > 100) {
    return {
      valid: false,
      message: "Tax number maksimal 100 karakter.",
    };
  }

  if (payload.email && !isValidEmail(payload.email)) {
    return {
      valid: false,
      message: "Format email tidak valid.",
    };
  }

  if (payload.email && payload.email.length > 150) {
    return {
      valid: false,
      message: "Email maksimal 150 karakter.",
    };
  }

  if (payload.phone && payload.phone.length > 50) {
    return {
      valid: false,
      message: "Phone maksimal 50 karakter.",
    };
  }

  if (payload.address && payload.address.length > 500) {
    return {
      valid: false,
      message: "Address maksimal 500 karakter.",
    };
  }

  if (payload.city && payload.city.length > 100) {
    return {
      valid: false,
      message: "City maksimal 100 karakter.",
    };
  }

  if (payload.province && payload.province.length > 100) {
    return {
      valid: false,
      message: "Province maksimal 100 karakter.",
    };
  }

  if (payload.postalCode && payload.postalCode.length > 20) {
    return {
      valid: false,
      message: "Postal code maksimal 20 karakter.",
    };
  }

  return {
    valid: true,
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

module.exports = router;
