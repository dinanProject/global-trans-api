"use strict";

const express = require("express");
const { randomUUID } = require("crypto");

const router = express.Router();

const authentication = require("../../lib/authentication");
const authorization = require("../../lib/authorization");
const db = require("../../lib/db")();

router.use(authentication);

router
  .get(
    "/",
    authorization(
      [
        "EQUIPMENT_UNIT.VIEW",
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
        const { search, categoryUuid, isActive } = req.query;

        const query = createEquipmentUnitQuery();

        if (search) {
          const normalizedSearch = `%${String(search).trim()}%`;

          query.andWhere((builder) => {
            builder
              .where("unit.unitCode", "like", normalizedSearch)
              .orWhere("unit.unitName", "like", normalizedSearch)
              .orWhere("unit.assetNumber", "like", normalizedSearch)
              .orWhere("unit.modelNumber", "like", normalizedSearch)
              .orWhere("unit.plateNumber", "like", normalizedSearch)
              .orWhere("unit.remarks", "like", normalizedSearch)
              .orWhere("category.code", "like", normalizedSearch)
              .orWhere("category.name", "like", normalizedSearch);
          });
        }

        if (categoryUuid) {
          query.andWhere("category.uuid", String(categoryUuid).trim());
        }

        if (isActive !== undefined) {
          query.andWhere("unit.isActive", parseBooleanQuery(isActive));
        }

        const units = await query.orderBy([
          {
            column: "unit.unitName",
            order: "asc",
          },
          {
            column: "unit.unitCode",
            order: "asc",
          },
        ]);

        return res.success(units);
      } catch (error) {
        console.error("GET /equipment-unit error:", error);

        return res.fail(error.message || "Failed to load equipment units.");
      }
    },
  )

  .get("/:uuid", authorization("EQUIPMENT_UNIT.VIEW"), async (req, res) => {
    try {
      const unit = await findEquipmentUnitByUuid(req.params.uuid);

      if (!unit) {
        return res.incomplete("Equipment unit tidak ditemukan.");
      }

      return res.success(unit);
    } catch (error) {
      console.error("GET /equipment-unit/:uuid error:", error);

      return res.fail(error.message || "Failed to load equipment unit.");
    }
  })

  .post("/", authorization("EQUIPMENT_UNIT.CREATE"), async (req, res) => {
    const trx = await db.transaction();

    try {
      const payload = normalizePayload(req.body);
      const validation = validatePayload(payload);

      if (!validation.valid) {
        await trx.rollback();

        return res.incomplete(validation.message);
      }

      const category = await trx("equipmentCategories")
        .where("uuid", payload.categoryUuid)
        .whereNull("deletedAt")
        .first();

      if (!category) {
        await trx.rollback();

        return res.incomplete("Equipment category tidak ditemukan.");
      }

      if (!normalizeBoolean(category.isActive)) {
        await trx.rollback();

        return res.incomplete(
          `Equipment category "${category.name}" sudah tidak aktif.`,
        );
      }

      const capacityUnitLookup = await findCapacityUnitLookup(
        trx,
        payload.capacityUnit,
      );

      if (!capacityUnitLookup) {
        await trx.rollback();

        return res.incomplete(
          `Equipment capacity unit "${payload.capacityUnit}" tidak valid atau tidak aktif.`,
        );
      }

      const duplicateUnitCode = await trx("equipmentUnits")
        .whereRaw("UPPER(unitCode) = ?", [payload.unitCode])
        .whereNull("deletedAt")
        .first("id");

      if (duplicateUnitCode) {
        await trx.rollback();

        return res.incomplete(
          `Equipment unit code "${payload.unitCode}" sudah digunakan.`,
        );
      }

      if (payload.assetNumber) {
        const duplicateAssetNumber = await trx("equipmentUnits")
          .whereRaw("UPPER(assetNumber) = ?", [
            payload.assetNumber.toUpperCase(),
          ])
          .whereNull("deletedAt")
          .first("id");

        if (duplicateAssetNumber) {
          await trx.rollback();

          return res.incomplete(
            `Asset number "${payload.assetNumber}" sudah digunakan.`,
          );
        }
      }

      if (payload.plateNumber) {
        const duplicatePlateNumber = await trx("equipmentUnits")
          .whereRaw("UPPER(plateNumber) = ?", [
            payload.plateNumber.toUpperCase(),
          ])
          .whereNull("deletedAt")
          .first("id");

        if (duplicatePlateNumber) {
          await trx.rollback();

          return res.incomplete(
            `Plate number "${payload.plateNumber}" sudah digunakan.`,
          );
        }
      }

      const now = db.fn.now();
      const uuid = randomUUID();

      await trx("equipmentUnits").insert({
        uuid,
        categoryId: category.id,
        unitCode: payload.unitCode,
        unitName: payload.unitName,
        assetNumber: payload.assetNumber,
        modelNumber: payload.modelNumber,
        plateNumber: payload.plateNumber,
        capacityValue: payload.capacityValue,
        capacityUnit: capacityUnitLookup.lookupCode,
        remarks: payload.remarks,
        isActive: payload.isActive,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });

      await trx.commit();

      const unit = await findEquipmentUnitByUuid(uuid);

      return res.success(unit);
    } catch (error) {
      await rollbackTransaction(trx);

      console.error("POST /equipment-unit error:", error);

      return res.fail(error.message || "Failed to create equipment unit.");
    }
  })

  /**
   * PUT /equipment-unit/:uuid
   */
  .put("/:uuid", authorization("EQUIPMENT_UNIT.UPDATE"), async (req, res) => {
    const trx = await db.transaction();

    try {
      const existingUnit = await trx("equipmentUnits")
        .where("uuid", req.params.uuid)
        .whereNull("deletedAt")
        .first();

      if (!existingUnit) {
        await trx.rollback();

        return res.incomplete("Equipment unit tidak ditemukan.");
      }

      const payload = normalizePayload(req.body);
      const validation = validatePayload(payload);

      if (!validation.valid) {
        await trx.rollback();

        return res.incomplete(validation.message);
      }

      const category = await trx("equipmentCategories")
        .where("uuid", payload.categoryUuid)
        .whereNull("deletedAt")
        .first();

      if (!category) {
        await trx.rollback();

        return res.incomplete("Equipment category tidak ditemukan.");
      }

      if (!normalizeBoolean(category.isActive)) {
        await trx.rollback();

        return res.incomplete(
          `Equipment category "${category.name}" sudah tidak aktif.`,
        );
      }

      const capacityUnitLookup = await findCapacityUnitLookup(
        trx,
        payload.capacityUnit,
      );

      if (!capacityUnitLookup) {
        await trx.rollback();

        return res.incomplete(
          `Equipment capacity unit "${payload.capacityUnit}" tidak valid atau tidak aktif.`,
        );
      }

      const duplicateUnitCode = await trx("equipmentUnits")
        .whereRaw("UPPER(unitCode) = ?", [payload.unitCode])
        .whereNot("id", existingUnit.id)
        .whereNull("deletedAt")
        .first("id");

      if (duplicateUnitCode) {
        await trx.rollback();

        return res.incomplete(
          `Equipment unit code "${payload.unitCode}" sudah digunakan.`,
        );
      }

      if (payload.assetNumber) {
        const duplicateAssetNumber = await trx("equipmentUnits")
          .whereRaw("UPPER(assetNumber) = ?", [
            payload.assetNumber.toUpperCase(),
          ])
          .whereNot("id", existingUnit.id)
          .whereNull("deletedAt")
          .first("id");

        if (duplicateAssetNumber) {
          await trx.rollback();

          return res.incomplete(
            `Asset number "${payload.assetNumber}" sudah digunakan.`,
          );
        }
      }

      if (payload.plateNumber) {
        const duplicatePlateNumber = await trx("equipmentUnits")
          .whereRaw("UPPER(plateNumber) = ?", [
            payload.plateNumber.toUpperCase(),
          ])
          .whereNot("id", existingUnit.id)
          .whereNull("deletedAt")
          .first("id");

        if (duplicatePlateNumber) {
          await trx.rollback();

          return res.incomplete(
            `Plate number "${payload.plateNumber}" sudah digunakan.`,
          );
        }
      }

      await trx("equipmentUnits").where("id", existingUnit.id).update({
        categoryId: category.id,
        unitCode: payload.unitCode,
        unitName: payload.unitName,
        assetNumber: payload.assetNumber,
        modelNumber: payload.modelNumber,
        plateNumber: payload.plateNumber,
        capacityValue: payload.capacityValue,
        capacityUnit: capacityUnitLookup.lookupCode,
        remarks: payload.remarks,
        isActive: payload.isActive,
        updatedAt: db.fn.now(),
      });

      await trx.commit();

      const unit = await findEquipmentUnitByUuid(req.params.uuid);

      return res.success(unit);
    } catch (error) {
      await rollbackTransaction(trx);

      console.error("PUT /equipment-unit/:uuid error:", error);

      return res.fail(error.message || "Failed to update equipment unit.");
    }
  })

  /**
   * DELETE /equipment-unit/:uuid
   *
   * Soft delete.
   */
  .delete(
    "/:uuid",
    authorization("EQUIPMENT_UNIT.DELETE"),
    async (req, res) => {
      const trx = await db.transaction();

      try {
        const unit = await trx("equipmentUnits")
          .where("uuid", req.params.uuid)
          .whereNull("deletedAt")
          .first();

        if (!unit) {
          await trx.rollback();

          return res.incomplete("Equipment unit tidak ditemukan.");
        }

        /*
         * Ketika transaksi rental sudah dibuat, validasi pemakaian unit
         * dapat ditambahkan di sini sebelum unit dihapus.
         */

        await trx("equipmentUnits").where("id", unit.id).update({
          isActive: false,
          deletedAt: db.fn.now(),
          updatedAt: db.fn.now(),
        });

        await trx.commit();

        return res.success({
          uuid: unit.uuid,
        });
      } catch (error) {
        await rollbackTransaction(trx);

        console.error("DELETE /equipment-unit/:uuid error:", error);

        return res.fail(error.message || "Failed to delete equipment unit.");
      }
    },
  );

