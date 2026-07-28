"use strict";

const jwt = require("./jwt");
const { getUserAccess } = require("./user-access");

module.exports = async function authentication(req, res, next) {
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

    const access = await getUserAccess(userId);

    if (!access) {
      return res.status(401).json({
        success: false,
        message: "User tidak aktif atau tidak ditemukan",
        code: "USER_NOT_AVAILABLE",
      });
    }

    req.setUser(payload);

    req.setData({
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
};
