module.exports = (function () {
  const env = process.env;

  return {
    PORT: Number(env.PORT || 3000),

    DB: {
      default: {
        host: env.DB_HOST,
        port: env.DB_PORT,
        user: env.DB_USER,
        password: env.DB_PASSWORD,
        database: env.DB_DATABASE,
        client: env.DB_CLIENT || "mysql2",
      },
    },
  };
})();
