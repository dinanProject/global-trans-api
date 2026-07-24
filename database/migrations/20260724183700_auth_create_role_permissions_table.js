exports.up = function (knex) {
  return knex.schema.createTable("rolePermissions", function (table) {
    table.bigIncrements("id").primary();
    table.bigInteger("roleId").unsigned().notNullable();
    table.bigInteger("permissionId").unsigned().notNullable();
    table.timestamp("createdAt").notNullable().defaultTo(knex.fn.now());

    table
      .foreign("roleId")
      .references("id")
      .inTable("roles")
      .onDelete("CASCADE");

    table
      .foreign("permissionId")
      .references("id")
      .inTable("permissions")
      .onDelete("CASCADE");

    table.unique(["roleId", "permissionId"]);
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists("rolePermissions");
};
