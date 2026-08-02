"use strict";

const { queueTemplateEmails } = require("../email/notification");

const MODULE_CODE = "EQUIPMENT_REQUEST";
const TEMPLATE_APPROVAL_REQUIRED = "EQUIPMENT_REQUEST_APPROVAL_REQUIRED";
const TEMPLATE_STATUS_CHANGED = "EQUIPMENT_REQUEST_STATUS_CHANGED";
const DEFAULT_FROM_NAME =
  process.env.MAIL_FROM_NAME || "Global Trans Reservation";

async function enqueueRequestActionNotifications(
  trx,
  { equipmentRequest, transition, actionUserId, remarks },
) {
  const requestContext = await findRequestContext(trx, equipmentRequest.id);

  if (!requestContext) {
    return;
  }

  const actionUser = actionUserId
    ? await findUserById(trx, actionUserId)
    : null;

  const currentRequest = {
    ...requestContext,
    status: transition.toStatusCode,
    statusName: transition.toStatusName || transition.toStatusCode,
  };

  const actionCode = transition.actionCode;

  /*
   * SUBMIT:
   * kirim ke client approver.
   *
   * APPROVE_CLIENT:
   * kirim ke GTSI approver.
   */
  if (actionCode === "SUBMIT" || actionCode === "APPROVE_CLIENT") {
    const nextApprovers = await findNextApproverRecipients(
      trx,
      equipmentRequest.id,
    );

    if (nextApprovers.length > 0) {
      await queueTemplateEmails(
        trx,
        nextApprovers.map((recipient) => ({
          templateCode: TEMPLATE_APPROVAL_REQUIRED,
          moduleCode: MODULE_CODE,
          referenceId: equipmentRequest.id,
          referenceUuid: equipmentRequest.uuid,
          contextCode: `APPROVAL_REQUIRED_${actionCode}`,
          contextId: equipmentRequest.id,
          recipientUserId: recipient.id,
          toEmail: recipient.email,
          payload: buildPayload({
            request: currentRequest,
            recipient,
            actionUser,
            transition,
            remarks,
          }),
          fromName: buildFromName(actionUser),
        })),
        { buildFallbackTemplate },
      );
    }
  }

  /*
   * Requester menerima hasil perubahan status,
   * kecuali saat SUBMIT.
   */
  if (
    ["APPROVE_CLIENT", "REJECT_CLIENT", "APPROVE_GTSI", "REJECT_GTSI"].includes(
      actionCode,
    )
  ) {
    const requester = await findUserById(trx, equipmentRequest.requestBy);

    if (requester?.email) {
      await queueTemplateEmails(
        trx,
        [
          {
            templateCode: TEMPLATE_STATUS_CHANGED,
            moduleCode: MODULE_CODE,
            referenceId: equipmentRequest.id,
            referenceUuid: equipmentRequest.uuid,
            contextCode: `REQUESTER_${actionCode}`,
            contextId: equipmentRequest.id,
            recipientUserId: requester.id,
            toEmail: requester.email,
            payload: buildPayload({
              request: currentRequest,
              recipient: requester,
              actionUser,
              transition,
              remarks,
            }),
            fromName: buildFromName(actionUser),
          },
        ],
        { buildFallbackTemplate },
      );
    }
  }

  /*
   * Setelah keputusan GTSI,
   * client approver juga menerima hasil akhir.
   */
  if (actionCode === "APPROVE_GTSI" || actionCode === "REJECT_GTSI") {
    const clientApprovers = await findClientApproverRecipients(
      trx,
      equipmentRequest.id,
    );

    if (clientApprovers.length > 0) {
      await queueTemplateEmails(
        trx,
        clientApprovers.map((recipient) => ({
          templateCode: TEMPLATE_STATUS_CHANGED,
          moduleCode: MODULE_CODE,
          referenceId: equipmentRequest.id,
          referenceUuid: equipmentRequest.uuid,
          contextCode: `CLIENT_APPROVER_${actionCode}`,
          contextId: equipmentRequest.id,
          recipientUserId: recipient.id,
          toEmail: recipient.email,
          payload: buildPayload({
            request: currentRequest,
            recipient,
            actionUser,
            transition,
            remarks,
          }),
          fromName: buildFromName(actionUser),
        })),
        { buildFallbackTemplate },
      );
    }
  }
}

