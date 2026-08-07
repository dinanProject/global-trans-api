"use strict";

const express = require("express");
const { randomUUID } = require("crypto");

const router = express.Router();

const authentication = require("../../lib/authentication");
const authorization = require("../../lib/authorization");
const db = require("../../lib/db")();

router.use(authentication);

/**
 * GET /equipment-category
 *
 * Query:
 * - search
 * - isActive
 */
router
  .get(
    "/",
    authorization(
      [
        "EQUIPMENT_CATEGORY.VIEW",
        "EQUIPMENT_REQUEST.VIEW",
        "EQUIPMENT_REQUEST.CREATE",
        "EQUIPMENT_REQUEST.UPDATE",
      ],
      {
        requireAll: false,
      },
    ),
    async (req, res) => {
      try {
        const { search, isActive } = req.query;

        const query = db("equipmentCategories as category")
          .select([
            "category.id",
            "category.uuid",
            "category.code",
            "category.name",
            "category.description",
            "category.icon",
            "category.isActive",
            "category.createdAt",
            "category.updatedAt",
          ])
          .whereNull("category.deletedAt");

        if (search) {
          const normalizedSearch = `%${String(search).trim()}%`;

          query.andWhere((builder) => {
            builder
              .where("category.code", "like", normalizedSearch)
              .orWhere("category.name", "like", normalizedSearch)
              .orWhere("category.description", "like", normalizedSearch);
          });
        }

        if (isActive !== undefined) {
          query.andWhere("category.isActive", parseBooleanQuery(isActive));
        }

        const categories = await query.orderBy([
          {
            column: "category.name",
            order: "asc",
          },
          {
            column: "category.code",
            order: "asc",
          },
        ]);

        return res.success(categories);
      } catch (error) {
        console.error("GET /equipment-category error:", error);

        return res.fail(
          error.message || "Failed to load equipment categories.",
        );
      }
    },
  )

  /**
   * GET /equipment-category/:uuid
   */
  .get("/:uuid", authorization("EQUIPMENT_CATEGORY.VIEW"), async (req, res) => {
    try {
      const category = await findEquipmentCategoryByUuid(req.params.uuid);

      if (!category) {
        return res.incomplete("Equipment category tidak ditemukan.");
      }

      return res.success(category);
    } catch (error) {
      console.error("GET /equipment-category/:uuid error:", error);

      return res.fail(error.message || "Failed to load equipment category.");
    }
  })

  /**
   * POST /equipment-category
   */
  .post("/", authorization("EQUIPMENT_CATEGORY.CREATE"), async (req, res) => {
    const trx = await db.transaction();

    try {
      const payload = normalizePayload(req.body);
      const validation = validatePayload(payload);

      if (!validation.valid) {
        await trx.rollback();

        return res.incomplete(validation.message);
      }

      const duplicateCode = await trx("equipmentCategories")
        .whereRaw("UPPER(code) = ?", [payload.code])
        .whereNull("deletedAt")
        .first("id");

      if (duplicateCode) {
        await trx.rollback();

        return res.incomplete(
          `Equipment category code "${payload.code}" sudah digunakan.`,
        );
      }

      const duplicateName = await trx("equipmentCategories")
        .whereRaw("UPPER(name) = ?", [payload.name.toUpperCase()])
        .whereNull("deletedAt")
        .first("id");

      if (duplicateName) {
        await trx.rollback();

        return res.incomplete(
          `Equipment category name "${payload.name}" sudah digunakan.`,
        );
      }

      const now = db.fn.now();
      const uuid = randomUUID();

      await trx("equipmentCategories").insert({
        uuid,
        code: payload.code,
        name: payload.name,
        description: payload.description,
        icon: payload.icon,
        isActive: payload.isActive,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });

      await trx.commit();

      const category = await findEquipmentCategoryByUuid(uuid);

      return res.success(category);
    } catch (error) {
      await trx.rollback();

      console.error("POST /equipment-category error:", error);

      return res.fail(error.message || "Failed to create equipment category.");
    }
  })

  /**
   * PUT /equipment-category/:uuid
   */
  .put(
    "/:uuid",
    authorization("EQUIPMENT_CATEGORY.UPDATE"),
    async (req, res) => {
      const trx = await db.transaction();

      try {
        const existingCategory = await trx("equipmentCategories")
          .where("uuid", req.params.uuid)
          .whereNull("deletedAt")
          .first();

        if (!existingCategory) {
          await trx.rollback();

          return res.incomplete("Equipment category tidak ditemukan.");
        }

        const payload = normalizePayload(req.body);
        const validation = validatePayload(payload);

        if (!validation.valid) {
          await trx.rollback();

          return res.incomplete(validation.message);
        }

        const duplicateCode = await trx("equipmentCategories")
          .whereRaw("UPPER(code) = ?", [payload.code])
          .whereNot("id", existingCategory.id)
          .whereNull("deletedAt")
          .first("id");

        if (duplicateCode) {
          await trx.rollback();

          return res.incomplete(
            `Equipment category code "${payload.code}" sudah digunakan.`,
          );
        }

        const duplicateName = await trx("equipmentCategories")
          .whereRaw("UPPER(name) = ?", [payload.name.toUpperCase()])
          .whereNot("id", existingCategory.id)
          .whereNull("deletedAt")
          .first("id");

        if (duplicateName) {
          await trx.rollback();

          return res.incomplete(
            `Equipment category name "${payload.name}" sudah digunakan.`,
          );
        }

        /*
         * Nanti ketika equipmentTypes sudah dibuat, validasi saat
         * category dinonaktifkan ditambahkan di sini:
         *
         * if (existingCategory.isActive && !payload.isActive) {
         *   cek equipment type aktif yang memakai category ini.
         * }
         */

        await trx("equipmentCategories")
          .where("id", existingCategory.id)
          .update({
            code: payload.code,
            name: payload.name,
            description: payload.description,
            icon: payload.icon,
            isActive: payload.isActive,
            updatedAt: db.fn.now(),
          });

        await trx.commit();

        const category = await findEquipmentCategoryByUuid(req.params.uuid);

        return res.success(category);
      } catch (error) {
        await trx.rollback();

        console.error("PUT /equipment-category/:uuid error:", error);

        return res.fail(
          error.message || "Failed to update equipment category.",
        );
      }
    },
  )

  /**
   * DELETE /equipment-category/:uuid
   *
   * Soft delete.
   */
  .delete(
    "/:uuid",
    authorization("EQUIPMENT_CATEGORY.DELETE"),
    async (req, res) => {
      const trx = await db.transaction();

      try {
        const category = await trx("equipmentCategories")
          .where("uuid", req.params.uuid)
          .whereNull("deletedAt")
          .first();

        if (!category) {
          await trx.rollback();

          return res.incomplete("Equipment category tidak ditemukan.");
        }

        /*
         * Setelah equipmentTypes dibuat, tambahkan:
         *
         * const equipmentType = await trx("equipmentTypes")
         *   .where("categoryId", category.id)
         *   .whereNull("deletedAt")
         *   .first("id");
         *
         * if (equipmentType) {
         *   await trx.rollback();
         *
         *   return res.incomplete(
         *     "Equipment category tidak dapat dihapus karena masih digunakan oleh equipment type.",
         *   );
         * }
         */

        await trx("equipmentCategories").where("id", category.id).update({
          isActive: false,
          deletedAt: db.fn.now(),
          updatedAt: db.fn.now(),
        });

        await trx.commit();

        return res.success({
          uuid: category.uuid,
        });
      } catch (error) {
        await trx.rollback();

        console.error("DELETE /equipment-category/:uuid error:", error);

        return res.fail(
          error.message || "Failed to delete equipment category.",
        );
      }
    },
  );

