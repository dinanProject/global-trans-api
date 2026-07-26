"use strict";

const jwt = require("./jwt");

module.exports = function authentication(req, res, next) {
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

    req.setUser(payload);

    return next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        message: "Access token sudah kedaluwarsa",
        code: "TOKEN_EXPIRED",
      });
    }

    return res.status(401).json({
      success: false,
      message: "Access token tidak valid",
      code: "INVALID_TOKEN",
    });
  }
};
