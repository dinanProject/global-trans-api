"use strict";

const express = require("express");
const bcrypt = require("bcrypt");
const crypto = require("crypto");

const route = express.Router();
const db = require("../../lib/db")();
const jwt = require("../../lib/jwt");
const authentication = require("../../lib/authentication");
const tokenHelper = require("../../lib/token");
const { getUserAccess } = require("../../lib/user-access");
const { getUserMenus } = require("../../lib/user-menu");
const {
  LOGIN_STATUS,
  LOGIN_FAILURE_REASON,
  createLoginLogSafely,
} = require("../log/login-log");

route
  // .post("/login", async (req, res, next) => {
  //   try {
  //     const { email, password } = req.body;

  //     if (!email || !password) {
  //       return res.incomplete("Email and password are required.");
  //     }

  //     const user = await db("users")
  //       .where({
  //         email,
  //         isActive: true,
  //       })
  //       .whereNull("deletedAt")
  //       .first();

  //     if (!user) {
  //       return res.unauthenticated("Invalid email or password.");
  //     }

  //     const isValidPassword = await bcrypt.compare(password, user.password);

  //     if (!isValidPassword) {
  //       return res.unauthenticated("Invalid email or password.");
  //     }

  //     await db("refreshTokens")
  //       .where({
  //         userId: user.id,
  //       })
  //       .whereNull("revokedAt")
  //       .update({
  //         revokedAt: new Date(),
  //       });

  //     const accessToken = jwt.signAccessToken({
  //       userId: user.id,
  //       uuid: user.uuid,
  //       email: user.email,
  //     });

  //     const refreshToken = jwt.signRefreshToken({
  //       userId: user.id,
  //       uuid: user.uuid,
  //     });

  //     const refreshPayload = jwt.verifyRefreshToken(refreshToken);

  //     await db("refreshTokens").insert({
  //       uuid: crypto.randomUUID(),
  //       jti: refreshPayload.jti,
  //       userId: user.id,
  //       tokenHash: tokenHelper.hash(refreshToken),
  //       ipAddress: req.ip || null,
  //       userAgent: req.get("user-agent") || null,
  //       expiresAt: new Date(refreshPayload.exp * 1000),
  //     });

  //     await db("users").where("id", user.id).update({
  //       lastLoginAt: new Date(),
  //       updatedAt: new Date(),
  //     });

  //     const access = await getUserAccess(user.id);
  //     const menus = await getUserMenus(user.id);

  //     if (!access) {
  //       return res.unauthenticated(
  //         "User access information could not be loaded.",
  //       );
  //     }

  //     return res.success({
  //       accessToken,
  //       refreshToken,

  //       user: access.user,
  //       company: access.company,
  //       division: access.division,

  //       roles: access.roles,
  //       permissions: access.permissions,
  //       roleCodes: access.roleCodes,
  //       permissionCodes: access.permissionCodes,

  //       menus,
  //     });
  //   } catch (err) {
  //     next(err);
  //   }
  // })

  .post("/login", async (req, res, next) => {
    let email = null;
    let user = null;
    let loginLogWritten = false;

    const ipAddress = req.ip || null;
    const userAgent = req.get("user-agent") || null;

    const writeFailedLogin = async ({
      userId = null,
      failureReason,
      failureMessage,
    }) => {
      if (loginLogWritten) {
        return;
      }

      loginLogWritten = true;

      await createLoginLogSafely({
        userId,
        email,
        statusCode: LOGIN_STATUS.FAILED,
        failureReason,
        failureMessage,
        ipAddress,
        userAgent,
        siteId: 1,
      });
    };

    try {
      const bodyEmail = req.body?.email;
      const password = req.body?.password;

      email = typeof bodyEmail === "string" ? bodyEmail.trim() : bodyEmail;

      if (!email || !password) {
        await writeFailedLogin({
          failureReason: LOGIN_FAILURE_REASON.MISSING_CREDENTIALS,
          failureMessage: "Email and password are required.",
        });

        return res.incomplete("Email and password are required.");
      }

      // Query lama tetap dipertahankan.
      user = await db("users")
        .where({
          email,
          isActive: true,
        })
        .whereNull("deletedAt")
        .first();

      if (!user) {
        await writeFailedLogin({
          failureReason: LOGIN_FAILURE_REASON.INVALID_CREDENTIALS,
          failureMessage: "Invalid email or inactive user.",
        });

        return res.unauthenticated("Invalid email or password.");
      }

      const isValidPassword = await bcrypt.compare(password, user.password);

      if (!isValidPassword) {
        await writeFailedLogin({
          userId: user.id,
          failureReason: LOGIN_FAILURE_REASON.INVALID_PASSWORD,
          failureMessage: "Password verification failed.",
        });

        return res.unauthenticated("Invalid email or password.");
      }

      // Seluruh proses lama di bawah ini tetap pada urutan semula.
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

      await db("refreshTokens").insert({
        uuid: crypto.randomUUID(),
        jti: refreshPayload.jti,
        userId: user.id,
        tokenHash: tokenHelper.hash(refreshToken),
        ipAddress,
        userAgent,
        expiresAt: new Date(refreshPayload.exp * 1000),
      });

      await db("users").where("id", user.id).update({
        lastLoginAt: new Date(),
        updatedAt: new Date(),
      });

      const access = await getUserAccess(user.id);
      const menus = await getUserMenus(user.id);

      if (!access) {
        await writeFailedLogin({
          userId: user.id,
          failureReason: LOGIN_FAILURE_REASON.ACCESS_LOAD_FAILED,
          failureMessage: "User access information could not be loaded.",
        });

        return res.unauthenticated(
          "User access information could not be loaded.",
        );
      }

      await createLoginLogSafely({
        userId: user.id,
        email: user.email,
        statusCode: LOGIN_STATUS.SUCCESS,
        failureReason: null,
        failureMessage: null,
        ipAddress,
        userAgent,
        siteId: 1,
      });

      loginLogWritten = true;

      return res.success({
        accessToken,
        refreshToken,

        user: access.user,
        company: access.company,
        division: access.division,

        roles: access.roles,
        permissions: access.permissions,
        roleCodes: access.roleCodes,
        permissionCodes: access.permissionCodes,

        menus,
      });
    } catch (err) {
      if (!loginLogWritten) {
        await writeFailedLogin({
          userId: user?.id ?? null,
          failureReason: LOGIN_FAILURE_REASON.INTERNAL_ERROR,
          failureMessage:
            err instanceof Error ? err.message : "Unexpected login error.",
        });
      }

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

  .get("/me", authentication, async function (req, res, next) {
    try {
      const authenticatedUser = req.getUser();

      const userId = authenticatedUser?.userId ?? authenticatedUser?.id;

      if (!userId) {
        return res.unauthenticated();
      }

      const access = await getUserAccess(userId);
      const menus = await getUserMenus(userId);

      if (!access) {
        return res.unauthenticated("User is inactive or no longer available.");
      }

      return res.success({
        user: access.user,
        company: access.company,
        division: access.division,

        roles: access.roles,
        permissions: access.permissions,
        roleCodes: access.roleCodes,
        permissionCodes: access.permissionCodes,

        menus,
      });
    } catch (err) {
      next(err);
    }
  })

  .put("/change-password", authentication, async function (req, res, next) {
    const trx = await db.transaction();

    try {
      const authenticatedUser = req.getUser();

      const userId = authenticatedUser?.userId ?? authenticatedUser?.id;

      if (!userId) {
        await trx.rollback();

        return res.unauthenticated();
      }

      const currentPassword =
        typeof req.body?.currentPassword === "string"
          ? req.body.currentPassword
          : "";

      const newPassword =
        typeof req.body?.newPassword === "string" ? req.body.newPassword : "";

      const confirmPassword =
        typeof req.body?.confirmPassword === "string"
          ? req.body.confirmPassword
          : "";

      if (!currentPassword || !newPassword || !confirmPassword) {
        await trx.rollback();

        return res.incomplete(
          "Current password, new password, and confirmation are required.",
        );
      }

      if (newPassword.length < 8 || newPassword.length > 100) {
        await trx.rollback();

        return res.incomplete("New password must contain 8 to 100 characters.");
      }

      if (newPassword !== confirmPassword) {
        await trx.rollback();

        return res.incomplete("New password confirmation does not match.");
      }

      const user = await trx("users")
        .where({
          id: userId,
          isActive: true,
        })
        .whereNull("deletedAt")
        .forUpdate()
        .first(["id", "uuid", "email", "password"]);

      if (!user) {
        await trx.rollback();

        return res.unauthenticated("User is inactive or no longer available.");
      }

      const currentPasswordValid = await bcrypt.compare(
        currentPassword,
        user.password,
      );

      if (!currentPasswordValid) {
        await trx.rollback();

        return res.incomplete("Current password is incorrect.");
      }

      const sameAsCurrentPassword = await bcrypt.compare(
        newPassword,
        user.password,
      );

      if (sameAsCurrentPassword) {
        await trx.rollback();

        return res.incomplete(
          "New password must be different from the current password.",
        );
      }

      await trx("users")
        .where("id", user.id)
        .update({
          password: await bcrypt.hash(newPassword, 12),
          updatedAt: new Date(),
        });

      await trx("refreshTokens")
        .where("userId", user.id)
        .whereNull("revokedAt")
        .update({
          revokedAt: new Date(),
        });

      await trx.commit();

      return res.success(
        null,
        "Password changed successfully. Please login again.",
      );
    } catch (err) {
      await trx.rollback();
      next(err);
    }
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
