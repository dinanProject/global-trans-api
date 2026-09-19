"use strict";

const { enqueueManyEmails } = require("../email/outbox");

const MODULE_CODE = "EQUIPMENT_REQUEST";
const TEMPLATE_CODE = "EQUIPMENT_REQUEST_ENDING_SOON_DIGEST";
const CONTEXT_CODE = "ENDING_SOON_DIGEST";
const GLOBAL_ADMIN_ROLE_CODE = "GLOBAL_ADMIN";
const HOLDER_COMPANY_TYPE = 1;
const ACTIVE_OPERATION_STATUS_CODES = ["ASSIGNED", "IN_OPERATION"];
const DEFAULT_REMINDER_HOURS = 6;
const LOCK_NAME = "equipment_request_ending_reminder_digest";

async function enqueueEndingSoonDigest(trx, options = {}) {
  const reminderHours = normalizeReminderHours(options.reminderHours);
  const lockAcquired = await acquireLock(trx);

  if (!lockAcquired) {
    return {
      skipped: true,
      reason: "LOCK_NOT_ACQUIRED",
      candidateCount: 0,
      queuedRecipientCount: 0,
    };
  }

  try {
    const [recipients, candidates, remindedKeys] = await Promise.all([
      findGlobalAdminRecipients(trx),
      findEndingSoonRequests(trx, reminderHours),
      findRecentlyRemindedKeys(trx, reminderHours),
    ]);

    const freshCandidates = candidates.filter((candidate) => !remindedKeys.has(buildRequestReminderKey(candidate)));

    if (recipients.length === 0 || freshCandidates.length === 0) {
      return {
        skipped: false,
        reason: recipients.length === 0 ? "NO_RECIPIENTS" : "NO_NEW_REQUESTS",
        candidateCount: freshCandidates.length,
        queuedRecipientCount: 0,
      };
    }

    const operationsUrl = buildFrontendUrl("/equipment-request/operations");
    const requestKeys = freshCandidates.map(buildRequestReminderKey);
    const requests = freshCandidates.map((candidate) => ({
      requestId: candidate.id,
      requestUuid: candidate.uuid,
      requestNo: candidate.requestNo,
      companyName: candidate.companyName || "-",
      plannedEndDate: candidate.plannedEndDateText,
      remainingMinutes: Number(candidate.remainingMinutes || 0),
    }));

    await enqueueManyEmails(
      trx,
      recipients.map((recipient) => {
        const payload = buildDigestPayload({
          recipient,
          requests,
          requestKeys,
          reminderHours,
          operationsUrl,
        });

        return {
          templateCode: TEMPLATE_CODE,
          moduleCode: MODULE_CODE,
          referenceId: null,
          referenceUuid: null,
          contextCode: CONTEXT_CODE,
          contextId: null,
          recipientUserId: recipient.id,
          toEmail: recipient.email,
          payload,
          priority: 5,
        };
      }),
      { buildFallbackTemplate },
    );

    return {
      skipped: false,
      reason: "QUEUED",
      candidateCount: freshCandidates.length,
      queuedRecipientCount: recipients.length,
    };
  } finally {
    await releaseLock(trx);
  }
}

async function findEndingSoonRequests(trx, reminderHours) {
  return trx("equipmentRequests as request")
    .join("equipmentRequestStatuses as requestStatus", function () {
      this.on("requestStatus.code", "=", "request.status")
        .andOnVal("requestStatus.isActive", "=", 1)
        .andOnNull("requestStatus.deletedAt");
    })
    .join("equipmentOperations as operation", function () {
      this.on("operation.requestId", "=", "request.id")
        .andOnVal("operation.isActive", "=", 1)
        .andOnNull("operation.deletedAt");
    })
    .leftJoin("companies as company", function () {
      this.on("company.id", "=", "request.companyId").andOnNull("company.deletedAt");
    })
    .where("request.isActive", true)
    .whereNull("request.deletedAt")
    .where("requestStatus.isTerminal", false)
    .whereIn("operation.statusCode", ACTIVE_OPERATION_STATUS_CODES)
    .whereNotNull("operation.plannedEndDate")
    .groupBy([
      "request.id",
      "request.uuid",
      "request.requestNo",
      "request.companyId",
      "company.name",
    ])
    .havingRaw("MAX(operation.plannedEndDate) > NOW()")
    .havingRaw(`MAX(operation.plannedEndDate) <= DATE_ADD(NOW(), INTERVAL ${reminderHours} HOUR)`)
    .select([
      "request.id",
      "request.uuid",
      "request.requestNo",
      "request.companyId",
      "company.name as companyName",
      trx.raw("DATE_FORMAT(MAX(operation.plannedEndDate), '%Y-%m-%d %H:%i:%s') as plannedEndDateText"),
      trx.raw("TIMESTAMPDIFF(MINUTE, NOW(), MAX(operation.plannedEndDate)) as remainingMinutes"),
    ])
    .orderByRaw("MAX(operation.plannedEndDate) ASC");
}