async function findEquipmentCategoryByUuid(uuid) {
  return db("equipmentCategories as category")
    .select([
      "category.id",
      "category.uuid",
      "category.code",
      "category.name",
      "category.description",
      "category.icon",
      "category.isActive",
      "category.createdAt",
      "category.updatedAt",
    ])
    .where("category.uuid", uuid)
    .whereNull("category.deletedAt")
    .first();
}

function normalizePayload(payload = {}) {
  return {
    code: normalizeRequiredString(payload.code).toUpperCase(),
    name: normalizeRequiredString(payload.name),
    description: normalizeNullableString(payload.description),
    icon: normalizeNullableString(payload.icon),
    isActive: normalizeBoolean(payload.isActive, true),
  };
}

function validatePayload(payload) {
  if (!payload.code) {
    return {
      valid: false,
      message: "Equipment category code wajib diisi.",
    };
  }

  if (payload.code.length > 50) {
    return {
      valid: false,
      message: "Equipment category code maksimal 50 karakter.",
    };
  }

  if (!/^[A-Z0-9_-]+$/.test(payload.code)) {
    return {
      valid: false,
      message:
        "Equipment category code hanya boleh berisi huruf, angka, underscore, dan tanda minus.",
    };
  }

  if (!payload.name) {
    return {
      valid: false,
      message: "Equipment category name wajib diisi.",
    };
  }

  if (payload.name.length > 150) {
    return {
      valid: false,
      message: "Equipment category name maksimal 150 karakter.",
    };
  }

  if (payload.description && payload.description.length > 500) {
    return {
      valid: false,
      message: "Equipment category description maksimal 500 karakter.",
    };
  }

  if (payload.icon && payload.icon.length > 100) {
    return {
      valid: false,
      message: "Equipment category icon maksimal 100 karakter.",
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

module.exports = router;
