exports.up = function (knex) {
  return knex.schema.createTable("userRoles", function (table) {
    table.bigIncrements("id").primary();
    table.bigInteger("userId").unsigned().notNullable();
    table.bigInteger("roleId").unsigned().notNullable();
    table.timestamp("createdAt").notNullable().defaultTo(knex.fn.now());

    table
      .foreign("userId")
      .references("id")
      .inTable("users")
      .onUpdate("CASCADE")
      .onDelete("CASCADE");

    table
      .foreign("roleId")
      .references("id")
      .inTable("roles")
      .onUpdate("CASCADE")
      .onDelete("CASCADE");

    table.unique(["userId", "roleId"]);
    table.index("userId", "idx_userRoles_userId");
    table.index("roleId", "idx_userRoles_roleId");
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists("userRoles");
};
