"use strict";

const express = require("express");
const bcrypt = require("bcrypt");
const crypto = require("crypto");

const route = express.Router();
const db = require("../../lib/db")();
const jwt = require("../../lib/jwt");
const authentication = require("../../lib/authentication");
const tokenHelper = require("../../lib/token");

route
  .post("/login", async (req, res, next) => {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.incomplete("Email and password are required.");
      }

      const user = await db("users")
        .where({
          email,
          isActive: true,
        })
        .whereNull("deletedAt")
        .first();

      if (!user) {
        return res.unauthenticated("Invalid email or password.");
      }

      const isValidPassword = await bcrypt.compare(password, user.password);

      if (!isValidPassword) {
        return res.unauthenticated("Invalid email or password.");
      }

      // Revoke semua refresh token aktif..penting
      await db("refreshTokens")
        .where({
          userId: user.id,
        })
        .whereNull("revokedAt")
        .update({
          revokedAt: new Date(),
        });

      const accessToken = jwt.signAccessToken({
        userId: user.id,
        uuid: user.uuid,
        email: user.email,
      });

      const refreshToken = jwt.signRefreshToken({
        userId: user.id,

        uuid: user.uuid,
      });

      const refreshPayload = jwt.verifyRefreshToken(refreshToken);
      const refreshTokenHash = tokenHelper.hash(refreshToken);
      const refreshTokenExpiresAt = new Date(refreshPayload.exp * 1000);

      await db("refreshTokens").insert({
        uuid: crypto.randomUUID(),
        jti: refreshPayload.jti,
        userId: user.id,
        tokenHash: refreshTokenHash,
        ipAddress: req.ip || null,
        userAgent: req.get("user-agent") || null,
        expiresAt: new Date(refreshPayload.exp * 1000),
      });

      console.log({
        refreshTokenHash,
        refreshTokenExpiresAt,
        jti: refreshPayload.jti,
      });

      delete user.password;

      return res.success({
        accessToken,
        refreshToken,
        user,
      });
    } catch (err) {
      next(err);
    }
  })

  .get("/verify", function (req, res) {
    try {
      const token = req.getToken();

      if (!token) {
        return res.noToken();
      }

      const payload = jwt.verifyAccessToken(token);

      return res.success(payload);
    } catch (err) {
      return res.invalidToken();
    }
  })

  .get("/me", authentication, function (req, res) {
    return res.success(req.getUser());
  })

  .post("/refresh-token", async function (req, res, next) {
    const trx = await db.transaction();

    try {
      const { refreshToken } = req.body;

      if (!refreshToken) {
        await trx.rollback();

        return res.incomplete("Refresh token is required.");
      }

      let payload;

      try {
        payload = jwt.verifyRefreshToken(refreshToken);
      } catch (err) {
        await trx.rollback();

        return res.invalidToken();
      }

      const tokenHash = tokenHelper.hash(refreshToken);

      const storedToken = await trx("refreshTokens")
        .where({
          userId: payload.userId,
          jti: payload.jti,
        })
        .forUpdate()
        .first();

      if (!storedToken) {
        await trx.rollback();

        return res.invalidToken();
      }

      if (storedToken.revokedAt) {
        await trx("refreshTokens")
          .where({
            userId: payload.userId,
          })
          .whereNull("revokedAt")
          .update({
            revokedAt: new Date(),
          });

        await trx.commit();

        return res.invalidToken(
          "Refresh token reuse detected. Please login again.",
        );
      }

      if (storedToken.tokenHash !== tokenHash) {
        await trx.rollback();

        return res.invalidToken();
      }

      if (new Date(storedToken.expiresAt) <= new Date()) {
        await trx.rollback();

        return res.invalidToken();
      }

      const user = await trx("users")
        .where({
          id: payload.userId,
          isActive: true,
        })
        .whereNull("deletedAt")
        .first();

      if (!user) {
        await trx.rollback();

        return res.unauthenticated();
      }

      const accessToken = jwt.signAccessToken({
        userId: user.id,
        uuid: user.uuid,
        email: user.email,
      });

      const newRefreshToken = jwt.signRefreshToken({
        userId: user.id,
        uuid: user.uuid,
      });

      const newRefreshPayload = jwt.verifyRefreshToken(newRefreshToken);

      await trx("refreshTokens")
        .where({
          id: storedToken.id,
        })
        .update({
          revokedAt: new Date(),
        });

      await trx("refreshTokens").insert({
        uuid: crypto.randomUUID(),
        jti: newRefreshPayload.jti,
        userId: user.id,
        tokenHash: tokenHelper.hash(newRefreshToken),
        ipAddress: req.ip || null,
        userAgent: req.get("user-agent") || null,
        expiresAt: new Date(newRefreshPayload.exp * 1000),
      });

      await trx.commit();

      return res.success({
        accessToken,
        refreshToken: newRefreshToken,
      });
    } catch (err) {
      await trx.rollback();

      return next(err);
    }
  })

  .post("/logout", async function (req, res, next) {
    try {
      const { refreshToken } = req.body;

      if (!refreshToken) {
        return res.incomplete("Refresh token is required.");
      }

      let payload;

      try {
        payload = jwt.verifyRefreshToken(refreshToken);
      } catch (err) {
        return res.invalidToken();
      }

      const tokenHash = tokenHelper.hash(refreshToken);

      const affectedRows = await db("refreshTokens")
        .where({
          userId: payload.userId,
          jti: payload.jti,
          tokenHash,
        })
        .whereNull("revokedAt")
        .update({
          revokedAt: new Date(),
        });

      if (!affectedRows) {
        return res.invalidToken();
      }

      return res.success(null, "Logged out successfully.");
    } catch (err) {
      next(err);
    }
  });
module.exports = route;
