const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");

const privateKeyPath = path.resolve(
  process.env.JWT_PRIVATE_KEY_PATH || "./keys/jwt-private.pem",
);

const publicKeyPath = path.resolve(
  process.env.JWT_PUBLIC_KEY_PATH || "./keys/jwt-public.pem",
);

const privateKey = fs.readFileSync(privateKeyPath, "utf8");
const publicKey = fs.readFileSync(publicKeyPath, "utf8");

function signAccessToken(payload) {
  return jwt.sign(payload, privateKey, {
    algorithm: "RS256",
    expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "15m",
    issuer: "global-trans-api",
    audience: "global-trans-app",
  });
}

function verifyAccessToken(token) {
  return jwt.verify(token, publicKey, {
    algorithms: ["RS256"],
    issuer: "global-trans-api",
    audience: "global-trans-app",
  });
}

function signRefreshToken(payload) {
  return jwt.sign(payload, privateKey, {
    algorithm: "RS256",
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d",
    issuer: "global-trans-api",
    audience: "global-trans-refresh",
  });
}

function verifyRefreshToken(token) {
  return jwt.verify(token, publicKey, {
    algorithms: ["RS256"],
    issuer: "global-trans-api",
    audience: "global-trans-refresh",
  });
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  signRefreshToken,
  verifyRefreshToken,
};