function createEquipmentUnitQuery(database = db) {
  return database("equipmentUnits as unit")
    .leftJoin(
      "equipmentCategories as category",
      "category.id",
      "unit.categoryId",
    )
    .leftJoin("sysLookups as capacityLookup", function () {
      this.on("capacityLookup.lookupCode", "=", "unit.capacityUnit")
        .andOnVal("capacityLookup.lookupGroup", "=", "equipment_capacity_unit")
        .andOnVal("capacityLookup.isActive", "=", 1)
        .andOnNull("capacityLookup.deletedAt");
    })
    .select([
      "unit.id",
      "unit.uuid",
      "unit.categoryId",
      "category.uuid as categoryUuid",
      "category.code as categoryCode",
      "category.name as categoryName",
      "category.icon as categoryIcon",
      "unit.unitCode",
      "unit.unitName",
      "unit.assetNumber",
      "unit.modelNumber",
      "unit.plateNumber",
      "unit.capacityValue",
      "unit.capacityUnit",
      "capacityLookup.lookupValue as capacityUnitName",
      "capacityLookup.lookupAlias as capacityUnitAlias",
      "unit.remarks",
      "unit.isActive",
      "unit.createdAt",
      "unit.updatedAt",
    ])
    .whereNull("unit.deletedAt");
}

