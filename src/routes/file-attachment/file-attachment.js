'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
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
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.gif', '.webp']);
const ALLOWED_MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_FILE_COUNT = Number(process.env.FILE_UPLOAD_MAX_COUNT || 5);
const uploadRoot = path.resolve(process.env.FILE_UPLOAD_PATH || path.join(process.cwd(), 'uploads'));
fs.mkdirSync(uploadRoot, { recursive: true });
const upload = multer
  ? multer({
      dest: uploadRoot,
      limits: {
        fileSize: Number(process.env.FILE_UPLOAD_MAX_BYTES || 10 * 1024 * 1024),
      },
    })
  : null;
router.use(authentication);
router.post(
  '/upload',
  authorization('FILE_ATTACHMENT.CREATE'),
  (req, res, next) => {
    if (!upload) return res.fail('Dependency multer belum terpasang. Jalankan: npm install multer');
    return upload.single('file')(req, res, next);
  },
  async (req, res) => {
    const trx = await db.transaction();
    try {
      if (!req.file) {
        await trx.rollback();
        return res.incomplete('File wajib dipilih.');
      }
      const moduleCode = String(req.body.moduleCode || '')
        .trim()
        .toUpperCase();
      const referenceUuid = String(req.body.referenceUuid || '').trim();
      if (!moduleCode || !referenceUuid) {
        fs.unlinkSync(req.file.path);
        await trx.rollback();
        return res.incomplete('moduleCode dan referenceUuid wajib diisi.');
      }
      const validation = validateAttachment(req.file);
      if (!validation.valid) {
        fs.unlinkSync(req.file.path);
        await trx.rollback();
        return res.incomplete(validation.message);
      }
      const countRow = await trx('fileAttachments').where({ moduleCode, referenceUuid, isActive: true }).whereNull('deletedAt').count({ count: '*' }).first();
      if (Number(countRow?.count || 0) >= MAX_FILE_COUNT) {
        fs.unlinkSync(req.file.path);
        await trx.rollback();
        return res.incomplete(`Maksimal ${MAX_FILE_COUNT} attachment per reference.`);
      }
      const access = req.getData().access;
      const uuid = randomUUID();
      const now = db.fn.now();
      await trx('fileAttachments').insert({
        uuid,
        moduleCode,
        referenceId: req.body.referenceId || null,
        referenceUuid,
        documentType: req.body.documentType || null,
        originalName: req.file.originalname,
        storedName: req.file.filename,
        filePath: req.file.path,
        mimeType: validation.mimeType,
        fileSize: req.file.size,
        description: req.body.description || null,
        uploadedBy: access.user.id,
        uploadedAt: now,
        isActive: true,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
      await trx.commit();
      return res.success(await db('fileAttachments').where('uuid', uuid).first());
    } catch (error) {
      await trx.rollback();
      if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.fail(error.message || 'Failed to upload file.');
    }
  }
);
router.get('/', authorization('FILE_ATTACHMENT.VIEW'), async (req, res) => {
  try {
    const query = db('fileAttachments as file')
      .leftJoin('users as uploader', 'uploader.id', 'file.uploadedBy')
      .select(['file.*', 'uploader.uuid as uploadedByUuid', 'uploader.fullName as uploadedByName'])
      .where('file.isActive', true)
      .whereNull('file.deletedAt');
    if (req.query.moduleCode) query.where('file.moduleCode', String(req.query.moduleCode).toUpperCase());
    if (req.query.referenceUuid) query.where('file.referenceUuid', req.query.referenceUuid);
    if (req.query.documentType) query.where('file.documentType', req.query.documentType);
    return res.success(await query.orderBy('file.createdAt', 'desc'));
  } catch (error) {
    return res.fail(error.message || 'Failed to load attachments.');
  }
});
router.get('/:uuid/download', authorization('FILE_ATTACHMENT.VIEW'), async (req, res) => {
  try {
    const row = await db('fileAttachments').where({ uuid: req.params.uuid, isActive: true }).whereNull('deletedAt').first();
    if (!row || !fs.existsSync(row.filePath)) return res.incomplete('File tidak ditemukan.');
    return res.download(row.filePath, row.originalName);
  } catch (error) {
    return res.fail(error.message || 'Failed to download file.');
  }
});
router.delete('/:uuid', authorization('FILE_ATTACHMENT.DELETE'), async (req, res) => {
  try {
    const updated = await db('fileAttachments').where({ uuid: req.params.uuid, isActive: true }).whereNull('deletedAt').update({
      isActive: false,
      deletedAt: db.fn.now(),
      updatedAt: db.fn.now(),
    });
    return updated ? res.success({ uuid: req.params.uuid }) : res.incomplete('Attachment tidak ditemukan.');
  } catch (error) {
    return res.fail(error.message || 'Failed to delete attachment.');
  }
});
function validateAttachment(file) {
  const extension = path.extname(String(file.originalname || '')).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension) || !ALLOWED_MIME_TYPES.has(file.mimetype)) {
    return { valid: false, message: 'Attachment hanya boleh berupa PDF atau image (JPG, PNG, GIF, WEBP).' };
  }
  const buffer = Buffer.alloc(12);
  const fd = fs.openSync(file.path, 'r');
  const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
  fs.closeSync(fd);
  const head = buffer.subarray(0, bytesRead);
  let detected = null;
  if (head.subarray(0, 5).toString('ascii') === '%PDF-') detected = 'application/pdf';
  else if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) detected = 'image/jpeg';
  else if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) detected = 'image/png';
  else if (head.length >= 6 && ['GIF87a', 'GIF89a'].includes(head.subarray(0, 6).toString('ascii'))) detected = 'image/gif';
  else if (head.length >= 12 && head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP') detected = 'image/webp';
  if (!detected || detected !== file.mimetype) return { valid: false, message: 'Isi file tidak sesuai dengan tipe attachment yang diizinkan.' };
  return { valid: true, mimeType: detected };
}

module.exports = router;
