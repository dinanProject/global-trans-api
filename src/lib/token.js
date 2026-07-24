"use strict";

const crypto = require("crypto");

function hash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

module.exports = {
  hash,
};
