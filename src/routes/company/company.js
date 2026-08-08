"use strict";

const express = require("express");
const { randomUUID } = require("crypto");

const router = express.Router();

const {
  authenticate: authentication,
  authorize: authorization,
} = require("../../modules/access/access.middleware");
const db = require("../../lib/db")();

const HOLDER_COMPANY_TYPE = 1;
const GLOBAL_APPROVER_ROLE_CODE = "ADM_GLBL";

const REQUESTER_PERMISSION_CODES = [
  "AUTH.LOGIN",
  "AUTH.VIEW_PROFILE",
  "EQUIPMENT_REQUEST.VIEW",
  "EQUIPMENT_REQUEST.CREATE",
  "EQUIPMENT_REQUEST.UPDATE",
  "EQUIPMENT_REQUEST.DELETE",
  "EQUIPMENT_REQUEST.SUBMIT",
];

const CLIENT_APPROVER_PERMISSION_CODES = [
  "AUTH.LOGIN",
  "AUTH.VIEW_PROFILE",
  "EQUIPMENT_APPROVAL.VIEW",
  "EQUIPMENT_APPROVAL.CLIENT_APPROVE",
  "EQUIPMENT_APPROVAL.CLIENT_REJECT",
];

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
  .get(
    "/",
    authorization(
      [
        "COMPANY.VIEW",
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
    },
  )

  /**
   * GET /company/:uuid
   */
  .get("/:uuid", authorization("COMPANY.VIEW"), async (req, res) => {
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
  .post("/", authorization("COMPANY.CREATE"), async (req, res) => {
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

      const insertResult = await trx("companies").insert({
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

      const companyId = getInsertedId(insertResult);

      /*
       * Company holder Global Trans tidak dibuatkan role client
       * dan approval flow client.
       *
       * Company selain holder otomatis dibuatkan:
       * - role requester
       * - role approver
       * - permission default role
       * - approval flow CLIENT level 1
       * - approval flow GTSI level 2
       */
      if (payload.typeId !== HOLDER_COMPANY_TYPE) {
        await provisionCompanyEquipmentAccess(trx, {
          companyId,
          companyCode: payload.code,
          companyName: payload.name,
          now,
        });
      }

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
  .put("/:uuid", authorization("COMPANY.UPDATE"), async (req, res) => {
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

      if (
        payload.code !==
        normalizeRequiredString(existingCompany.code).toUpperCase()
      ) {
        await trx.rollback();

        return res.incomplete("Company code cannot be changed after creation.");
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
  .delete("/:uuid", authorization("COMPANY.DELETE"), async (req, res) => {
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

/**
 * Provision default equipment-request access for a new client company.
 *
 * Function ini hanya dipanggil pada POST /company.
 * Tidak dipanggil pada PUT /company.
 */
async function provisionCompanyEquipmentAccess(
  trx,
  { companyId, companyCode, companyName, now },
) {
  const requesterRoleCode = `${companyCode}_REQ`;
  const approverRoleCode = `${companyCode}_APPR`;

  const requesterRoleId = await ensureRole(trx, {
    code: requesterRoleCode,
    name: `${companyName} Requester`,
    description: `Requester equipment untuk ${companyName}.`,
    companyId,
    now,
  });

  const approverRoleId = await ensureRole(trx, {
    code: approverRoleCode,
    name: `${companyName} Approver`,
    description: `Approver equipment untuk ${companyName}.`,
    companyId,
    now,
  });

  await ensureRolePermissions(
    trx,
    requesterRoleId,
    REQUESTER_PERMISSION_CODES,
    "COMPANY",
  );

  await ensureRolePermissions(
    trx,
    approverRoleId,
    CLIENT_APPROVER_PERMISSION_CODES,
    "COMPANY",
  );

  const holderCompany = await trx("companies")
    .where("type", HOLDER_COMPANY_TYPE)
    .where("isActive", true)
    .whereNull("deletedAt")
    .orderBy("id", "asc")
    .first("id");

  if (!holderCompany) {
    throw new Error("Company holder Global Trans aktif tidak ditemukan.");
  }

  const globalApproverRole = await trx("roles")
    .whereRaw("UPPER(code) = ?", [GLOBAL_APPROVER_ROLE_CODE])
    .first("id");

  if (!globalApproverRole) {
    throw new Error(`Role ${GLOBAL_APPROVER_ROLE_CODE} tidak ditemukan.`);
  }

  await ensureEquipmentApprovalFlow(trx, {
    requestCompanyId: companyId,
    approvalLevel: 1,
    companyId,
    roleId: approverRoleId,
    actorStage: "CLIENT",
    now,
  });

  await ensureEquipmentApprovalFlow(trx, {
    requestCompanyId: companyId,
    approvalLevel: 2,
    companyId: holderCompany.id,
    roleId: globalApproverRole.id,
    actorStage: "GTSI",
    now,
  });
}

/**
 * Mencari role berdasarkan code.
 * Jika belum ada, role dibuat.
 */
async function ensureRole(trx, { code, name, description, companyId, now }) {
  const normalizedCode = normalizeRequiredString(code).toUpperCase();

  const existingRole = await trx("roles")
    .whereRaw("UPPER(code) = ?", [normalizedCode])
    .first(["id", "companyId"]);

  if (existingRole) {
    if (Number(existingRole.companyId) !== Number(companyId)) {
      throw new Error(
        `Role code "${normalizedCode}" sudah digunakan oleh company lain.`,
      );
    }

    return Number(existingRole.id);
  }

  const insertResult = await trx("roles").insert({
    uuid: randomUUID(),
    code: normalizedCode,
    name,
    description,
    companyId,
    isSystem: false,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });

  return getInsertedId(insertResult);
}

/**
 * Permission master tidak dibuat di sini.
 *
 * Function ini hanya mengambil permission yang sudah dibuat
 * oleh System Developer, kemudian memasangnya ke role.
 */
async function ensureRolePermissions(trx, roleId, permissionCodes, dataScope) {
  const permissions = await trx("permissions")
    .whereIn("code", permissionCodes)
    .select(["permissionId", "code"]);

  const foundCodes = new Set(permissions.map((permission) => permission.code));

  const missingCodes = permissionCodes.filter(
    (permissionCode) => !foundCodes.has(permissionCode),
  );

  if (missingCodes.length > 0) {
    throw new Error(
      `Permission default belum tersedia: ${missingCodes.join(
        ", ",
      )}. Hubungi System Developer.`,
    );
  }

  const permissionIds = permissions.map(
    (permission) => permission.permissionId,
  );

  const existingPermissionIds = await trx("rolePermissions")
    .where("roleId", roleId)
    .whereIn("permissionId", permissionIds)
    .pluck("permissionId");

  const existingPermissionSet = new Set(existingPermissionIds.map(Number));

  const rows = permissions

    .filter(
      (permission) =>
        !existingPermissionSet.has(Number(permission.permissionId)),
    )

    .map((permission) => ({
      roleId,
      permissionId: permission.permissionId,
      dataScopeId: null,
      dataScope,
      createdAt: db.fn.now(),
    }));

  if (rows.length > 0) {
    await trx("rolePermissions").insert(rows);
  }
}

/**
 * Membuat flow jika belum ada.
 *
 * Jika flow pada level yang sama sudah ada, konfigurasi flow
 * tersebut disinkronkan, bukan membuat duplikat.
 */
async function ensureEquipmentApprovalFlow(
  trx,
  { requestCompanyId, approvalLevel, companyId, roleId, actorStage, now },
) {
  const existingFlow = await trx("equipmentApprovalFlows")
    .where("requestCompanyId", requestCompanyId)
    .where("approvalLevel", approvalLevel)
    .whereNull("deletedAt")
    .first("id");

  if (existingFlow) {
    await trx("equipmentApprovalFlows").where("id", existingFlow.id).update({
      companyId,
      roleId,
      actorStage,
      isActive: true,
      updatedAt: now,
      deletedAt: null,
    });

    return;
  }

  await trx("equipmentApprovalFlows").insert({
    uuid: randomUUID(),
    requestCompanyId,
    approvalLevel,
    companyId,
    roleId,
    actorStage,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
}

function getInsertedId(insertResult) {
  const firstResult = Array.isArray(insertResult)
    ? insertResult[0]
    : insertResult;

  if (firstResult && typeof firstResult === "object") {
    const id =
      firstResult.id ?? firstResult.insertId ?? firstResult.permissionId;

    if (id !== undefined && id !== null) {
      return Number(id);
    }
  }

  const insertedId = Number(firstResult);

  if (!Number.isInteger(insertedId) || insertedId <= 0) {
    throw new Error("Gagal mendapatkan ID data yang baru dibuat.");
  }

  return insertedId;
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
