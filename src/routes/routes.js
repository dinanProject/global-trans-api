"use strict";

const express = require("express");
const route = express.Router();

route.use("/auth", require("../modules/auth/auth.routes"));
route.use(
  "/user-session",
  require("../modules/user-session/user-session.routes"),
);
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
route.use(
  "/equipment-request",
  require("./equipment-request/equipment-request"),
);

route.use("/email-template", require("./email-template/email-template"));
route.use("/email-outbox", require("./email-outbox/email-outbox"));
route.use(
  "/equipment-monitoring",
  require("./equipment-monitoring/equipment-monitoring"),
);
route.use("/file-attachment", require("./file-attachment/file-attachment"));
route.use("/audit-log", require("./audit-log/audit-log"));

module.exports = route;
