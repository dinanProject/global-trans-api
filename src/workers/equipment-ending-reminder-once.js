"use strict";

require("dotenv").config({ quiet: true });

const db = require("../lib/db")();
const { enqueueEndingSoonDigest } = require("../services/equipment-request/ending-reminder");

async function run() {
  const result = await db.transaction(async (trx) => enqueueEndingSoonDigest(trx));

  console.log(
    `[equipment-ending-reminder] ${result.reason} candidates=${result.candidateCount} recipients=${result.queuedRecipientCount}`,
  );
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[equipment-ending-reminder] FAILED", error);
    process.exit(1);
  });
