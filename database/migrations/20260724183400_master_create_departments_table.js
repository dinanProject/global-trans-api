exports.up = function (knex) {
  return knex.schema.createTable("departments", function (table) {
    table.bigIncrements("id").primary();
    table.uuid("uuid").notNullable().unique();
    table.bigInteger("divisionId").unsigned().notNullable();
    table.string("code", 50).notNullable();
    table.string("name", 150).notNullable();
    table.string("description", 255).nullable();
    table.boolean("isActive").notNullable().defaultTo(true);
    table.timestamp("createdAt").notNullable().defaultTo(knex.fn.now());
    table.timestamp("updatedAt").notNullable().defaultTo(knex.fn.now());
    table.timestamp("deletedAt").nullable();

    table
      .foreign("divisionId")
      .references("id")
      .inTable("divisions")
      .onUpdate("CASCADE")
      .onDelete("RESTRICT");

    table.unique(["divisionId", "code"]);
    table.index("divisionId", "idx_departments_divisionId");
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists("departments");
};
