"use strict";

const { queueTemplateEmails } = require("../email/notification");

const MODULE_CODE = "EQUIPMENT_REQUEST";
const TEMPLATE_APPROVAL_REQUIRED = "EQUIPMENT_REQUEST_APPROVAL_REQUIRED";
const TEMPLATE_STATUS_CHANGED = "EQUIPMENT_REQUEST_STATUS_CHANGED";
const TEMPLATE_ASSIGNED = "EQUIPMENT_REQUEST_ASSIGNED";
const TEMPLATE_OPERATION_STARTED = "EQUIPMENT_OPERATION_STARTED";
const TEMPLATE_OPERATION_COMPLETED = "EQUIPMENT_OPERATION_COMPLETED";

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

async function enqueueAssignmentNotifications(
  trx,
  { requestId, actionUserId, previousStatusCode = "APPROVED" },
) {
  const requestContext = await findRequestContext(trx, requestId);

  if (!requestContext) {
    return;
  }

  const requester = await findUserById(trx, requestContext.requestBy);

  if (!requester?.email) {
    return;
  }

  const actionUser = actionUserId
    ? await findUserById(trx, actionUserId)
    : null;

  const assignments = await findAssignmentNotificationDetails(trx, requestId);

  if (assignments.length === 0) {
    return;
  }

  const assignmentDetailsText = buildAssignmentDetailsText(assignments);

  const payload = enrichPayload({
    recipientName: requester.fullName || "User",
    recipientEmail: requester.email,
    requestNo: requestContext.requestNo,
    requestUuid: requestContext.uuid,
    companyName: requestContext.companyName || "-",
    divisionName: requestContext.divisionName || "-",
    requesterName: requestContext.requesterName || "-",
    requesterEmail: requestContext.requesterEmail || null,
    actorName: actionUser?.fullName || "System",
    actorEmail: actionUser?.email || null,
    statusCode: "ASSIGNED",
    statusName: "Assigned",
    actionCode: "ASSIGN",
    actionName: "Assign Equipment",
    fromStatusCode: previousStatusCode,
    toStatusCode: "ASSIGNED",
    remarks: "-",
    startDate: formatDateOnly(requestContext.startDate),
    endDate: formatDateOnly(requestContext.endDate),
    purpose: requestContext.purpose || "-",
    notes: requestContext.notes || "-",
    assignmentCount: assignments.length,
    assignmentDetailsText,
    assignmentDetailsHtml: escapeHtml(assignmentDetailsText).replace(
      /\n/g,
      "<br>",
    ),
    requestUrl: buildFrontendUrl("/main/equipment-request/assignments"),
  });

  await queueTemplateEmails(
    trx,
    [
      {
        templateCode: TEMPLATE_ASSIGNED,
        moduleCode: MODULE_CODE,
        referenceId: requestContext.id,
        referenceUuid: requestContext.uuid,
        contextCode: "REQUESTER_ASSIGN",
        contextId: requestContext.id,
        recipientUserId: requester.id,
        toEmail: requester.email,
        payload,
        fromName: buildFromName(actionUser),
      },
    ],
    { buildFallbackTemplate },
  );
}

async function enqueueOperationStartedNotifications(
  trx,
  { requestId, actionUserId, previousStatusCode = "ASSIGNED" },
) {
  const requestContext = await findRequestContext(trx, requestId);

  if (!requestContext) {
    return;
  }

  const requester = await findUserById(trx, requestContext.requestBy);

  if (!requester?.email) {
    return;
  }

  const actionUser = actionUserId
    ? await findUserById(trx, actionUserId)
    : null;

  const assignments = await findAssignmentNotificationDetails(trx, requestId);

  const startedAssignments = assignments.filter(
    (assignment) =>
      assignment.statusCode === "IN_OPERATION" && assignment.actualStartDate,
  );

  if (startedAssignments.length === 0) {
    return;
  }

  const operationDetailsText =
    buildOperationStartedDetailsText(startedAssignments);

  const payload = enrichPayload({
    recipientName: requester.fullName || "User",
    recipientEmail: requester.email,

    requestNo: requestContext.requestNo,
    requestUuid: requestContext.uuid,

    companyName: requestContext.companyName || "-",
    divisionName: requestContext.divisionName || "-",

    requesterName: requestContext.requesterName || "-",
    requesterEmail: requestContext.requesterEmail || null,

    actorName: actionUser?.fullName || "System",
    actorEmail: actionUser?.email || null,

    statusCode: "IN_PROGRESS",
    statusName: "In Progress",

    actionCode: "START_OPERATION",
    actionName: "Start Operation",

    fromStatusCode: previousStatusCode,
    toStatusCode: "IN_PROGRESS",

    remarks: "-",

    startDate: formatDateOnly(requestContext.startDate),
    endDate: formatDateOnly(requestContext.endDate),

    operationCount: startedAssignments.length,
    operationDetailsText,
    operationDetailsHtml: escapeHtml(operationDetailsText).replace(
      /\n/g,
      "<br>",
    ),

    requestUrl: buildFrontendUrl("/main/equipment-request/assignments"),
  });

  await queueTemplateEmails(
    trx,
    [
      {
        templateCode: TEMPLATE_OPERATION_STARTED,
        moduleCode: MODULE_CODE,
        referenceId: requestContext.id,
        referenceUuid: requestContext.uuid,
        contextCode: "REQUESTER_START_OPERATION",
        contextId: requestContext.id,
        recipientUserId: requester.id,
        toEmail: requester.email,
        payload,
        fromName: buildFromName(actionUser),
      },
    ],
    { buildFallbackTemplate },
  );
}

