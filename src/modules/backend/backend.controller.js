"use strict";

const backendService = require("./backend.service");

async function getBootstrap(req, res, next) {
  try {
    const authUser = req.getUser();

    const data = await backendService.getBootstrap(authUser);

    return res.success(data);
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getBootstrap,
};
