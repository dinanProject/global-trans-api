"use strict";

const express = require("express");
const route = express.Router();

route.get("/health", function (req, res) {
  return res.success({
    service: "global-trans-api",
    status: "up",
  });
});

route.use("/auth", require("../modules/auth/auth.routes"));

module.exports = route;
