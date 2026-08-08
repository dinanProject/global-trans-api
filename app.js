"use strict";

require("dotenv").config();

const express = require("express");
const path = require("path");

const request = require("./src/lib/request");
const response = require("./src/lib/response");
const routes = require("./src/routes/routes");

const app = express();
const port = Number(process.env.PORT || 3000);

// TEMP PERFORMANCE INSTRUMENTATION

app.use((req, res, next) => {
  const startedAt = Date.now();

  res.on("finish", () => {
    const duration = Date.now() - startedAt;

    console.log(
      `[HTTP] ${req.method} ${req.originalUrl} ${res.statusCode} ${duration} ms`,
    );
  });

  next();
});

app.enable("trust proxy");

app.enable("trust proxy");

app.use(request);
app.use(response);

app.use(express.json({ limit: "10mb" }));
app.use(
  express.urlencoded({
    limit: "10mb",
    extended: true,
  }),
);

app.use("/public", express.static(path.join(__dirname, "public")));

app.use("/api/v1", routes);

app.use(function (req, res) {
  return res.err(404, "Route not found");
});

app.use(function (err, req, res, next) {
  console.error(err);

  if (res.headersSent) {
    return next(err);
  }

  return res.err(err.statusCode || 500, err.message || "Internal Server Error");
});

app.listen(port, function () {
  console.log(`Global Trans API running on port ${port}`);
});

module.exports = app;