async function findGlobalAdminRecipients(trx) {
  return trx("users as user")
    .join("companies as company", function () {
      this.on("company.id", "=", "user.companyId").andOnNull("company.deletedAt");
    })
    .join("userRoles as userRole", "userRole.userId", "user.id")
    .join("roles as role", "role.id", "userRole.roleId")
    .where("user.isActive", true)
    .whereNull("user.deletedAt")
    .whereNotNull("user.email")
    .where("company.isActive", true)
    .where("company.type", HOLDER_COMPANY_TYPE)
    .where("role.isActive", true)
    .where("role.code", GLOBAL_ADMIN_ROLE_CODE)
    .distinct(["user.id", "user.uuid", "user.fullName", "user.email"]);
}

async function findRecentlyRemindedKeys(trx, reminderHours) {
  const lookbackHours = reminderHours + 2;
  const rows = await trx("emailOutboxes")
    .where("moduleCode", MODULE_CODE)
    .where("contextCode", CONTEXT_CODE)
    .where("isActive", true)
    .whereNull("deletedAt")
    .whereRaw(`createdAt >= DATE_SUB(NOW(), INTERVAL ${lookbackHours} HOUR)`)
    .select(["payload"]);

  const remindedKeys = new Set();

  rows.forEach((row) => {
    const payload = parsePayload(row.payload);
    const keys = Array.isArray(payload?.requestKeys) ? payload.requestKeys : [];
    keys.forEach((key) => {
      if (key) {
        remindedKeys.add(String(key));
      }
    });
  });

  return remindedKeys;
}

function buildDigestPayload({ recipient, requests, requestKeys, reminderHours, operationsUrl }) {
  const rowsHtml = requests
    .map((request) => {
      return `<tr>
        <td style="padding:9px 10px;border-bottom:1px solid #e5e7eb;">${escapeHtml(request.requestNo)}</td>
        <td style="padding:9px 10px;border-bottom:1px solid #e5e7eb;">${escapeHtml(request.companyName)}</td>
        <td style="padding:9px 10px;border-bottom:1px solid #e5e7eb;">${escapeHtml(formatDateTimeText(request.plannedEndDate))}</td>
        <td style="padding:9px 10px;border-bottom:1px solid #e5e7eb;">${escapeHtml(formatRemaining(request.remainingMinutes))}</td>
      </tr>`;
    })
    .join("");

  const rowsText = requests
    .map((request) => {
      return `${request.requestNo} | ${request.companyName} | End: ${formatDateTimeText(request.plannedEndDate)} | Remaining: ${formatRemaining(request.remainingMinutes)}`;
    })
    .join("\n");

  return {
    brandName: process.env.MAIL_COMPANY_NAME || "PT Global Trans Servindo",
    brandLogoUrl: process.env.MAIL_LOGO_URL || "",
    supportEmail: process.env.MAIL_SUPPORT_EMAIL || "support@globaltransgroup.id",
    currentYear: new Date().getFullYear(),
    recipientName: recipient.fullName || "Admin Global",
    reminderHours,
    requestCount: requests.length,
    requestKeys,
    requests,
    rowsHtml,
    rowsText,
    operationsUrl,
  };
}