async function findRequestContext(trx, requestId) {
  const request = await trx("equipmentRequests as request")
    .leftJoin("companies as company", "company.id", "request.companyId")
    .leftJoin("divisions as division", "division.id", "request.divisionId")
    .leftJoin("users as requester", "requester.id", "request.requestBy")
    .leftJoin("equipmentRequestStatuses as status", function () {
      this.on("status.code", "=", "request.status")
        .andOnVal("status.isActive", "=", 1)
        .andOnNull("status.deletedAt");
    })
    .where("request.id", requestId)
    .whereNull("request.deletedAt")
    .first([
      "request.id",
      "request.uuid",
      "request.requestNo",
      "request.companyId",
      "company.code as companyCode",
      "company.name as companyName",
      "request.divisionId",
      "division.code as divisionCode",
      "division.name as divisionName",
      "request.requestBy",
      "requester.fullName as requesterName",
      "requester.email as requesterEmail",
      "request.requestDate",
      "request.startDate",
      "request.endDate",
      "request.purpose",
      "request.notes",
      "request.status",
      "status.name as statusName",
      "request.currentApprovalLevel",
    ]);

  if (!request) {
    return null;
  }

  const details = await trx("equipmentRequestDetails as detail")
    .leftJoin(
      "equipmentCategories as category",
      "category.id",
      "detail.equipmentCategoryId",
    )
    .leftJoin("equipmentUnits as unit", "unit.id", "detail.equipmentUnitId")
    .where("detail.requestId", request.id)
    .where("detail.isActive", true)
    .whereNull("detail.deletedAt")
    .select([
      "detail.quantity",
      "detail.rate",
      "detail.remarks",
      "category.code as categoryCode",
      "category.name as categoryName",
      "unit.unitCode",
      "unit.unitName",
    ]);

  return {
    ...request,
    details,
  };
}

async function findNextApproverRecipients(trx, requestId) {
  const nextApproval = await trx("equipmentRequestApprovals")
    .where("requestId", requestId)
    .where("status", "PENDING")
    .where("isActive", true)
    .whereNull("deletedAt")
    .orderBy("approvalLevel", "asc")
    .first(["approvalLevel"]);

  if (!nextApproval) {
    return [];
  }

  const approvalRows = await trx("equipmentRequestApprovals")
    .where("requestId", requestId)
    .where("approvalLevel", nextApproval.approvalLevel)
    .where("status", "PENDING")
    .where("isActive", true)
    .whereNull("deletedAt")
    .select(["companyId", "roleId"]);

  if (approvalRows.length === 0) {
    return [];
  }

  const recipientQuery = trx("users as user")
    .join("userRoles as userRole", function () {
      this.on("userRole.userId", "=", "user.id");
    })
    .where("user.isActive", true)
    .whereNull("user.deletedAt")
    .whereNotNull("user.email")
    .where((builder) => {
      approvalRows.forEach((approval) => {
        builder.orWhere((rowBuilder) => {
          rowBuilder
            .where("user.companyId", approval.companyId)
            .where("userRole.roleId", approval.roleId);
        });
      });
    })
    .distinct([
      "user.id",
      "user.uuid",
      "user.fullName",
      "user.email",
      "user.companyId",
    ]);

  return recipientQuery;
}

async function findClientApproverRecipients(trx, requestId) {
  const clientApproval = await trx("equipmentRequestApprovals")
    .where("requestId", requestId)
    .where("approvalLevel", 1)
    .where("isActive", true)
    .whereNull("deletedAt")
    .first(["companyId", "roleId"]);

  if (!clientApproval) {
    return [];
  }

  return trx("users as user")
    .join("userRoles as userRole", "userRole.userId", "user.id")
    .where("user.companyId", clientApproval.companyId)
    .where("userRole.roleId", clientApproval.roleId)
    .where("user.isActive", true)
    .whereNull("user.deletedAt")
    .whereNotNull("user.email")
    .distinct([
      "user.id",
      "user.uuid",
      "user.fullName",
      "user.email",
      "user.companyId",
    ]);
}

async function findUserById(trx, userId) {
  if (!userId) {
    return null;
  }

  return trx("users")
    .where("id", userId)
    .whereNull("deletedAt")
    .first(["id", "uuid", "fullName", "email", "companyId"]);
}

