"use strict";

const express = require("express");
const backendController = require("./backend.controller");
const authentication = require("../../lib/authentication");

const router = express.Router();

router.get("/", authentication, backendController.getBootstrap);

module.exports = router;