async function enqueueOperationCompletedNotifications(
  trx,
  { requestId, actionUserId, previousStatusCode = "IN_PROGRESS" },
) {
  const requestContext = await findRequestContext(trx, requestId);

  if (!requestContext) {
    return;
  }

  const requester = await findUserById(trx, requestContext.requestBy);

  if (!requester?.email) {
    return;
  }

  const actionUser = actionUserId
    ? await findUserById(trx, actionUserId)
    : null;

  const assignments = await findAssignmentNotificationDetails(trx, requestId);

  const completedAssignments = assignments.filter(
    (assignment) =>
      assignment.statusCode === "COMPLETED" && assignment.actualEndDate,
  );

  if (completedAssignments.length === 0) {
    return;
  }

  const completionDetailsText =
    buildOperationCompletedDetailsText(completedAssignments);

  const payload = enrichPayload({
    recipientName: requester.fullName || "User",
    recipientEmail: requester.email,

    requestNo: requestContext.requestNo,
    requestUuid: requestContext.uuid,

    companyName: requestContext.companyName || "-",
    divisionName: requestContext.divisionName || "-",

    requesterName: requestContext.requesterName || "-",
    requesterEmail: requestContext.requesterEmail || null,

    actorName: actionUser?.fullName || "System",
    actorEmail: actionUser?.email || null,

    statusCode: "COMPLETED",
    statusName: "Completed",

    actionCode: "COMPLETE",
    actionName: "Complete Operation",

    fromStatusCode: previousStatusCode,
    toStatusCode: "COMPLETED",

    remarks: "-",

    startDate: formatDateOnly(requestContext.startDate),
    endDate: formatDateOnly(requestContext.endDate),

    completionCount: completedAssignments.length,
    overallSlaStatus: getOverallCompletionSlaStatus(completedAssignments),

    completionDetailsText,
    completionDetailsHtml: escapeHtml(completionDetailsText).replace(
      /\n/g,
      "<br>",
    ),

    requestUrl: buildFrontendUrl("/main/equipment-request/assignments"),
  });

  await queueTemplateEmails(
    trx,
    [
      {
        templateCode: TEMPLATE_OPERATION_COMPLETED,
        moduleCode: MODULE_CODE,
        referenceId: requestContext.id,
        referenceUuid: requestContext.uuid,
        contextCode: "REQUESTER_COMPLETE_OPERATION",
        contextId: requestContext.id,
        recipientUserId: requester.id,
        toEmail: requester.email,
        payload,
        fromName: buildFromName(actionUser),
      },
    ],
    { buildFallbackTemplate },
  );
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

async function findAssignmentNotificationDetails(trx, requestId) {
  return trx("equipmentAssignments as assignment")
    .join(
      "equipmentRequestDetails as detail",
      "detail.id",
      "assignment.requestDetailId",
    )
    .join("equipmentUnits as unit", "unit.id", "assignment.equipmentUnitId")
    .leftJoin(
      "equipmentCategories as category",
      "category.id",
      "detail.equipmentCategoryId",
    )
    .where("assignment.requestId", requestId)
    .where("assignment.isActive", true)
    .whereNull("assignment.deletedAt")
    .whereNotIn("assignment.statusCode", ["REPLACED", "CANCELLED"])
    .select([
      "assignment.uuid",
      "assignment.statusCode",
      "assignment.plannedStartDate",
      "assignment.plannedEndDate",
      "assignment.actualStartDate",
      "assignment.actualEndDate",
      "assignment.notes",
      "category.code as categoryCode",
      "category.name as categoryName",
      "unit.unitCode",
      "unit.unitName",
      "unit.assetNumber",
    ])
    .orderBy([
      {
        column: "detail.id",
        order: "asc",
      },
      {
        column: "assignment.id",
        order: "asc",
      },
    ]);
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
    detailsHtml: escapeHtml(detailsText).replace(/\n/g, "<br>"),
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

    approvalUrl:
      rawPayload.approvalUrl ||
      buildFrontendUrl("/main/equipment-request/approvals"),

    requestUrl:
      rawPayload.requestUrl ||
      buildFrontendUrl("/main/equipment-request/requests"),

    ...rawPayload,
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

function buildAssignmentDetailsText(assignments) {
  if (!assignments.length) {
    return "-";
  }

  return assignments
    .map((assignment, index) => {
      const equipmentName =
        assignment.unitName || assignment.categoryName || "Equipment";

      const equipmentCode =
        assignment.unitCode || assignment.categoryCode || "-";

      const assetNumber = assignment.assetNumber
        ? ` | Asset: ${assignment.assetNumber}`
        : "";

      const period = `${formatDateOnly(
        assignment.plannedStartDate,
      )} sampai ${formatDateOnly(assignment.plannedEndDate)}`;

      return [
        `${index + 1}. ${equipmentCode} - ${equipmentName}${assetNumber}`,
        `   Planned: ${period}`,
      ].join("\n");
    })
    .join("\n");
}

function buildOperationStartedDetailsText(assignments) {
  if (!assignments.length) {
    return "-";
  }

  return assignments
    .map((assignment, index) => {
      const equipmentName =
        assignment.unitName || assignment.categoryName || "Equipment";

      const equipmentCode =
        assignment.unitCode || assignment.categoryCode || "-";

      const assetNumber = assignment.assetNumber
        ? ` | Asset: ${assignment.assetNumber}`
        : "";

      return [
        `${index + 1}. ${equipmentCode} - ${equipmentName}${assetNumber}`,
        `   Planned Start: ${formatDateOnly(assignment.plannedStartDate)}`,
        `   Actual Start : ${formatDateTime(assignment.actualStartDate)}`,
        `   Planned End  : ${formatDateOnly(assignment.plannedEndDate)}`,
        `   SLA Status   : ${getStartSlaStatus(assignment)}`,
      ].join("\n");
    })
    .join("\n");
}

function buildOperationCompletedDetailsText(assignments) {
  if (!assignments.length) {
    return "-";
  }

  return assignments
    .map((assignment, index) => {
      const equipmentName =
        assignment.unitName || assignment.categoryName || "Equipment";

      const equipmentCode =
        assignment.unitCode || assignment.categoryCode || "-";

      const assetNumber = assignment.assetNumber
        ? ` | Asset: ${assignment.assetNumber}`
        : "";

      return [
        `${index + 1}. ${equipmentCode} - ${equipmentName}${assetNumber}`,
        `   Planned Start: ${formatDateOnly(assignment.plannedStartDate)}`,
        `   Actual Start : ${formatDateTime(assignment.actualStartDate)}`,
        `   Planned End  : ${formatDateOnly(assignment.plannedEndDate)}`,
        `   Actual End   : ${formatDateTime(assignment.actualEndDate)}`,
        `   SLA Status   : ${getCompletionSlaStatus(assignment)}`,
      ].join("\n");
    })
    .join("\n");
}

function getStartSlaStatus(assignment) {
  if (!assignment.actualStartDate) {
    return "Not Started";
  }

  if (!assignment.plannedStartDate) {
    return "Started";
  }

  const actualStartDate = formatDateOnly(assignment.actualStartDate);
  const plannedStartDate = formatDateOnly(assignment.plannedStartDate);
  return actualStartDate <= plannedStartDate ? "On Time Start" : "Late Start";
}

function getCompletionSlaStatus(assignment) {
  if (!assignment.actualEndDate) {
    return "Not Completed";
  }

  if (!assignment.plannedEndDate) {
    return "Completed";
  }

  const actualEndDate = formatDateOnly(assignment.actualEndDate);

  const plannedEndDate = formatDateOnly(assignment.plannedEndDate);

  return actualEndDate <= plannedEndDate
    ? "Completed On Time"
    : "Completed Late";
}

function getOverallCompletionSlaStatus(assignments) {
  if (!assignments.length) {
    return "-";
  }

  const hasLateCompletion = assignments.some(
    (assignment) => getCompletionSlaStatus(assignment) === "Completed Late",
  );

  return hasLateCompletion ? "Completed Late" : "Completed On Time";
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

  if (templateCode === TEMPLATE_ASSIGNED) {
    return {
      subject: `Equipment assigned: ${payload.requestNo}`,
      html: `<!doctype html>
<html>
  <body>
    <p>Halo {{recipientName}},</p>

    <p>
      Equipment untuk request
      <strong>{{requestNo}}</strong>
      telah selesai di-assign.
    </p>

    <p>
      Company: {{companyName}}<br>
      Division: {{divisionName}}<br>
      Status: <strong>{{statusName}}</strong><br>
      Planned Period: {{startDate}} sampai {{endDate}}
    </p>

    <p>
      Equipment Assignment:<br>
      {{assignmentDetailsHtml}}
    </p>

    <p>
      <a href="{{requestUrl}}">
        Buka halaman assignment
      </a>
    </p>
  </body>
</html>`,
      text: `Halo {{recipientName}},

Equipment untuk request {{requestNo}} telah selesai di-assign.

Company: {{companyName}}
Division: {{divisionName}}
Status: {{statusName}}
Planned Period: {{startDate}} sampai {{endDate}}

Equipment Assignment:
{{assignmentDetailsText}}

Buka halaman assignment:
{{requestUrl}}`,
    };
  }

  if (templateCode === TEMPLATE_OPERATION_STARTED) {
    return {
      subject: `Operation started: ${payload.requestNo}`,
      html: `<!doctype html>
<html>
  <body>
    <p>Halo {{recipientName}},</p>

    <p>
      Operasi equipment untuk request
      <strong>{{requestNo}}</strong>
      telah dimulai.
    </p>

    <p>
      Company: {{companyName}}<br>
      Division: {{divisionName}}<br>
      Status: <strong>{{statusName}}</strong><br>
      Periode: {{startDate}} sampai {{endDate}}<br>
      Started By: {{actorName}}
    </p>

    <p>
      Detail Operation:<br>
      {{operationDetailsHtml}}
    </p>

    <p>
      <a href="{{requestUrl}}">
        Buka halaman assignment
      </a>
    </p>
  </body>
</html>`,
      text: `Halo {{recipientName}},

Operasi equipment untuk request {{requestNo}} telah dimulai.

Company: {{companyName}}
Division: {{divisionName}}
Status: {{statusName}}
Periode: {{startDate}} sampai {{endDate}}
Started By: {{actorName}}

Detail Operation:
{{operationDetailsText}}

Buka halaman assignment:
{{requestUrl}}`,
    };
  }

  if (templateCode === TEMPLATE_OPERATION_COMPLETED) {
    return {
      subject: `Operation completed: ${payload.requestNo}`,

      html: `<!doctype html>
<html>
  <body>
    <p>Halo {{recipientName}},</p>

    <p>
      Seluruh operasi equipment untuk request
      <strong>{{requestNo}}</strong>
      telah selesai.
    </p>

    <p>
      Company: {{companyName}}<br>
      Division: {{divisionName}}<br>
      Status: <strong>{{statusName}}</strong><br>
      Period: {{startDate}} sampai {{endDate}}<br>
      Completed By: {{actorName}}<br>
      Overall SLA: <strong>{{overallSlaStatus}}</strong>
    </p>

    <p>
      Completion Detail:<br>
      {{completionDetailsHtml}}
    </p>

    <p>
      <a href="{{requestUrl}}">
        Buka halaman assignment
      </a>
    </p>
  </body>
</html>`,

      text: `Halo {{recipientName}},

Seluruh operasi equipment untuk request {{requestNo}} telah selesai.

Company: {{companyName}}
Division: {{divisionName}}
Status: {{statusName}}
Period: {{startDate}} sampai {{endDate}}
Completed By: {{actorName}}
Overall SLA: {{overallSlaStatus}}

Completion Detail:
{{completionDetailsText}}

Buka halaman assignment:
{{requestUrl}}`,
    };
  }

  return {
    subject: `Equipment request updated: ${payload.requestNo}`,
    html: `<!doctype html><html><body><p>Halo {{recipientName}},</p><p>Status equipment request <strong>{{requestNo}}</strong> berubah menjadi <strong>{{statusCode}}</strong>.</p><p>Action: {{actionName}}</p><p><a href="{{requestUrl}}">Buka halaman request</a></p></body></html>`,
    text: `Halo {{recipientName}}, status equipment request {{requestNo}} berubah menjadi {{statusCode}}. Action: {{actionName}}. Buka: {{requestUrl}}`,
  };
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
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

function formatDateTime(value) {
  if (!value) {
    return "-";
  }

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat("id-ID", {
    timeZone: process.env.APP_TIMEZONE || "Asia/Jakarta",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

module.exports = {
  enqueueRequestActionNotifications,
  enqueueAssignmentNotifications,
  enqueueOperationStartedNotifications,
  enqueueOperationCompletedNotifications,
};
