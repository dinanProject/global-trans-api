'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

let multer;
try {
  multer = require('multer');
} catch (_) {
  multer = null;
}

const router = express.Router();

const { authenticate: authentication, authorize: authorization } = require('../../modules/access/access.middleware');
const db = require('../../lib/db')();

const EQUIPMENT_UNIT_IMAGE_MODULE = 'EQUIPMENT_UNIT';
const EQUIPMENT_UNIT_IMAGE_DOCUMENT_TYPE = 'UNIT_IMAGE';
const EQUIPMENT_UNIT_CONSUMER_PERMISSIONS = [
  'EQUIPMENT_UNIT.VIEW',
  'EQUIPMENT_REQUEST.VIEW',
  'EQUIPMENT_REQUEST.CREATE',
  'EQUIPMENT_REQUEST.UPDATE',
  'EQUIPMENT_APPROVAL.VIEW',
  'EQUIPMENT_OPERATION.VIEW',
  'EQUIPMENT_MONITORING.VIEW',
];
const EQUIPMENT_UNIT_IMAGE_MAX_BYTES = Number(process.env.EQUIPMENT_UNIT_IMAGE_MAX_BYTES || 5 * 1024 * 1024);
const uploadRoot = path.resolve(process.env.FILE_UPLOAD_ROOT || path.join(process.cwd(), 'uploads'));
const equipmentUnitImageRoot = path.join(uploadRoot, 'equipment-units');

fs.mkdirSync(equipmentUnitImageRoot, { recursive: true });

const equipmentUnitImageUpload = multer
  ? multer({
      dest: equipmentUnitImageRoot,
      limits: {
        fileSize: EQUIPMENT_UNIT_IMAGE_MAX_BYTES,
        files: 1,
      },
    })
  : null;

router.use(authentication);

