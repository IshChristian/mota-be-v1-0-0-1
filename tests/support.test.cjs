const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm");
const owner = "a".repeat(24),
  caseId = "b".repeat(24);
function setup(
  overrides = {},
  delivery = async () => {
    throw Error("delivery failure");
  },
) {
  const calls = [],
    model = {
      findOne: async (filter) => {
        calls.push(filter);
        return null;
      },
      create: async (value) => {
        calls.push(value);
        return { _id: caseId, ...value };
      },
      findByIdAndUpdate: async () => ({
        _id: caseId,
        customerId: owner,
        subject: "Help",
        status: "open",
      }),
      ...overrides,
    };
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(
      require.resolve("../controllers/supportController"),
      "utf8",
    ),
    {
      module,
      URL,
      Date,
      process: { env: {} },
      require: (name) =>
        name.includes("supportReplyDelivery")
          ? {
              deliverCase: delivery,
            }
          : name.includes("supportAlerts")
            ? {
                responseDeadline: () => new Date(Date.now() + 86400000),
                activeStatuses: ["open", "in_progress", "waiting", "reopened"],
              }
            : name.includes("SupportCase")
              ? model
              : name.includes("/Ride")
                ? { findOne: async () => null }
                : name.includes("constants")
                  ? require("../constants/support")
                  : name.includes("uploadService")
                    ? { cloudinary: { config: () => ({ cloud_name: "test" }) } }
                    : name.includes("notificationService")
                      ? {
                          createNotification: async () => {
                            throw Error("delivery failure");
                          },
                        }
                      : { log: async () => {} },
    },
  );
  return {
    api: module.exports,
    calls,
    invoke: async (method, body = {}, params = { id: caseId }) => {
      let status = 200,
        data;
      await module.exports[method](
        { user: { id: owner, role: "admin" }, body, params, query: {} },
        {
          status(n) {
            status = n;
            return this;
          },
          json(v) {
            data = v;
          },
        },
      );
      return { status, data };
    },
  };
}
test("public case omits private notes and staff-only history", () => {
  const x = setup().api.publicCase({
    _id: caseId,
    contactHistory: ["private"],
    assignedTo: owner,
    messages: [
      { text: "public", internal: false },
      { text: "secret", internal: true },
    ],
  });
  assert.equal(x.messages.length, 1);
  assert.equal(x.messages[0].text, "public");
  assert.equal(x.contactHistory, undefined);
  assert.equal(x.assignedTo, undefined);
});
test("details binds case ownership to authenticated user", async () => {
  const s = setup(),
    r = await s.invoke("details");
  assert.equal(r.status, 404);
  assert.equal(s.calls[0].customerId, owner);
});
test("create ignores forged ownership, status and priority", async () => {
  const s = setup(),
    r = await s.invoke("create", {
      subject: " Help ",
      description: "Issue",
      customerId: caseId,
      status: "closed",
      priority: "urgent",
    });
  assert.equal(r.status, 201);
  assert.equal(s.calls[0].customerId, owner);
  assert.equal(s.calls[0].priority, "normal");
  assert.equal(s.calls[0].status, undefined);
});
test("rejects another account attachment and unrelated ride", async () => {
  const s = setup();
  assert.equal(
    (
      await s.invoke("create", {
        subject: "Help",
        description: "Issue",
        attachments: [
          {
            name: "id",
            url: `https://res.cloudinary.com/test/image/upload/mota_uploads/${caseId}/id.jpg`,
          },
        ],
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await s.invoke("create", {
        subject: "Help",
        description: "Issue",
        rideId: caseId,
      })
    ).status,
    404,
  );
});
test("accepts signed account folder attachment", async () => {
  const s = setup();
  assert.equal(
    (
      await s.invoke("create", {
        subject: "Help",
        description: "Issue",
        attachments: [
          {
            name: "id",
            url: `https://res.cloudinary.com/test/image/upload/v1/mota_uploads/${owner}/id.jpg`,
          },
        ],
      })
    ).status,
    201,
  );
});
test("internal notes cannot leak through public resolution", async () => {
  assert.equal(
    (
      await setup().invoke("staffReply", {
        text: "Private info",
        internal: true,
        status: "resolved",
      })
    ).status,
    400,
  );
});
test("notification failure does not turn saved reply into failure", async () => {
  assert.equal(
    (
      await setup().invoke("staffReply", {
        text: "We are checking",
        status: "open",
      })
    ).status,
    200,
  );
});
test("invalid case id returns client error", async () => {
  assert.equal(
    (await setup().invoke("details", {}, { id: "bad" })).status,
    400,
  );
});
test("swagger documents secured support and upload contracts", () => {
  const spec = require("../swaggerSupport").extend({
    paths: {},
    components: { schemas: {} },
  });
  for (const path of [
    "/api/support",
    "/api/support/{id}",
    "/api/support/{id}/messages",
    "/api/support/{id}/reopen",
    "/api/admin/support-cases/{id}/messages",
    "/api/uploads/signature",
  ]) {
    assert.ok(spec.paths[path]);
    for (const op of Object.values(spec.paths[path]))
      assert.equal(op.security[0].bearerAuth.length, 0);
  }
});
test("user replies schedule staff review without clearing manual escalation", async () => {
  let update;
  const s = setup({
    findOneAndUpdate: async (filter, changes) => {
      update = changes;
      return { _id: caseId, status: "open" };
    },
  });
  assert.equal(
    (await s.invoke("reply", { text: "Additional details" })).status,
    200,
  );
  assert.equal(update.$inc.staffAlertRevision, 1);
  assert.equal(update.$set.staffAlertCancelled, false);
  assert.equal(update.$set.escalated, undefined);
  assert.ok(update.$set.responseDueAt instanceof Date);
});
test("public replies clear target; private notes leave target and alerts untouched", async () => {
  for (const internal of [true, false]) {
    let update;
    const s = setup({
      findByIdAndUpdate: async (id, changes) => {
        update = changes;
        return { _id: caseId, customerId: owner, status: "open" };
      },
    });
    assert.equal(
      (await s.invoke("staffReply", { text: "An update", internal })).status,
      200,
    );
    assert.equal(update.$push.messages.notificationPending, !internal);
    if (internal) assert.equal(update.$set, undefined);
    else {
      assert.equal(update.$set.responseDueAt, null);
      assert.equal(update.$set.staffAlertCancelled, true);
    }
  }
});
test("a saved reply responds without waiting for slow inbox storage", async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const s = setup({}, () => pending);
  let timer;
  try {
    const result = await Promise.race([
      s.invoke("staffReply", { text: "Saved reply" }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("Reply waited for notification storage")),
          500,
        );
      }),
    ]);
    assert.equal(result.status, 200);
  } finally {
    clearTimeout(timer);
    release();
  }
});