async function findEquipmentUnitByUuid(uuid) {
  return createEquipmentUnitQuery().where("unit.uuid", uuid).first();
}

async function findCapacityUnitLookup(database, capacityUnit) {
  return database("sysLookups")
    .where("lookupGroup", "equipment_capacity_unit")
    .whereRaw("UPPER(lookupCode) = ?", [capacityUnit])
    .where("isActive", 1)
    .whereNull("deletedAt")
    .first(["lookupId", "lookupCode", "lookupValue", "lookupAlias"]);
}

function normalizePayload(payload = {}) {
  return {
    categoryUuid: normalizeRequiredString(payload.categoryUuid),
    unitCode: normalizeRequiredString(payload.unitCode).toUpperCase(),
    unitName: normalizeRequiredString(payload.unitName),
    assetNumber: normalizeNullableString(payload.assetNumber),
    modelNumber: normalizeNullableString(payload.modelNumber),
    plateNumber: normalizeNullableString(payload.plateNumber),
    capacityValue: normalizePositiveDecimal(payload.capacityValue),
    capacityUnit: normalizeRequiredString(payload.capacityUnit).toUpperCase(),
    remarks: normalizeNullableString(payload.remarks),
    isActive: normalizeBoolean(payload.isActive, true),
  };
}

function validatePayload(payload) {
  if (!payload.categoryUuid) {
    return {
      valid: false,
      message: "Equipment category wajib dipilih.",
    };
  }

  if (!payload.unitCode) {
    return {
      valid: false,
      message: "Equipment unit code wajib diisi.",
    };
  }

  if (payload.unitCode.length > 50) {
    return {
      valid: false,
      message: "Equipment unit code maksimal 50 karakter.",
    };
  }

  if (!/^[A-Z0-9_-]+$/.test(payload.unitCode)) {
    return {
      valid: false,
      message:
        "Equipment unit code hanya boleh berisi huruf, angka, underscore, dan tanda minus.",
    };
  }

  if (!payload.unitName) {
    return {
      valid: false,
      message: "Equipment unit name wajib diisi.",
    };
  }

  if (payload.unitName.length > 150) {
    return {
      valid: false,
      message: "Equipment unit name maksimal 150 karakter.",
    };
  }

  if (payload.assetNumber && payload.assetNumber.length > 100) {
    return {
      valid: false,
      message: "Asset number maksimal 100 karakter.",
    };
  }

  if (payload.modelNumber && payload.modelNumber.length > 100) {
    return {
      valid: false,
      message: "Model number maksimal 100 karakter.",
    };
  }

  if (payload.plateNumber && payload.plateNumber.length > 50) {
    return {
      valid: false,
      message: "Plate number maksimal 50 karakter.",
    };
  }

  if (!payload.capacityValue) {
    return {
      valid: false,
      message: "Equipment capacity value wajib lebih dari 0.",
    };
  }

  if (!payload.capacityUnit) {
    return {
      valid: false,
      message: "Equipment capacity unit wajib dipilih.",
    };
  }

  if (payload.capacityUnit.length > 50) {
    return {
      valid: false,
      message: "Equipment capacity unit maksimal 50 karakter.",
    };
  }

  if (payload.remarks && payload.remarks.length > 500) {
    return {
      valid: false,
      message: "Remarks maksimal 500 karakter.",
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

function normalizePositiveDecimal(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const normalizedValue = Number(value);

  if (!Number.isFinite(normalizedValue) || normalizedValue <= 0) {
    return null;
  }

  return normalizedValue;
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

async function rollbackTransaction(trx) {
  if (!trx.isCompleted()) {
    await trx.rollback();
  }
}

module.exports = router;