router
  .get(
    '/',
    authorization(EQUIPMENT_UNIT_CONSUMER_PERMISSIONS, {
      requireAll: false,
    }),
    async (req, res) => {
      try {
        const { search, categoryUuid, isActive, operationalStatusCode } = req.query;

        const query = createEquipmentUnitQuery();

        if (search) {
          const normalizedSearch = `%${String(search).trim()}%`;

          query.andWhere((builder) => {
            builder
              .where('unit.unitCode', 'like', normalizedSearch)
              .orWhere('unit.unitName', 'like', normalizedSearch)
              .orWhere('unit.assetNumber', 'like', normalizedSearch)
              .orWhere('unit.modelNumber', 'like', normalizedSearch)
              .orWhere('unit.plateNumber', 'like', normalizedSearch)
              .orWhere('unit.remarks', 'like', normalizedSearch)
              .orWhere('category.code', 'like', normalizedSearch)
              .orWhere('category.name', 'like', normalizedSearch);
          });
        }

        if (categoryUuid) {
          query.andWhere('category.uuid', String(categoryUuid).trim());
        }

        if (isActive !== undefined) {
          query.andWhere('unit.isActive', parseBooleanQuery(isActive));
        }

        if (operationalStatusCode) {
          query.andWhere('unit.operationalStatusCode', String(operationalStatusCode).trim().toUpperCase());
        }

        const units = await query.orderBy([
          {
            column: 'unit.unitName',
            order: 'asc',
          },
          {
            column: 'unit.unitCode',
            order: 'asc',
          },
        ]);

        return res.success(units);
      } catch (error) {
        console.error('GET /equipment-unit error:', error);

        return res.fail(error.message || 'Failed to load equipment units.');
      }
    }
  )

  .get('/:uuid', authorization('EQUIPMENT_UNIT.VIEW'), async (req, res) => {
    try {
      const unit = await findEquipmentUnitByUuid(req.params.uuid);

      if (!unit) {
        return res.incomplete('Equipment unit tidak ditemukan.');
      }

      return res.success(unit);
    } catch (error) {
      console.error('GET /equipment-unit/:uuid error:', error);

      return res.fail(error.message || 'Failed to load equipment unit.');
    }
  })

  .post('/', authorization('EQUIPMENT_UNIT.CREATE'), async (req, res) => {
    const trx = await db.transaction();

    try {
      const payload = normalizePayload(req.body);
      const validation = validatePayload(payload);

      if (!validation.valid) {
        await trx.rollback();

        return res.incomplete(validation.message);
      }

      const category = await trx('equipmentCategories').where('uuid', payload.categoryUuid).whereNull('deletedAt').first();

      if (!category) {
        await trx.rollback();

        return res.incomplete('Equipment category tidak ditemukan.');
      }

      if (!normalizeBoolean(category.isActive)) {
        await trx.rollback();

        return res.incomplete(`Equipment category "${category.name}" sudah tidak aktif.`);
      }

      const capacityUnitLookup = await findCapacityUnitLookup(trx, payload.capacityUnit);

      if (!capacityUnitLookup) {
        await trx.rollback();

        return res.incomplete(`Equipment capacity unit "${payload.capacityUnit}" tidak valid atau tidak aktif.`);
      }

      const operationalStatusLookup = await findOperationalStatusLookup(trx, payload.operationalStatusCode);

      if (!operationalStatusLookup) {
        await trx.rollback();

        return res.incomplete(`Equipment operational status "${payload.operationalStatusCode}" tidak valid atau tidak aktif.`);
      }

      const duplicateUnitCode = await trx('equipmentUnits').whereRaw('UPPER(unitCode) = ?', [payload.unitCode]).whereNull('deletedAt').first('id');

      if (duplicateUnitCode) {
        await trx.rollback();

        return res.incomplete(`Equipment unit code "${payload.unitCode}" sudah digunakan.`);
      }

      if (payload.assetNumber) {
        const duplicateAssetNumber = await trx('equipmentUnits')
          .whereRaw('UPPER(assetNumber) = ?', [payload.assetNumber.toUpperCase()])
          .whereNull('deletedAt')
          .first('id');

        if (duplicateAssetNumber) {
          await trx.rollback();

          return res.incomplete(`Asset number "${payload.assetNumber}" sudah digunakan.`);
        }
      }

      if (payload.plateNumber) {
        const duplicatePlateNumber = await trx('equipmentUnits')
          .whereRaw('UPPER(plateNumber) = ?', [payload.plateNumber.toUpperCase()])
          .whereNull('deletedAt')
          .first('id');

        if (duplicatePlateNumber) {
          await trx.rollback();

          return res.incomplete(`Plate number "${payload.plateNumber}" sudah digunakan.`);
        }
      }

      const now = db.fn.now();
      const uuid = randomUUID();

      await trx('equipmentUnits').insert({
        uuid,
        categoryId: category.id,
        unitCode: payload.unitCode,
        unitName: payload.unitName,
        assetNumber: payload.assetNumber,
        modelNumber: payload.modelNumber,
        plateNumber: payload.plateNumber,
        capacityValue: payload.capacityValue,
        capacityUnit: capacityUnitLookup.lookupCode,
        operationalStatusCode: operationalStatusLookup.lookupCode,
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

      console.error('POST /equipment-unit error:', error);

      return res.fail(error.message || 'Failed to create equipment unit.');
    }
  })

  /**
   * PUT /equipment-unit/:uuid
   */
  .put('/:uuid', authorization('EQUIPMENT_UNIT.UPDATE'), async (req, res) => {
    const trx = await db.transaction();

    try {
      const existingUnit = await trx('equipmentUnits').where('uuid', req.params.uuid).whereNull('deletedAt').first();

      if (!existingUnit) {
        await trx.rollback();

        return res.incomplete('Equipment unit tidak ditemukan.');
      }

      const payload = normalizePayload(req.body);
      const validation = validatePayload(payload);

      if (!validation.valid) {
        await trx.rollback();

        return res.incomplete(validation.message);
      }

      const category = await trx('equipmentCategories').where('uuid', payload.categoryUuid).whereNull('deletedAt').first();

      if (!category) {
        await trx.rollback();

        return res.incomplete('Equipment category tidak ditemukan.');
      }

      if (!normalizeBoolean(category.isActive)) {
        await trx.rollback();

        return res.incomplete(`Equipment category "${category.name}" sudah tidak aktif.`);
      }

      const capacityUnitLookup = await findCapacityUnitLookup(trx, payload.capacityUnit);

      if (!capacityUnitLookup) {
        await trx.rollback();

        return res.incomplete(`Equipment capacity unit "${payload.capacityUnit}" tidak valid atau tidak aktif.`);
      }

      const operationalStatusLookup = await findOperationalStatusLookup(trx, payload.operationalStatusCode);

      if (!operationalStatusLookup) {
        await trx.rollback();

        return res.incomplete(`Equipment operational status "${payload.operationalStatusCode}" tidak valid atau tidak aktif.`);
      }

      const duplicateUnitCode = await trx('equipmentUnits')
        .whereRaw('UPPER(unitCode) = ?', [payload.unitCode])
        .whereNot('id', existingUnit.id)
        .whereNull('deletedAt')
        .first('id');

      if (duplicateUnitCode) {
        await trx.rollback();

        return res.incomplete(`Equipment unit code "${payload.unitCode}" sudah digunakan.`);
      }

      if (payload.assetNumber) {
        const duplicateAssetNumber = await trx('equipmentUnits')
          .whereRaw('UPPER(assetNumber) = ?', [payload.assetNumber.toUpperCase()])
          .whereNot('id', existingUnit.id)
          .whereNull('deletedAt')
          .first('id');

        if (duplicateAssetNumber) {
          await trx.rollback();

          return res.incomplete(`Asset number "${payload.assetNumber}" sudah digunakan.`);
        }
      }

      if (payload.plateNumber) {
        const duplicatePlateNumber = await trx('equipmentUnits')
          .whereRaw('UPPER(plateNumber) = ?', [payload.plateNumber.toUpperCase()])
          .whereNot('id', existingUnit.id)
          .whereNull('deletedAt')
          .first('id');

        if (duplicatePlateNumber) {
          await trx.rollback();

          return res.incomplete(`Plate number "${payload.plateNumber}" sudah digunakan.`);
        }
      }

      await trx('equipmentUnits').where('id', existingUnit.id).update({
        categoryId: category.id,
        unitCode: payload.unitCode,
        unitName: payload.unitName,
        assetNumber: payload.assetNumber,
        modelNumber: payload.modelNumber,
        plateNumber: payload.plateNumber,
        capacityValue: payload.capacityValue,
        capacityUnit: capacityUnitLookup.lookupCode,
        operationalStatusCode: operationalStatusLookup.lookupCode,
        remarks: payload.remarks,
        isActive: payload.isActive,
        updatedAt: db.fn.now(),
      });

      await trx.commit();

      const unit = await findEquipmentUnitByUuid(req.params.uuid);

      return res.success(unit);
    } catch (error) {
      await rollbackTransaction(trx);

      console.error('PUT /equipment-unit/:uuid error:', error);

      return res.fail(error.message || 'Failed to update equipment unit.');
    }
  })

  .get(
    '/:uuid/image',
    authorization(EQUIPMENT_UNIT_CONSUMER_PERMISSIONS, {
      requireAll: false,
    }),
    async (req, res) => {
      try {
        const unit = await db('equipmentUnits').where('uuid', req.params.uuid).whereNull('deletedAt').first(['id', 'uuid']);

        if (!unit) {
          return res.incomplete('Equipment unit tidak ditemukan.');
        }

        const image = await findActiveEquipmentUnitImage(db, unit.uuid);

        if (!image || !image.filePath || !fs.existsSync(image.filePath)) {
          return res.status(404).end();
        }

        res.set('Content-Type', image.mimeType || 'application/octet-stream');
        res.set('Content-Disposition', `inline; filename="${sanitizeDownloadName(image.originalName)}"`);
        res.set('Cache-Control', 'private, max-age=300');

        return res.sendFile(path.resolve(image.filePath));
      } catch (error) {
        console.error('GET /equipment-unit/:uuid/image error:', error);

        return res.fail(error.message || 'Failed to load equipment unit image.');
      }
    }
  )

  .post('/:uuid/image', authorization('EQUIPMENT_UNIT.UPDATE'), handleEquipmentUnitImageUpload, async (req, res) => {
    const trx = await db.transaction();
    let previousImages = [];

    try {
      const unit = await trx('equipmentUnits').where('uuid', req.params.uuid).whereNull('deletedAt').first(['id', 'uuid']);

      if (!unit) {
        await trx.rollback();
        removeFileIfExists(req.file?.path);

        return res.incomplete('Equipment unit tidak ditemukan.');
      }

      if (!req.file) {
        await trx.rollback();

        return res.incomplete('Gambar equipment unit wajib dipilih.');
      }

      const detectedImage = detectImageType(req.file.path);
      const validationMessage = validateEquipmentUnitImage(req.file, detectedImage);

      if (validationMessage) {
        await trx.rollback();
        removeFileIfExists(req.file.path);

        return res.incomplete(validationMessage);
      }

      previousImages = await trx('fileAttachments')
        .where({
          moduleCode: EQUIPMENT_UNIT_IMAGE_MODULE,
          referenceUuid: unit.uuid,
          documentType: EQUIPMENT_UNIT_IMAGE_DOCUMENT_TYPE,
          isActive: true,
        })
        .whereNull('deletedAt')
        .select(['uuid', 'filePath']);

      const now = db.fn.now();
      const imageUuid = randomUUID();
      const access = req.getData().access;

      if (previousImages.length > 0) {
        await trx('fileAttachments')
          .whereIn(
            'uuid',
            previousImages.map((image) => image.uuid)
          )
          .update({
            isActive: false,
            deletedAt: now,
            updatedAt: now,
          });
      }

      await trx('fileAttachments').insert({
        uuid: imageUuid,
        moduleCode: EQUIPMENT_UNIT_IMAGE_MODULE,
        referenceId: unit.id,
        referenceUuid: unit.uuid,
        documentType: EQUIPMENT_UNIT_IMAGE_DOCUMENT_TYPE,
        originalName: req.file.originalname,
        storedName: req.file.filename,
        filePath: req.file.path,
        mimeType: detectedImage.mimeType,
        fileSize: req.file.size,
        description: null,
        uploadedBy: access.user.id,
        uploadedAt: now,
        isActive: true,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });

      await trx.commit();

      previousImages.forEach((image) => removeFileIfExists(image.filePath));

      return res.success({
        uuid: imageUuid,
        referenceUuid: unit.uuid,
        originalName: req.file.originalname,
        mimeType: detectedImage.mimeType,
        fileSize: req.file.size,
      });
    } catch (error) {
      await rollbackTransaction(trx);
      removeFileIfExists(req.file?.path);

      console.error('POST /equipment-unit/:uuid/image error:', error);

      return res.fail(error.message || 'Failed to upload equipment unit image.');
    }
  })

  .delete('/:uuid/image', authorization('EQUIPMENT_UNIT.UPDATE'), async (req, res) => {
    const trx = await db.transaction();

    try {
      const unit = await trx('equipmentUnits').where('uuid', req.params.uuid).whereNull('deletedAt').first(['id', 'uuid']);

      if (!unit) {
        await trx.rollback();

        return res.incomplete('Equipment unit tidak ditemukan.');
      }

      const images = await trx('fileAttachments')
        .where({
          moduleCode: EQUIPMENT_UNIT_IMAGE_MODULE,
          referenceUuid: unit.uuid,
          documentType: EQUIPMENT_UNIT_IMAGE_DOCUMENT_TYPE,
          isActive: true,
        })
        .whereNull('deletedAt')
        .select(['uuid', 'filePath']);

      if (images.length === 0) {
        await trx.rollback();

        return res.success({ uuid: unit.uuid });
      }

      const now = db.fn.now();

      await trx('fileAttachments')
        .whereIn(
          'uuid',
          images.map((image) => image.uuid)
        )
        .update({
          isActive: false,
          deletedAt: now,
          updatedAt: now,
        });

      await trx.commit();

      images.forEach((image) => removeFileIfExists(image.filePath));

      return res.success({ uuid: unit.uuid });
    } catch (error) {
      await rollbackTransaction(trx);

      console.error('DELETE /equipment-unit/:uuid/image error:', error);

      return res.fail(error.message || 'Failed to delete equipment unit image.');
    }
  })

  /**
   * DELETE /equipment-unit/:uuid
   *
   * Soft delete.
   */
  .delete('/:uuid', authorization('EQUIPMENT_UNIT.DELETE'), async (req, res) => {
    const trx = await db.transaction();

    try {
      const unit = await trx('equipmentUnits').where('uuid', req.params.uuid).whereNull('deletedAt').first();

      if (!unit) {
        await trx.rollback();

        return res.incomplete('Equipment unit tidak ditemukan.');
      }

      /*
       * Ketika transaksi rental sudah dibuat, validasi pemakaian unit
       * dapat ditambahkan di sini sebelum unit dihapus.
       */

      await trx('equipmentUnits').where('id', unit.id).update({
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

      console.error('DELETE /equipment-unit/:uuid error:', error);

      return res.fail(error.message || 'Failed to delete equipment unit.');
    }
  });

function createEquipmentUnitQuery(database = db) {
  return database('equipmentUnits as unit')
    .leftJoin('equipmentCategories as category', 'category.id', 'unit.categoryId')
    .leftJoin('fileAttachments as unitImage', function () {
      this.on('unitImage.referenceUuid', '=', 'unit.uuid')
        .andOnVal('unitImage.moduleCode', '=', EQUIPMENT_UNIT_IMAGE_MODULE)
        .andOnVal('unitImage.documentType', '=', EQUIPMENT_UNIT_IMAGE_DOCUMENT_TYPE)
        .andOnVal('unitImage.isActive', '=', 1)
        .andOnNull('unitImage.deletedAt');
    })
    .leftJoin('sysLookups as capacityLookup', function () {
      this.on('capacityLookup.lookupCode', '=', 'unit.capacityUnit')
        .andOnVal('capacityLookup.lookupGroup', '=', 'equipment_capacity_unit')
        .andOnVal('capacityLookup.isActive', '=', 1)
        .andOnNull('capacityLookup.deletedAt');
    })
    .leftJoin('sysLookups as operationalStatusLookup', function () {
      this.on('operationalStatusLookup.lookupCode', '=', 'unit.operationalStatusCode')
        .andOnVal('operationalStatusLookup.lookupGroup', '=', 'equipment_operational_status')
        .andOnVal('operationalStatusLookup.isActive', '=', 1)
        .andOnNull('operationalStatusLookup.deletedAt');
    })
    .select([
      'unit.id',
      'unit.uuid',
      'unit.categoryId',
      'category.uuid as categoryUuid',
      'category.code as categoryCode',
      'category.name as categoryName',
      'category.icon as categoryIcon',
      'unit.unitCode',
      'unit.unitName',
      'unit.assetNumber',
      'unit.modelNumber',
      'unit.plateNumber',
      'unit.capacityValue',
      'unit.capacityUnit',
      'capacityLookup.lookupValue as capacityUnitName',
      'capacityLookup.lookupAlias as capacityUnitAlias',
      'unit.operationalStatusCode',
      'operationalStatusLookup.lookupValue as operationalStatusName',
      'operationalStatusLookup.lookupAlias as operationalStatusAlias',
      'unit.remarks',
      'unitImage.uuid as imageUuid',
      'unitImage.originalName as imageOriginalName',
      'unitImage.mimeType as imageMimeType',
      'unitImage.fileSize as imageFileSize',
      'unitImage.updatedAt as imageUpdatedAt',
      'unit.isActive',
      'unit.createdAt',
      'unit.updatedAt',
    ])
    .whereNull('unit.deletedAt');
}

async function findEquipmentUnitByUuid(uuid) {
  return createEquipmentUnitQuery().where('unit.uuid', uuid).first();
}

async function findCapacityUnitLookup(database, capacityUnit) {
  return database('sysLookups')
    .where('lookupGroup', 'equipment_capacity_unit')
    .whereRaw('UPPER(lookupCode) = ?', [capacityUnit])
    .where('isActive', 1)
    .whereNull('deletedAt')
    .first(['lookupId', 'lookupCode', 'lookupValue', 'lookupAlias']);
}

async function findOperationalStatusLookup(database, operationalStatusCode) {
  return database('sysLookups')
    .where('lookupGroup', 'equipment_operational_status')
    .whereRaw('UPPER(lookupCode) = ?', [operationalStatusCode])
    .where('isActive', 1)
    .whereNull('deletedAt')
    .first(['lookupId', 'lookupCode', 'lookupValue', 'lookupAlias']);
}

async function findActiveEquipmentUnitImage(database, unitUuid) {
  return database('fileAttachments')
    .where({
      moduleCode: EQUIPMENT_UNIT_IMAGE_MODULE,
      referenceUuid: unitUuid,
      documentType: EQUIPMENT_UNIT_IMAGE_DOCUMENT_TYPE,
      isActive: true,
    })
    .whereNull('deletedAt')
    .orderBy('createdAt', 'desc')
    .first();
}

function handleEquipmentUnitImageUpload(req, res, next) {
  if (!equipmentUnitImageUpload) {
    return res.fail('Dependency multer belum terpasang. Jalankan: npm install multer');
  }

  return equipmentUnitImageUpload.single('image')(req, res, (error) => {
    if (!error) {
      return next();
    }

    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.incomplete(`Ukuran gambar maksimal ${Math.round(EQUIPMENT_UNIT_IMAGE_MAX_BYTES / 1024 / 1024)} MB.`);
    }

    return res.incomplete(error.message || 'Gagal membaca file gambar.');
  });
}

function detectImageType(filePath) {
  const descriptor = fs.openSync(filePath, 'r');

  try {
    const buffer = Buffer.alloc(12);
    const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);

    if (bytesRead >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return {
        extension: 'jpg',
        mimeType: 'image/jpeg',
      };
    }

    if (bytesRead >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return {
        extension: 'png',
        mimeType: 'image/png',
      };
    }

    if (bytesRead >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
      return {
        extension: 'webp',
        mimeType: 'image/webp',
      };
    }

    return null;
  } finally {
    fs.closeSync(descriptor);
  }
}

function validateEquipmentUnitImage(file, detectedImage) {
  if (!detectedImage) {
    return 'Format gambar tidak valid. Gunakan JPG, PNG, atau WEBP.';
  }

  const extension = path
    .extname(file.originalname || '')
    .replace('.', '')
    .toLowerCase();
  const allowedExtensions = detectedImage.extension === 'jpg' ? ['jpg', 'jpeg'] : [detectedImage.extension];

  if (!allowedExtensions.includes(extension)) {
    return 'Extension file tidak sesuai dengan isi gambar.';
  }

  const normalizedMimeType = String(file.mimetype || '').toLowerCase();

  if (normalizedMimeType !== detectedImage.mimeType) {
    return 'MIME type file tidak sesuai dengan isi gambar.';
  }

  return null;
}

function removeFileIfExists(filePath) {
  if (!filePath) {
    return;
  }

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error('Failed to remove equipment unit image file:', error);
  }
}

function sanitizeDownloadName(fileName) {
  return String(fileName || 'equipment-unit-image')
    .replace(/[\\/\r\n"]/g, '_')
    .trim();
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
    operationalStatusCode: normalizeRequiredString(payload.operationalStatusCode || 'AVAILABLE').toUpperCase(),
    remarks: normalizeNullableString(payload.remarks),
    isActive: normalizeBoolean(payload.isActive, true),
  };
}

function validatePayload(payload) {
  if (!payload.categoryUuid) {
    return {
      valid: false,
      message: 'Equipment category wajib dipilih.',
    };
  }

  if (!payload.unitCode) {
    return {
      valid: false,
      message: 'Equipment unit code wajib diisi.',
    };
  }

  if (payload.unitCode.length > 50) {
    return {
      valid: false,
      message: 'Equipment unit code maksimal 50 karakter.',
    };
  }

  if (!/^[A-Z0-9_-]+$/.test(payload.unitCode)) {
    return {
      valid: false,
      message: 'Equipment unit code hanya boleh berisi huruf, angka, underscore, dan tanda minus.',
    };
  }

  if (!payload.unitName) {
    return {
      valid: false,
      message: 'Equipment unit name wajib diisi.',
    };
  }

  if (payload.unitName.length > 150) {
    return {
      valid: false,
      message: 'Equipment unit name maksimal 150 karakter.',
    };
  }

  if (payload.assetNumber && payload.assetNumber.length > 100) {
    return {
      valid: false,
      message: 'Asset number maksimal 100 karakter.',
    };
  }

  if (payload.modelNumber && payload.modelNumber.length > 100) {
    return {
      valid: false,
      message: 'Model number maksimal 100 karakter.',
    };
  }

  if (payload.plateNumber && payload.plateNumber.length > 50) {
    return {
      valid: false,
      message: 'Plate number maksimal 50 karakter.',
    };
  }

  if (!payload.capacityValue) {
    return {
      valid: false,
      message: 'Equipment capacity value wajib lebih dari 0.',
    };
  }

  if (!payload.capacityUnit) {
    return {
      valid: false,
      message: 'Equipment capacity unit wajib dipilih.',
    };
  }

  if (payload.capacityUnit.length > 50) {
    return {
      valid: false,
      message: 'Equipment capacity unit maksimal 50 karakter.',
    };
  }

  if (!payload.operationalStatusCode) {
    return {
      valid: false,
      message: 'Equipment operational status wajib dipilih.',
    };
  }

  if (payload.operationalStatusCode.length > 50) {
    return {
      valid: false,
      message: 'Equipment operational status maksimal 50 karakter.',
    };
  }

  if (payload.remarks && payload.remarks.length > 500) {
    return {
      valid: false,
      message: 'Remarks maksimal 500 karakter.',
    };
  }

  return {
    valid: true,
  };
}

function normalizeRequiredString(value) {
  if (typeof value !== 'string') {
    return '';
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
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const normalizedValue = Number(value);

  if (!Number.isFinite(normalizedValue) || normalizedValue <= 0) {
    return null;
  }

  return normalizedValue;
}

function normalizeBoolean(value, defaultValue = false) {
  if (value === null || value === undefined || value === '') {
    return defaultValue;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value === 1;
  }

  return ['true', '1', 'yes', 'y'].includes(String(value).trim().toLowerCase());
}

function parseBooleanQuery(value) {
  const normalizedValue = String(value).trim().toLowerCase();

  if (['true', '1', 'yes', 'y'].includes(normalizedValue)) {
    return true;
  }

  if (['false', '0', 'no', 'n'].includes(normalizedValue)) {
    return false;
  }

  throw new Error('Query isActive harus berupa true atau false.');
}

async function rollbackTransaction(trx) {
  if (!trx.isCompleted()) {
    await trx.rollback();
  }
}

module.exports = router;
