"use strict";

const express = require("express");
const route = express.Router();

route.use("/auth", require("../modules/auth/auth.routes"));
route.use("/backend", require("../modules/backend/backend.routes"));
route.use("/menu", require("./menu/menu"));

module.exports = route;
