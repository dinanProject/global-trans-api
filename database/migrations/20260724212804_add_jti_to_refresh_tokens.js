exports.up = function (knex) {
  return knex.schema.alterTable("refreshTokens", function (table) {
    table.uuid("jti").nullable().unique().after("uuid");
  });
};

exports.down = function (knex) {
  return knex.schema.alterTable("refreshTokens", function (table) {
    table.dropColumn("jti");
  });
};
