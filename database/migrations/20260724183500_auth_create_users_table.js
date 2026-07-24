exports.up = function (knex) {
  return knex.schema.createTable("users", function (table) {
    table.bigIncrements("id").primary();
    table.uuid("uuid").notNullable().unique();
    table.bigInteger("companyId").unsigned().notNullable();
    table.bigInteger("divisionId").unsigned().nullable();
    table.bigInteger("departmentId").unsigned().nullable();
    table.string("email", 150).notNullable().unique();
    table.string("password", 255).notNullable();
    table.string("fullName", 150).notNullable();
    table.string("phone", 30).nullable();
    table.boolean("isActive").notNullable().defaultTo(true);
    table.timestamp("lastLoginAt").nullable();
    table.timestamp("createdAt").notNullable().defaultTo(knex.fn.now());
    table.timestamp("updatedAt").notNullable().defaultTo(knex.fn.now());
    table.timestamp("deletedAt").nullable();

    table
      .foreign("companyId")
      .references("id")
      .inTable("companies")
      .onUpdate("CASCADE")
      .onDelete("RESTRICT");

    table
      .foreign("divisionId")
      .references("id")
      .inTable("divisions")
      .onUpdate("CASCADE")
      .onDelete("SET NULL");

    table
      .foreign("departmentId")
      .references("id")
      .inTable("departments")
      .onUpdate("CASCADE")
      .onDelete("SET NULL");

    table.index("companyId", "idx_users_companyId");
    table.index("divisionId", "idx_users_divisionId");
    table.index("departmentId", "idx_users_departmentId");
    table.index("isActive", "idx_users_isActive");
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists("users");
};
