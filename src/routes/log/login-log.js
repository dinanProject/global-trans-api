"use strict";

const express = require("express");

const route = express.Router();

const db = require("../../lib/db")();
const {
  authenticate: authentication,
  authorize,
} = require("../../modules/access/access.middleware");

route.get(
  "/",
  authentication,
  authorize("LOGIN_LOG.VIEW"),
  async function (req, res, next) {
    try {
      const search =
        typeof req.query.search === "string" ? req.query.search.trim() : "";

      const status =
        typeof req.query.status === "string"
          ? req.query.status.trim().toUpperCase()
          : "";

      const dateFrom =
        typeof req.query.dateFrom === "string" ? req.query.dateFrom.trim() : "";

      const dateTo =
        typeof req.query.dateTo === "string" ? req.query.dateTo.trim() : "";

      const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);

      const limit = Math.min(
        Math.max(Number.parseInt(req.query.limit, 10) || 20, 1),
        100,
      );

      const offset = (page - 1) * limit;

      const query = db("userLoginLogs as logs")
        .leftJoin(
          "sysLookups as statuses",
          "statuses.lookupId",
          "logs.loginStatusId",
        )
        .leftJoin("users as users", "users.id", "logs.userId")
        .where("statuses.lookupGroup", "LOGIN_STATUS");

      if (search) {
        query.andWhere(function () {
          this.where("logs.email", "like", `%${search}%`)
            .orWhere("users.fullName", "like", `%${search}%`)
            .orWhere("logs.ipAddress", "like", `%${search}%`);
        });
      }

      if (status) {
        query.andWhere("statuses.lookupCode", status);
      }

      if (dateFrom) {
        query.andWhere("logs.createdAt", ">=", `${dateFrom} 00:00:00`);
      }

      if (dateTo) {
        query.andWhere(
          "logs.createdAt",
          "<",
          db.raw("DATE_ADD(?, INTERVAL 1 DAY)", [dateTo]),
        );
      }

      const countResult = await query
        .clone()
        .clearSelect()
        .clearOrder()
        .countDistinct({
          total: "logs.id",
        })
        .first();

      const total = Number(countResult?.total ?? 0);

      const data = await query
        .clone()
        .select([
          "logs.id",
          "logs.uuid",
          "logs.userId",
          "logs.email",
          "users.fullName",
          "logs.loginStatusId",
          "statuses.lookupCode as statusCode",
          "statuses.lookupValue as statusName",
          "statuses.lookupAlias as statusAlias",
          "logs.failureReason",
          "logs.failureMessage",
          "logs.ipAddress",
          "logs.userAgent",
          "logs.createdAt",
        ])
        .orderBy("logs.createdAt", "desc")
        .limit(limit)
        .offset(offset);

      return res.success({
        data,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (err) {
      next(err);
    }
  },
);
module.exports = route;
