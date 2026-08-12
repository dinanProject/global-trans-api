'use strict';

const crypto = require('crypto');

const db = require('../../lib/db')();

const LOGIN_STATUS_GROUP = 'LOGIN_STATUS';

const LOGIN_STATUS = Object.freeze({
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
});

const LOGIN_FAILURE_REASON = Object.freeze({
  MISSING_CREDENTIALS: 'MISSING_CREDENTIALS',

  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  INVALID_PASSWORD: 'INVALID_PASSWORD',

  USER_NOT_FOUND: 'USER_NOT_FOUND',
  USER_INACTIVE: 'USER_INACTIVE',

  ACCESS_LOAD_FAILED: 'ACCESS_LOAD_FAILED',
  SESSION_CREATION_FAILED: 'SESSION_CREATION_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
});
const statusIdCache = new Map();

function normalizeText(value, maximumLength) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalizedValue = value.trim();

  if (!normalizedValue) {
    return null;
  }

  return normalizedValue.slice(0, maximumLength);
}

function normalizeEmail(email) {
  if (typeof email !== 'string') {
    return null;
  }

  const normalizedEmail = email.trim().toLowerCase();

  return normalizedEmail || null;
}

async function getLoginStatusId(statusCode, siteId = 1) {
  const cacheKey = `${siteId}:${statusCode}`;

  if (statusIdCache.has(cacheKey)) {
    return statusIdCache.get(cacheKey);
  }

  const lookup = await db('sysLookups')
    .where({
      lookupGroup: LOGIN_STATUS_GROUP,
      lookupCode: statusCode,
      siteId,
      isActive: 1,
    })
    .whereNull('deletedAt')
    .first('lookupId');

  if (!lookup) {
    throw new Error(`Lookup ${LOGIN_STATUS_GROUP}/${statusCode} tidak ditemukan.`);
  }

  statusIdCache.set(cacheKey, lookup.lookupId);

  return lookup.lookupId;
}

async function createLoginLog({
  userId = null,
  email = null,
  statusCode,
  failureReason = null,
  failureMessage = null,
  ipAddress = null,
  userAgent = null,
  siteId = 1,
}) {
  const loginStatusId = await getLoginStatusId(statusCode, siteId);

  await db('userLoginLogs').insert({
    uuid: crypto.randomUUID(),
    userId: userId ?? null,
    email: normalizeEmail(email),
    loginStatusId,
    failureReason: normalizeText(failureReason, 100),
    failureMessage: normalizeText(failureMessage, 500),
    ipAddress: normalizeText(ipAddress, 64),
    userAgent: normalizeText(userAgent, 1000),
    createdAt: new Date(),
  });
}

async function createLoginLogSafely(payload) {
  try {
    await createLoginLog(payload);
  } catch (error) {
    console.error('[LOGIN LOG] Gagal menyimpan audit login:', error);
  }
}

module.exports = {
  LOGIN_STATUS,
  LOGIN_FAILURE_REASON,
  createLoginLog,
  createLoginLogSafely,
};
