'use strict';

const express = require('express');
const router = express.Router();

router.use('/request', require('./request'));
router.use('/approval', require('./approval'));
router.use('/operations', require('./operations'));
router.use('/monitoring', require('./monitoring'));
router.use('/report', require('./report'));

module.exports = router;
