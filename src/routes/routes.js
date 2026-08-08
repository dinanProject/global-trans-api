"use strict";

const express = require("express");
const route = express.Router();

route.use(require("../modules/access/access.routes"));

route.use("/user-role", require("./administration/user-role"));
route.use("/role", require("./administration/role"));
route.use("/permission", require("./administration/permission"));
route.use("/role-permission", require("./administration/role-permission"));
route.use("/user", require("./administration/user"));

route.use("/lookup", require("./lookup/lookup"));
route.use("/menu", require("./menu/menu"));
route.use("/company", require("./company/company"));
route.use("/division", require("./division/division"));
route.use("/equipment-category", require("./equipment/category"));
route.use("/equipment-unit", require("./equipment/unit"));
route.use("/equipment-request", require("./equipment-request"));

route.use("/file-attachment", require("./file-attachment/file-attachment"));
route.use("/home", require("./home/dashboard"));
route.use("/email", require("./administration/email"));
route.use("/login-log", require("./log/login-log"));

module.exports = route;
