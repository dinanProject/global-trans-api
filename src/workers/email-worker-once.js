"use strict";

require("dotenv").config();

const { runEmailWorkerOnce } = require("./email-worker");

runEmailWorkerOnce()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
