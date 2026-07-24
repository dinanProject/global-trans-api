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

  instances[database] = knex({
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

  return instances[database];
};
