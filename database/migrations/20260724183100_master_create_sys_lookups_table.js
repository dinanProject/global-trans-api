exports.up = function (knex) {
  return knex.schema.createTable("sysLookups", function (table) {
    table.bigIncrements("lookupId").primary();

    table.string("lookupCode", 50).notNullable();

    table.string("lookupValue", 150).notNullable();

    table.string("lookupAlias", 50).nullable();

    table.string("lookupGroup", 100).notNullable();

    table.bigInteger("siteId").unsigned().nullable();

    table.boolean("isActive").notNullable().defaultTo(true);

    table.timestamp("createdAt").notNullable().defaultTo(knex.fn.now());

    table.timestamp("updatedAt").notNullable().defaultTo(knex.fn.now());

    table.timestamp("deletedAt").nullable();

    table.unique(
      ["lookupGroup", "lookupCode", "siteId"],
      "uq_sysLookups_group_code_site",
    );

    table.index("lookupGroup");
    table.index("siteId");
  });
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists("sysLookups");
};
