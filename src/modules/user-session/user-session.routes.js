"use strict";

const express = require("express");
const router = express.Router();

const authentication = require("../../lib/authentication");
const userSessionController = require("./user-session.controller");

router.get("/", authentication, userSessionController.getUserSession);

module.exports = router;
