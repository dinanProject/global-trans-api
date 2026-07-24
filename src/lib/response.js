"use strict";

module.exports = function (req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  );
  res.header(
    "Access-Control-Allow-Headers",
    "Authorization, Origin, X-Requested-With, Content-Type, Accept, Api-Key",
  );
  res.header("X-Frame-Options", "DENY");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  res.success = function (data = {}, message = "OK", statusCode = 200) {
    return sendResponse.call(this, statusCode, message, data);
  };

  res.fail = function (message = "Bad Request", data = {}) {
    return sendResponse.call(this, 400, message, data);
  };

  res.noData = function () {
    return sendResponse.call(this, 204, "No Content", null);
  };

  res.noToken = function () {
    return sendResponse.call(this, 401, "Token not found", null);
  };

  res.unauthenticated = function (message = "Unauthenticated", data = null) {
    return sendResponse.call(this, 401, message, data);
  };

  res.unauthorized = function (
    message = "Insufficient access right",
    data = null,
  ) {
    return sendResponse.call(this, 403, message, data);
  };

  res.invalidToken = function (message = "Invalid token", data = null) {
    return sendResponse.call(this, 401, message, data);
  };
  res.incomplete = function (message = "Unprocessable Entity", data = null) {
    return sendResponse.call(this, 422, message, data);
  };

  res.err = function (
    statusCode = 500,
    message = "Internal Server Error",
    data = null,
  ) {
    return sendResponse.call(this, statusCode, message, data);
  };

  next();
};

function sendResponse(statusCode, message, data) {
  let dataType = typeof data;

  if (Array.isArray(data)) {
    dataType = "array";
  }

  if (data === null) {
    dataType = "null";
  }

  return this.status(statusCode).json({
    meta: {
      timestamp: Date.now(),
      message,
    },
    dataType,
    data,
  });
}
