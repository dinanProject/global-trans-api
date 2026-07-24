"use strict";

module.exports = function (req, res, next) {
  req.getToken = function () {
    const authorization = req.headers.authorization;

    if (!authorization) {
      return null;
    }

    const [type, token] = authorization.split(" ");

    if (type !== "Bearer" || !token) {
      return null;
    }

    return token;
  };

  req.getUser = function () {
    return req._user || null;
  };

  req.setUser = function (user) {
    req._user = user;
  };

  req.getData = function () {
    return req._data || null;
  };

  req.setData = function (data) {
    req._data = data;
  };

  req.getIpAddress = function () {
    const forwardedFor = req.headers["x-forwarded-for"];

    if (forwardedFor) {
      return forwardedFor.split(",")[0].trim();
    }

    return req.socket.remoteAddress;
  };

  next();
};
