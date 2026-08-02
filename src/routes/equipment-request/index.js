"use strict";

const express = require("express");
const router = express.Router();

router.use("/request", require("./request"));
router.use("/approval", require("./approval"));
router.use("/assignment", require("./assignment"));
router.use("/monitoring", require("./monitoring"));

module.exports = router;
