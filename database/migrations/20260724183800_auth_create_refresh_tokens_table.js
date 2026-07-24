exports.up = function (knex) {
  return knex.schema.createTable("refreshTokens", function (table) {
    table.bigIncrements("id").primary();
    table.uuid("uuid").notNullable().unique();
    table.bigInteger("userId").unsigned().notNullable();
    table.text("tokenHash").notNullable();
    table.string("ipAddress", 45).nullable();
    table.string("userAgent", 500).nullable();
    table.timestamp("expiresAt").notNullable();
    table.timestamp("revokedAt").nullable();
    table.timestamp("createdAt").notNullable().defaultTo(knex.fn.now());

    table
      .foreign("userId")
      .references("id")
      .inTable("users")
      .onUpdate("CASCADE")
      .onDelete("CASCADE");

    table.index("userId", "idx_refreshTokens_userId");
    table.index("expiresAt", "idx_refreshTokens_expiresAt");
    table.index("revokedAt", "idx_refreshTokens_revokedAt");
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists("refreshTokens");
};
