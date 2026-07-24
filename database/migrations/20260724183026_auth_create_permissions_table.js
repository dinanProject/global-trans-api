exports.up = function (knex) {
  return knex.schema.createTable("permissions", function (table) {
    table.bigIncrements("id").primary();
    table.uuid("uuid").notNullable().unique();
    table.string("code", 100).notNullable().unique();
    table.string("label", 150).notNullable();
    table.string("module", 50).notNullable();
    table.string("action", 50).notNullable();
    table.string("description", 255).nullable();
    table.timestamp("createdAt").notNullable().defaultTo(knex.fn.now());
    table.timestamp("updatedAt").notNullable().defaultTo(knex.fn.now());
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists("permissions");
};
