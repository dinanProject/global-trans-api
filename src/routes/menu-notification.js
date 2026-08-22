'use strict';

const express = require('express');

const router = express.Router();
const db = require('../lib/db')();
const { authenticate: authentication } = require('../modules/access/access.middleware');
const { getUnreadMenuCounts, markReferenceAsRead } = require('../services/menu-notification');

router.use(authentication);

router.get('/unread-counts', async function (req, res, next) {
  try {
    const access = req.getAccess();
    const recipientUserId = access?.user?.id;

    if (!recipientUserId) {
      return res.unauthenticated('User access information was not found.');
    }

    const unreadCounts = await getUnreadMenuCounts(db, recipientUserId);

    return res.success(Object.fromEntries(unreadCounts));
  } catch (error) {
    return next(error);
  }
});

router.post('/reference/:referenceUuid/read', async function (req, res, next) {
  const trx = await db.transaction();

  try {
    const access = req.getAccess();
    const recipientUserId = access?.user?.id;
    const referenceUuid = req.params.referenceUuid;
    const menuPermissionCode = req.body?.menuPermissionCode;

    if (!recipientUserId || !referenceUuid || !menuPermissionCode) {
      await trx.rollback();
      return res.incomplete('referenceUuid and menuPermissionCode are required.');
    }

    const updatedCount = await markReferenceAsRead(trx, {
      recipientUserId,
      referenceUuid,
      menuPermissionCode,
    });

    await trx.commit();

    return res.success({ updatedCount });
  } catch (error) {
    await trx.rollback();
    return next(error);
  }
});

module.exports = router;
