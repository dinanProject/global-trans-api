"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const jsonwebtoken = require("jsonwebtoken");

const privateKeyPath =
  process.env.JWT_PRIVATE_KEY_PATH || "./keys/jwt-private.pem";

const publicKeyPath =
  process.env.JWT_PUBLIC_KEY_PATH || "./keys/jwt-public.pem";

const privateKey = fs.readFileSync(
  path.resolve(process.cwd(), privateKeyPath),
  "utf8",
);

const publicKey = fs.readFileSync(
  path.resolve(process.cwd(), publicKeyPath),
  "utf8",
);

function signAccessToken(payload) {
  return jsonwebtoken.sign(payload, privateKey, {
    algorithm: "RS256",
    expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "15m",
    subject: "accessToken",
  });
}

function signRefreshToken(payload) {
  return jsonwebtoken.sign(payload, privateKey, {
    algorithm: "RS256",
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d",
    subject: "refreshToken",
    jwtid: crypto.randomUUID(),
  });
}

function verifyAccessToken(token) {
  return jsonwebtoken.verify(token, publicKey, {
    algorithms: ["RS256"],
    subject: "accessToken",
  });
}

function verifyRefreshToken(token) {
  return jsonwebtoken.verify(token, publicKey, {
    algorithms: ["RS256"],
    subject: "refreshToken",
  });
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
};
