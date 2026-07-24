exports.up = function (knex) {
  return knex.schema.createTable("roles", function (table) {
    table.bigIncrements("id").primary();
    table.uuid("uuid").notNullable().unique();
    table.string("code", 50).notNullable().unique();
    table.string("name", 100).notNullable();
    table.string("description", 255).nullable();
    table.boolean("isSystem").notNullable().defaultTo(false);
    table.timestamp("createdAt").notNullable().defaultTo(knex.fn.now());
    table.timestamp("updatedAt").notNullable().defaultTo(knex.fn.now());
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists("roles");
};
