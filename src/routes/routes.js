"use strict";

const express = require("express");
const route = express.Router();

route.use("/auth", require("../modules/auth/auth.routes"));
route.use("/backend", require("../modules/backend/backend.routes"));
route.use("/user-role", require("./administration/user-role"));
route.use("/role", require("./administration/role"));
route.use("/permission", require("./administration/permission"));
route.use("/role-permission", require("./administration/role-permission"));
route.use("/role-menu", require("./administration/role-menu"));
route.use("/user", require("./administration/user"));

route.use("/lookup", require("./lookup/lookup"));
route.use("/menu", require("./menu/menu"));
route.use("/company", require("./company/company"));
route.use("/division", require("./division/division"));
route.use("/equipment-category", require("./equipment/category"));
route.use("/equipment-unit", require("./equipment/unit"));

module.exports = route;
