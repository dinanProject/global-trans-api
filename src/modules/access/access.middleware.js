"use strict";

const jwt = require("../../lib/jwt");
const { getAccessContext } = require("./access.service");

const HOLDER_COMPANY_TYPE = 1;

async function authenticate(req, res, next) {
  try {
    const authorization = req.headers.authorization;

    if (!authorization?.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Access token tidak ditemukan",
      });
    }

    const token = authorization.slice(7).trim();
    const payload = jwt.verifyAccessToken(token);

    const userId = payload?.userId ?? payload?.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "Payload token tidak valid",
        code: "INVALID_TOKEN_PAYLOAD",
      });
    }

    const access = await getAccessContext(userId);

    if (!access) {
      return res.status(401).json({
        success: false,
        message: "User tidak aktif atau tidak ditemukan",
        code: "USER_NOT_AVAILABLE",
      });
    }

    req.setUser(payload);
    req.setAccess(access);

    // Compatibility sementara.
    const existingData = req.getData() || {};

    req.setData({
      ...existingData,
      access,
    });

    return next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        message: "Access token sudah kedaluwarsa",
        code: "TOKEN_EXPIRED",
      });
    }

    console.error("Authentication error:", error);

    return res.status(401).json({
      success: false,
      message: "Access token tidak valid",
      code: "INVALID_TOKEN",
    });
  }
}

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

function authorize(
  permissions,
  {
    requireAll = true,
    holderOnly = false,
    allowSelf = false,
    userUuidParam = "userUuid",
  } = {},
) {
  const requiredPermissions = normalizePermissions(permissions);

  return function authorizeRequest(req, res, next) {
    try {
      const access = req.getAccess();

      if (!access) {
        return res.unauthenticated("User access information was not found.");
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

        if (!isAllowed) {
          return res.unauthorized(
            "You do not have permission to perform this action.",
            {
              requiredPermissions,
            },
          );
        }
      }

      return next();
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = {
  authenticate,
  authorize,
};
