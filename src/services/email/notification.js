"use strict";

const { enqueueManyEmails } = require("./outbox");

async function queueTemplateEmails(trx, messages, options = {}) {
  return enqueueManyEmails(trx, messages, options);
}

module.exports = {
  queueTemplateEmails,
};
