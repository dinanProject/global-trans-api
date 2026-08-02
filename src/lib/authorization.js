"use strict";

const db = require("./db")();

const { getUserAccess } = require("./user-access");
const HOLDER_COMPANY_TYPE = 1;

/**
 * Normalize permission input.
 *
 * Supported:
 *
 * authorization("USER.UPDATE")
 *
 * authorization([
 *   "USER.UPDATE",
 *   "USER.ROLE.ASSIGN",
 * ])
 */
function normalizePermissions(permissions) {
  if (!permissions) {
    return [];
  }

  if (Array.isArray(permissions)) {
    return [
      ...new Set(
        permissions
          .filter((permission) => typeof permission === "string")
          .map((permission) => permission.trim())
          .filter(Boolean),
      ),
    ];
  }

  if (typeof permissions === "string" && permissions.trim()) {
    return [permissions.trim()];
  }

  return [];
}

function authorization(
  permissions,
  {
    requireAll = true,
    holderOnly = false,
    allowSelf = false,
    userUuidParam = "userUuid",
  } = {},
) {
  const requiredPermissions = normalizePermissions(permissions);

  return async function authorize(req, res, next) {
    try {
      const authenticatedUser = req.getUser();

      const authenticatedUserId =
        authenticatedUser?.userId ?? authenticatedUser?.id;

      if (!authenticatedUserId) {
        return res.unauthenticated(
          "Authenticated user information was not found.",
        );
      }

      const access = await getUserAccess(authenticatedUserId);

      if (!access) {
        return res.unauthenticated("User is inactive or no longer available.");
      }

      if (access.company && access.company.isActive === false) {
        return res.unauthorized("Your company is currently inactive.");
      }

      if (holderOnly) {
        const isHolder =
          access.company?.typeCode === "HOLDER" ||
          Number(access.company?.type) === HOLDER_COMPANY_TYPE;

        if (!isHolder) {
          return res.unauthorized(
            "Only holder users are allowed to perform this action.",
          );
        }
      }

      const targetUserUuid = req.params?.[userUuidParam];

      const isSelf =
        allowSelf && targetUserUuid && targetUserUuid === access.user.uuid;

      if (requiredPermissions.length > 0 && !isSelf) {
        const ownedPermissions = new Set(access.permissionCodes);

        const isAllowed = requireAll
          ? requiredPermissions.every((permission) =>
              ownedPermissions.has(permission),
            )
          : requiredPermissions.some((permission) =>
              ownedPermissions.has(permission),
            );

        console.log("AUTHORIZATION CHECK:", {
          userId: authenticatedUserId,
          requiredPermissions,
          ownedPermissions: access.permissionCodes,
        });
        if (!isAllowed) {
          return res.unauthorized(
            "You do not have permission to perform this action.",
            {
              requiredPermissions,
            },
          );
        }
      }

      const existingData = req.getData() || {};

      req.setData({
        ...existingData,
        access,
      });

      return next();
    } catch (err) {
      return next(err);
    }
  };
}

authorization.getUserAccess = getUserAccess;

module.exports = authorization;
