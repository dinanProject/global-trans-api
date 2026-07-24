exports.up = function (knex) {
  return knex.schema.createTable("divisions", function (table) {
    table.bigIncrements("id").primary();
    table.uuid("uuid").notNullable().unique();

    table.bigInteger("companyId").unsigned().notNullable();

    table.string("code", 50).notNullable();
    table.string("name", 150).notNullable();
    table.string("description", 255).nullable();

    table.boolean("isActive").notNullable().defaultTo(true);

    table.timestamp("createdAt").notNullable().defaultTo(knex.fn.now());
    table.timestamp("updatedAt").notNullable().defaultTo(knex.fn.now());
    table.timestamp("deletedAt").nullable();

    table
      .foreign("companyId")
      .references("id")
      .inTable("companies")
      .onUpdate("CASCADE")
      .onDelete("RESTRICT");

    table.unique(["companyId", "code"]);
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists("divisions");
};
