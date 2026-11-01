const { CATEGORIES, STATUSES } = require("./constants/support");
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema) => ({ "application/json": { schema } });
const response = (description, schema) => ({
  description,
  ...(schema ? { content: json(schema) } : {}),
});
const error = { type: "object", properties: { message: { type: "string" } } };
const security = [{ bearerAuth: [] }];
const errors = {
  400: response("Invalid input", error),
  401: response("Missing or expired authentication", error),
  403: response("Permission denied", error),
  404: response("Record not found or not owned", error),
  409: response("Status conflict", error),
  429: response("Rate limit exceeded", error),
  500: response("Service failure", error),
};
const caseId = {
  in: "path",
  name: "id",
  required: true,
  schema: { type: "string", pattern: "^[a-fA-F0-9]{24}$" },
};
const envelope = {
  type: "object",
  properties: { data: ref("SupportCasePublic") },
};
function operation(summary, input, extra = {}) {
  return {
    tags: ["Support"],
    summary,
    security,
    ...(input
      ? { requestBody: { required: true, content: json(ref(input)) } }
      : {}),
    responses: { 200: response("Success", envelope), ...errors },
    ...extra,
  };
}
const paths = {
  "/api/admin/support-summary": {
    get: operation("Support queue counts", null, {
      description:
        "Requires admin:access and support:view. Counts all active, overdue, urgent and waiting cases across the queue; response targets are estimates.",
      responses: {
        200: response("Queue summary", {
          type: "object",
          properties: { data: ref("SupportQueueSummary") },
        }),
        ...errors,
      },
    }),
  },
  "/api/admin/support-cases": {
    get: operation("Browse the staff support queue", null, {
      description:
        "Requires admin:access and support:view. Results are paginated. Overdue means an active case whose current response target has passed. Queue filters accept active statuses only. Conversation and contact history are fetched separately via case details; the queue includes contactCount.",
      parameters: [
        {
          in: "query",
          name: "page",
          schema: { type: "integer", minimum: 1, maximum: 1000, default: 1 },
        },
        {
          in: "query",
          name: "limit",
          schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
        },
        {
          in: "query",
          name: "status",
          schema: { type: "string", enum: STATUSES },
        },
        {
          in: "query",
          name: "queue",
          schema: {
            type: "string",
            enum: ["all", "active", "overdue", "urgent"],
            default: "all",
          },
        },
      ],
      responses: {
        200: response("Cases in the requested queue", {
          type: "object",
          properties: {
            data: { type: "array", items: ref("SupportCaseStaff") },
            page: { type: "integer" },
            limit: { type: "integer" },
            total: { type: "integer" },
          },
        }),
        ...errors,
      },
    }),
  },
  "/api/support": {
    get: operation("List your support cases", null, {
      parameters: [
        {
          in: "query",
          name: "page",
          schema: { type: "integer", minimum: 1, maximum: 1000, default: 1 },
        },
        {
          in: "query",
          name: "limit",
          schema: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        },
        {
          in: "query",
          name: "status",
          schema: { type: "string", enum: STATUSES },
        },
      ],
      responses: {
        200: response("Owner-scoped cases", {
          type: "object",
          properties: {
            data: { type: "array", items: ref("SupportCasePublic") },
            page: { type: "integer" },
            limit: { type: "integer" },
            total: { type: "integer" },
          },
        }),
        ...errors,
      },
    }),
    post: operation("Create your support request", "SupportCaseCreate", {
      description:
        "Authenticated onboarding/disabled users may ask for help. Related rides and signed Cloudinary attachments must belong to the user. Safety requests are urgent; emergency services must be contacted separately.",
      responses: { 201: response("Case created", envelope), ...errors },
    }),
  },
  "/api/support/{id}": {
    get: operation("Read your case and public replies", null, {
      parameters: [caseId],
      description:
        "Private staff notes, contact history and other users’ cases are never returned.",
    }),
  },
  "/api/support/{id}/messages": {
    post: operation("Reply to your active case", "SupportMessageCreate", {
      parameters: [caseId],
    }),
  },
  "/api/support/{id}/reopen": {
    post: operation("Reopen your resolved or closed case", "SupportReopen", {
      parameters: [caseId],
    }),
  },
  "/api/admin/support-cases/{id}/messages": {
    post: operation("Staff reply or internal note", "SupportStaffReply", {
      parameters: [caseId],
      description:
        "Requires support:update. Internal notes are excluded from user responses and cannot change public case status. Public replies save a per-message pending inbox update atomically with the reply. The reply response does not wait for inbox storage; a background attempt and one-minute retry queue record the notification. Closed cases are included. This is an inbox update, not proof of device delivery. Resolution text is required via the reply when resolving/closing.",
      responses: {
        200: response("Staff case with saved reply", {
          type: "object",
          properties: { data: ref("SupportCaseStaff") },
        }),
        ...errors,
      },
    }),
  },
  "/api/uploads/signature": {
    post: {
      tags: ["Uploads"],
      summary: "Authorize a signed direct Cloudinary upload",
      security,
      description:
        "Server signs fixed per-user upload parameters. The API secret never leaves the server. No unsigned preset is required.",
      responses: {
        200: response("Public signing information", {
          type: "object",
          properties: { data: ref("CloudinaryUploadAuthorization") },
        }),
        503: response("Server Cloudinary configuration unavailable", error),
        ...errors,
      },
    },
  },
};
const attachment = {
  type: "object",
  required: ["url", "name"],
  properties: {
    url: {
      type: "string",
      format: "uri",
      description:
        "HTTPS URL of an asset uploaded in the caller’s signed Cloudinary folder",
    },
    name: { type: "string", minLength: 1, maxLength: 160 },
  },
};
const message = {
  type: "object",
  required: ["text"],
  properties: {
    text: { type: "string", minLength: 1, maxLength: 4000 },
    attachments: {
      type: "array",
      maxItems: 5,
      items: ref("SupportAttachment"),
    },
  },
};
const schemas = {
  SupportQueueSummary: {
    type: "object",
    properties: Object.fromEntries(
      ["active", "overdue", "urgent", "waiting"].map((name) => [
        name,
        { type: "integer", minimum: 0 },
      ]),
    ),
  },
  SupportCaseStaff: {
    type: "object",
    description:
      "Staff-visible support case, including assigned accounts and private conversation entries when requesting details/replying. Queue listing excludes messages and contact history.",
    properties: {
      _id: { type: "string" },
      subject: { type: "string" },
      description: { type: "string" },
      status: { type: "string", enum: STATUSES },
      responseDueAt: { type: "string", format: "date-time", nullable: true },
      escalated: { type: "boolean" },
      contactCount: { type: "integer", minimum: 0 },
      messages: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            internal: { type: "boolean" },
            notificationPending: {
              type: "boolean",
              description:
                "Staff-only inbox write state; private notes are never queued",
            },
            notificationRecordedAt: {
              type: "string",
              format: "date-time",
              description:
                "Inbox write acknowledged; not proof of device delivery or reading",
            },
            authorType: { type: "string", enum: ["staff", "user"] },
            createdAt: { type: "string", format: "date-time" },
          },
        },
      },
    },
  },
  SupportAttachment: attachment,
  SupportMessageCreate: message,
  SupportReopen: {
    type: "object",
    required: ["text"],
    properties: { text: { type: "string", minLength: 1, maxLength: 4000 } },
  },
  SupportStaffReply: {
    type: "object",
    required: ["text"],
    properties: {
      text: message.properties.text,
      internal: { type: "boolean", default: false },
      status: { type: "string", enum: STATUSES },
    },
  },
  SupportCaseCreate: {
    type: "object",
    required: ["subject", "description"],
    properties: {
      subject: { type: "string", minLength: 1, maxLength: 160 },
      description: { type: "string", minLength: 1, maxLength: 4000 },
      category: { type: "string", enum: CATEGORIES, default: "other" },
      rideId: { type: "string", pattern: "^[a-fA-F0-9]{24}$" },
      attachments: message.properties.attachments,
    },
  },
  SupportCasePublic: {
    type: "object",
    properties: {
      _id: { type: "string" },
      reference: { type: "string" },
      subject: { type: "string" },
      description: { type: "string" },
      category: { type: "string", enum: CATEGORIES },
      status: { type: "string", enum: STATUSES },
      priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
      rideId: { type: "string" },
      attachments: message.properties.attachments,
      resolution: { type: "string" },
      responseDueAt: {
        type: "string",
        format: "date-time",
        description:
          "Response target, not a guaranteed reply time; null after a public staff reply",
        nullable: true,
      },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      messages: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            authorType: { type: "string", enum: ["user", "staff"] },
            attachments: message.properties.attachments,
            createdAt: { type: "string", format: "date-time" },
          },
        },
      },
    },
  },
  CloudinaryUploadAuthorization: {
    type: "object",
    properties: {
      cloudName: { type: "string" },
      apiKey: { type: "string" },
      signature: { type: "string" },
      params: {
        type: "object",
        properties: {
          timestamp: { type: "integer" },
          folder: { type: "string" },
          public_id: { type: "string" },
          overwrite: { type: "boolean", enum: [false] },
        },
      },
    },
  },
};
function extend(spec) {
  Object.assign(spec.paths, paths);
  Object.assign(spec.components.schemas, schemas);
  const noticeSchema = {
    type: "object",
    properties: {
      _id: { type: "string" },
      title: { type: "string" },
      message: { type: "string" },
      read: { type: "boolean" },
      createdAt: { type: "string", format: "date-time" },
      metadata: {
        type: "object",
        properties: {
          supportCaseId: { type: "string" },
          audience: { type: "string" },
          event: { type: "string" },
        },
      },
    },
  };
  spec.components.schemas.Notification = noticeSchema;
  for (const path of ["/api/notifications", "/api/notifications/unread"]) {
    const endpoint = spec.paths[path]?.get;
    if (!endpoint) continue;
    endpoint.description =
      "Authenticated own inbox, including users completing onboarding or with a deactivated account. Staff support alerts are permission-scoped, persisted and deduplicated per event/recipient. The staff scheduler polls every minute and retries failed writes. Push/SMS delivery is separate.";
    endpoint.parameters = [
      {
        in: "query",
        name: "page",
        schema: { type: "integer", minimum: 1, maximum: 1000, default: 1 },
      },
      {
        in: "query",
        name: "limit",
        schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
    ];
    endpoint.responses = {
      200: response("Own notification page", {
        type: "object",
        properties: {
          data: { type: "array", items: ref("Notification") },
          page: { type: "integer" },
          limit: { type: "integer" },
          totalItems: { type: "integer" },
          totalPages: { type: "integer" },
        },
      }),
      401: errors[401],
      500: errors[500],
    };
  }
  const availability = spec.paths["/api/driver/availability"]?.put;
  if (availability) {
    availability.description =
      "Manual online/offline updates persist preference. automatic=true requests online only and cannot override manual offline/logout. Full account KYC is canonical; known expired documents block online with a precise message. Phone, fee and activation checks apply.";
    const body =
      availability.requestBody?.content?.["application/json"]?.schema;
    if (body?.properties)
      body.properties.automatic = { type: "boolean", default: false };
  }
  return spec;
}
module.exports = { extend, paths, schemas };
