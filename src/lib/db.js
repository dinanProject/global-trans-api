"use strict";

const knex = require("knex");
const config = require("../../config");

const instances = {};

module.exports = function (database = "default") {
  if (instances[database]) {
    return instances[database];
  }

  const selectedDatabase = config.DB[database];

  if (!selectedDatabase) {
    throw new Error(`Database configuration for "${database}" not found.`);
  }

  // instances[database] = knex({
  //   client: selectedDatabase.client || "mysql2",
  //   connection: {
  //     host: selectedDatabase.host,
  //     port: Number(selectedDatabase.port || 3306),
  //     user: selectedDatabase.user,
  //     password: selectedDatabase.password,
  //     database: selectedDatabase.database,
  //     charset: "utf8mb4",
  //   },
  //   pool: {
  //     min: 2,
  //     max: 10,
  //   },
  // });

  const db = knex({
    client: selectedDatabase.client || "mysql2",

    connection: {
      host: selectedDatabase.host,

      port: Number(selectedDatabase.port || 3306),

      user: selectedDatabase.user,

      password: selectedDatabase.password,

      database: selectedDatabase.database,

      charset: "utf8mb4",
    },

    pool: {
      min: 2,

      max: 10,
    },
  });

  // TEMP PERFORMANCE INSTRUMENTATION

  const queryStartedAt = new Map();

  db.on("query", (query) => {
    const queryId = query.__knexQueryUid;

    if (queryId) {
      queryStartedAt.set(queryId, Date.now());
    }

    console.log(`[DB START] ${queryId || "-"} ${query.sql}`);
  });

  db.on("query-response", (_response, query) => {
    const queryId = query.__knexQueryUid;

    const startedAt = queryId ? queryStartedAt.get(queryId) : null;

    const duration = startedAt ? Date.now() - startedAt : null;

    if (queryId) {
      queryStartedAt.delete(queryId);
    }

    console.log(`[DB END] ${queryId || "-"} ${duration ?? "?"} ms`);
  });

  db.on("query-error", (error, query) => {
    const queryId = query.__knexQueryUid;

    const startedAt = queryId ? queryStartedAt.get(queryId) : null;

    const duration = startedAt ? Date.now() - startedAt : null;

    if (queryId) {
      queryStartedAt.delete(queryId);
    }

    console.error(
      `[DB ERROR] ${queryId || "-"} ${duration ?? "?"} ms`,

      error.message,
    );
  });

  instances[database] = db;

  return instances[database];
};
