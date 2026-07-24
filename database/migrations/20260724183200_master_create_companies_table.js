exports.up = function (knex) {
  return knex.schema.createTable("companies", function (table) {
    table.bigIncrements("id").primary();
    table.uuid("uuid").notNullable().unique();
    table.string("code", 50).notNullable().unique();
    table.string("name", 150).notNullable();
    table.bigInteger("companyTypeId").unsigned().notNullable();
    table.boolean("isActive").notNullable().defaultTo(true);
    table.string("taxNumber", 50).nullable();
    table.string("email", 150).nullable();
    table.string("phone", 30).nullable();
    table.string("address", 255).nullable();
    table.string("city", 100).nullable();
    table.string("province", 100).nullable();
    table.string("postalCode", 20).nullable();
    table.timestamp("createdAt").notNullable().defaultTo(knex.fn.now());
    table.timestamp("updatedAt").notNullable().defaultTo(knex.fn.now());
    table.timestamp("deletedAt").nullable();
    table
      .foreign("companyTypeId")
      .references("lookupId")
      .inTable("sysLookups")
      .onUpdate("CASCADE")
      .onDelete("RESTRICT");

    table.index("companyTypeId", "idx_companies_companyTypeId");
    table.index("isActive", "idx_companies_isActive");
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists("companies");
};