function buildFallbackTemplate() {
  return {
    subject: "[Reminder] {{requestCount}} equipment request(s) nearing planned end",
    html: `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Equipment Period Reminder</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;color:#1f2937;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="width:100%;background:#f4f6f8;padding:24px 0;">
    <tr>
      <td align="center" style="padding:0 12px;">
        <table width="640" cellpadding="0" cellspacing="0" role="presentation" style="width:640px;max-width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
          <tr>
            <td style="padding:22px 28px;border-bottom:1px solid #eef0f3;background:#ffffff;">
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td align="left" valign="middle">
                    <img src="{{brandLogoUrl}}" alt="{{brandName}}" style="display:block;max-height:42px;max-width:180px;width:auto;height:auto;border:0;">
                  </td>
                  <td align="right" valign="middle" style="font-size:12px;line-height:1.4;color:#6b7280;">
                    Equipment Reservation System
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:28px;">
              <div style="display:inline-block;margin:0 0 16px;padding:6px 11px;border-radius:999px;color:#b45309;background:#fff7ed;border:1px solid #fed7aa;font-size:12px;font-weight:700;line-height:1.2;">Period Reminder</div>
              <h1 style="margin:0 0 10px;font-size:22px;line-height:1.35;color:#111827;">Equipment requests are nearing planned end</h1>
              <p style="margin:0 0 22px;font-size:14px;line-height:1.7;color:#475569;">Halo <strong>{{recipientName}}</strong>, terdapat <strong>{{requestCount}}</strong> request aktif yang akan mencapai planned end dalam {{reminderHours}} jam dan perlu diperiksa.</p>
              <div style="margin:0 0 10px;font-size:13px;font-weight:700;line-height:1.4;color:#334155;">Ending Soon Requests</div>
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="width:100%;border:1px solid #e5e7eb;border-radius:8px;border-collapse:separate;border-spacing:0;overflow:hidden;font-size:12px;line-height:1.45;">
                <thead>
                  <tr>
                    <th align="left" style="padding:10px 12px;background:#f8fafc;border-bottom:1px solid #edf0f3;color:#64748b;font-weight:600;">Request</th>
                    <th align="left" style="padding:10px 12px;background:#f8fafc;border-bottom:1px solid #edf0f3;color:#64748b;font-weight:600;">Company</th>
                    <th align="left" style="padding:10px 12px;background:#f8fafc;border-bottom:1px solid #edf0f3;color:#64748b;font-weight:600;">Planned End</th>
                    <th align="left" style="padding:10px 12px;background:#f8fafc;border-bottom:1px solid #edf0f3;color:#64748b;font-weight:600;">Remaining</th>
                  </tr>
                </thead>
                <tbody>{{rowsHtml}}</tbody>
              </table>
              <table cellpadding="0" cellspacing="0" role="presentation" style="margin:22px 0 0;">
                <tr>
                  <td bgcolor="#4f8fd6" align="center" style="border-radius:8px;text-align:center;">
                    <a href="{{operationsUrl}}" style="display:inline-block;padding:11px 18px;font-size:13px;font-weight:700;line-height:1.2;color:#ffffff;text-decoration:none;min-width:160px;text-align:center;box-sizing:border-box;">Open Operations</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 28px;border-top:1px solid #eef0f3;background:#f8fafc;text-align:center;">
              <div style="font-size:11px;line-height:1.6;color:#94a3b8;">
                This notification was sent automatically by {{brandName}} Equipment Reservation System.<br>
                Need help? <a href="mailto:{{supportEmail}}" style="color:#64748b;text-decoration:none;">{{supportEmail}}</a><br>
                &copy; {{currentYear}} {{brandName}}. All rights reserved.
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
    text: `Equipment Period Reminder

Halo {{recipientName}},

Terdapat {{requestCount}} request aktif yang akan mencapai planned end dalam {{reminderHours}} jam dan perlu diperiksa.

{{rowsText}}

Open Operations:
{{operationsUrl}}

This notification was sent automatically by {{brandName}} Equipment Reservation System.
Need help? {{supportEmail}}

© {{currentYear}} {{brandName}}. All rights reserved.`,
  };
}

function buildRequestReminderKey(request) {
  return `${request.uuid}|${request.plannedEndDateText}`;
}

function parsePayload(value) {
  if (!value) {
    return null;
  }

  if (typeof value === "object") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

function normalizeReminderHours(value) {
  const parsed = Number(value || process.env.EQUIPMENT_ENDING_REMINDER_HOURS || DEFAULT_REMINDER_HOURS);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_REMINDER_HOURS;
  }

  return Math.min(Math.max(Math.floor(parsed), 1), 72);
}

function buildFrontendUrl(path) {
  const baseUrl = (process.env.APP_URL || process.env.FRONTEND_URL || process.env.APP_FRONTEND_URL || "").replace(/\/$/, "");

  if (!path) {
    return baseUrl;
  }

  return baseUrl ? `${baseUrl}${path.startsWith("/") ? path : `/${path}`}` : path;
}

function formatDateTimeText(value) {
  if (!value) {
    return "-";
  }

  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/);

  if (!match) {
    return String(value);
  }

  return `${match[3]}/${match[2]}/${match[1]} ${match[4]}:${match[5]}`;
}

function formatRemaining(totalMinutes) {
  const minutes = Math.max(Number(totalMinutes || 0), 0);
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (hours <= 0) {
    return `${remainingMinutes}m`;
  }

  return `${hours}h ${remainingMinutes}m`;
}

function escapeHtml(value) {
  return String(value ?? "-")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function acquireLock(trx) {
  const result = await trx.raw("SELECT GET_LOCK(?, 0) AS acquired", [LOCK_NAME]);
  const rows = Array.isArray(result) ? result[0] : result;
  return Number(rows?.[0]?.acquired || 0) === 1;
}

async function releaseLock(trx) {
  try {
    await trx.raw("SELECT RELEASE_LOCK(?)", [LOCK_NAME]);
  } catch (error) {
    console.error("[equipment-ending-reminder] Failed to release lock:", error);
  }
}

module.exports = {
  enqueueEndingSoonDigest,
};
