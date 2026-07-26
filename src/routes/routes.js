"use strict";

const express = require("express");
const route = express.Router();

route.use("/auth", require("../modules/auth/auth.routes"));
route.use("/backend", require("../modules/backend/backend.routes"));
route.use("/lookup", require("./lookup/lookup"));
route.use("/menu", require("./menu/menu"));
route.use("/company", require("./company/company"));
route.use("/division", require("./division/division"));
route.use("/role", require("./role/role"));

module.exports = route;
