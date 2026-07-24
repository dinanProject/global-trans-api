require("dotenv").config();

module.exports = {
  development: {
    client: "mysql2",

    connection: {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      charset: "utf8mb4",
    },

    pool: {
      min: 2,
      max: 10,
    },

    migrations: {
      directory: "./database/migrations",
    },

    seeds: {
      directory: "./database/seeds",
    },
  },
};
