"use strict";

const userSessionService = require("./user-session.service");

async function getUserSession(req, res, next) {
  try {
    const authUser = req.getUser();

    const data = await userSessionService.getUserSession(authUser);

    return res.success(data);
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getUserSession,
};