function buildPayload({ request, recipient, actionUser, transition, remarks }) {
  const detailsText = buildDetailsText(request.details || []);

  return enrichPayload({
    recipientName: recipient?.fullName || "User",
    recipientEmail: recipient?.email || null,
    requestNo: request.requestNo,
    requestUuid: request.uuid,
    companyName: request.companyName || "-",
    divisionName: request.divisionName || "-",
    requesterName: request.requesterName || "-",
    requesterEmail: request.requesterEmail || null,
    actorName: actionUser?.fullName || "System",
    actorEmail: actionUser?.email || null,
    statusCode: request.status,
    statusName: request.statusName || request.status,
    actionCode: transition.actionCode,
    actionName: transition.actionName || transition.actionCode,
    fromStatusCode: transition.fromStatusCode,
    toStatusCode: transition.toStatusCode,
    remarks: remarks || "-",
    startDate: formatDateOnly(request.startDate),
    endDate: formatDateOnly(request.endDate),
    purpose: request.purpose || "-",
    notes: request.notes || "-",
    detailsText,
    detailsHtml: detailsText.replace(/\n/g, "<br>"),
    approvalUrl: buildFrontendUrl("/main/equipment-request/approvals"),
    requestUrl: buildFrontendUrl("/main/equipment-request/requests"),
  });
}

function buildFrontendUrl(path) {
  const baseUrl = (
    process.env.APP_URL ||
    process.env.FRONTEND_URL ||
    process.env.APP_FRONTEND_URL ||
    ""
  ).replace(/\/$/, "");

  if (!path) return baseUrl;
  if (/^https?:\/\//i.test(path)) return path;

  return baseUrl
    ? `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`
    : path;
}

function enrichPayload(rawPayload = {}) {
  return {
    brandName: process.env.MAIL_COMPANY_NAME || "PT Global Trans Servindo",
    brandLogoUrl: process.env.MAIL_LOGO_URL || "",
    supportEmail:
      process.env.MAIL_SUPPORT_EMAIL || "support@globaltransgroup.id",
    currentYear: new Date().getFullYear(),

    ...rawPayload,

    approvalUrl: buildFrontendUrl("/main/equipment-request/approvals"),
    requestUrl: buildFrontendUrl("/main/equipment-request/requests"),
  };
}

function buildDetailsText(details) {
  if (!details.length) {
    return "-";
  }

  return details
    .map((detail, index) => {
      const name = detail.categoryName || detail.unitName || "Equipment";
      const unit = detail.unitName ? ` - ${detail.unitName}` : "";
      const quantity = detail.quantity ? ` x ${detail.quantity}` : "";

      return `${index + 1}. ${name}${unit}${quantity}`;
    })
    .join("\n");
}

function buildFromName(actionUser) {
  if (!actionUser?.fullName) {
    return DEFAULT_FROM_NAME;
  }

  return `${actionUser.fullName} via Global Trans`;
}

function buildFallbackTemplate(templateCode, payload) {
  if (templateCode === TEMPLATE_APPROVAL_REQUIRED) {
    return {
      subject: `Approval required: ${payload.requestNo}`,
      html: `<!doctype html><html><body><p>Halo {{recipientName}},</p><p>Equipment request <strong>{{requestNo}}</strong> dari {{companyName}} menunggu approval Anda.</p><p>Status saat ini: <strong>{{statusCode}}</strong></p><p>Periode: {{startDate}} sampai {{endDate}}</p><p>Detail:<br>{{detailsHtml}}</p><p><a href="{{approvalUrl}}">Buka halaman approval</a></p></body></html>`,
      text: `Halo {{recipientName}}, equipment request {{requestNo}} dari {{companyName}} menunggu approval Anda. Status: {{statusCode}}. Periode: {{startDate}} sampai {{endDate}}. Buka: {{approvalUrl}}`,
    };
  }

  return {
    subject: `Equipment request updated: ${payload.requestNo}`,
    html: `<!doctype html><html><body><p>Halo {{recipientName}},</p><p>Status equipment request <strong>{{requestNo}}</strong> berubah menjadi <strong>{{statusCode}}</strong>.</p><p>Action: {{actionName}}</p><p><a href="{{requestUrl}}">Buka halaman request</a></p></body></html>`,
    text: `Halo {{recipientName}}, status equipment request {{requestNo}} berubah menjadi {{statusCode}}. Action: {{actionName}}. Buka: {{requestUrl}}`,
  };
}

function formatDateOnly(value) {
  if (!value) {
    return "-";
  }

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  return String(value).slice(0, 10);
}

module.exports = {
  enqueueRequestActionNotifications,
};
