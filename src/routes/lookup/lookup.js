"use strict";

const express = require("express");
const router = express.Router();

const db = require("../../lib/db")();

router.get("/", async (req, res) => {
  try {
    const { lookupGroup, lookupCode, isActive } = req.query;
    const query = db("sysLookups")
      .select([
        "lookupId",
        "lookupCode",
        "lookupValue",
        "lookupAlias",
        "lookupGroup",
        "siteId",
        "isActive",
        "createdAt",
        "updatedAt",
      ])
      .whereNull("deletedAt");

    if (lookupGroup) {
      query.where("lookupGroup", lookupGroup);
    }

    if (lookupCode) {
      query.where("lookupCode", lookupCode);
    }

    if (isActive !== undefined) {
      query.where("isActive", Number(isActive));
    }

    const lookups = await query.orderBy("lookupValue", "asc");

    return res.success(lookups, "Lookups retrieved successfully.");
  } catch (error) {
    return res.fail(error);
  }
});

module.exports = router;
