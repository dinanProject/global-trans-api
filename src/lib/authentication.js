"use strict";

const jwt = require("./jwt");

module.exports = function (req, res, next) {
  const token = req.getToken();

  if (!token) {
    return res.noToken();
  }

  try {
    const payload = jwt.verifyAccessToken(token);

    req.setUser(payload);

    return next();
  } catch (err) {
    console.error("Access token verification failed:", err.message);

    return res.invalidToken();
  }
};
