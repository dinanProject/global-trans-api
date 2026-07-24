const bcrypt = require("bcrypt");

exports.seed = async function (knex) {
  await knex.transaction(async (trx) => {
    await knex("sysLookups")
      .insert([
        {
          lookupCode: "HOLDER",
          lookupValue: "Holder",
          lookupAlias: "Holder",
          lookupGroup: "company_type",
          siteId: 1,
          isActive: true,
        },
        {
          lookupCode: "CUSTOMER",
          lookupValue: "Customer",
          lookupAlias: "Customer",
          lookupGroup: "company_type",
          siteId: 1,
          isActive: true,
        },
      ])
      .onConflict(["lookupGroup", "lookupCode", "siteId"])
      .merge({
        lookupValue: knex.raw("VALUES(lookupValue)"),
        lookupAlias: knex.raw("VALUES(lookupAlias)"),
        isActive: knex.raw("VALUES(isActive)"),
      });

    const holder = await knex("sysLookups")
      .where({
        lookupGroup: "company_type",
        lookupCode: "HOLDER",
        siteId: 1,
      })
      .first();

    await knex("companies")
      .insert({
        uuid: knex.raw("UUID()"),
        code: "GLOBAL_TRANS",
        name: "Global Trans",
        companyTypeId: holder.lookupId,
        isActive: true,
        email: "admin@globaltrans.com",
      })
      .onConflict("code")
      .merge({
        name: "Global Trans",
        companyTypeId: holder.lookupId,
        isActive: true,
        email: "admin@globaltrans.com",
      });

    await knex("roles")
      .insert({
        uuid: knex.raw("UUID()"),
        code: "SUPER_ADMIN",
        name: "Super Admin",
        description: "Full access to all system features",
        isSystem: true,
      })
      .onConflict("code")
      .merge({
        name: "Super Admin",
        description: "Full access to all system features",
        isSystem: true,
      });

    await knex("permissions")
      .insert([
        {
          uuid: knex.raw("UUID()"),
          code: "AUTH.LOGIN",
          label: "Login",
          module: "AUTH",
          action: "LOGIN",
          description: "Allow user to login",
        },
        {
          uuid: knex.raw("UUID()"),
          code: "AUTH.PROFILE",
          label: "View Profile",
          module: "AUTH",
          action: "PROFILE",
          description: "Allow user to view own profile",
        },
        {
          uuid: knex.raw("UUID()"),
          code: "USER.VIEW",
          label: "View User",
          module: "USER",
          action: "VIEW",
          description: "Allow user to view users",
        },
        {
          uuid: knex.raw("UUID()"),
          code: "USER.CREATE",
          label: "Create User",
          module: "USER",
          action: "CREATE",
          description: "Allow user to create users",
        },
        {
          uuid: knex.raw("UUID()"),
          code: "USER.UPDATE",
          label: "Update User",
          module: "USER",
          action: "UPDATE",
          description: "Allow user to update users",
        },
      ])
      .onConflict("code")
      .merge({
        label: knex.raw("VALUES(label)"),
        module: knex.raw("VALUES(module)"),
        action: knex.raw("VALUES(action)"),
        description: knex.raw("VALUES(description)"),
      });

    const superAdminRole = await knex("roles")
      .where({ code: "SUPER_ADMIN" })
      .first();

    const permissions = await knex("permissions").select("id");

    for (const permission of permissions) {
      await knex("rolePermissions")
        .insert({
          roleId: superAdminRole.id,
          permissionId: permission.id,
        })
        .onConflict(["roleId", "permissionId"])
        .ignore();
    }

    const company = await knex("companies")
      .where({ code: "GLOBAL_TRANS" })
      .first();

    const password = await bcrypt.hash("Admin123!", 12);

    await knex("users")
      .insert({
        uuid: knex.raw("UUID()"),
        companyId: company.id,
        divisionId: null,
        departmentId: null,
        email: "admin@globaltrans.com",
        password,
        fullName: "System Administrator",
        phone: null,
        isActive: true,
      })
      .onConflict("email")
      .merge({
        companyId: company.id,
        fullName: "System Administrator",
        isActive: true,
      });

    const adminUser = await knex("users")
      .where({ email: "admin@globaltrans.com" })
      .first();

    await knex("userRoles")
      .insert({
        userId: adminUser.id,
        roleId: superAdminRole.id,
      })
      .onConflict(["userId", "roleId"])
      .ignore();
  });
};
