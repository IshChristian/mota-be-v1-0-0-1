const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm");
function setup(options = {}) {
  const item = {
    _id: "case",
    customerId: "owner",
    status: "closed",
    messages: [
      {
        _id: "public",
        authorType: "staff",
        internal: false,
        notificationPending: true,
      },
      {
        _id: "private",
        authorType: "staff",
        internal: true,
        notificationPending: true,
      },
      {
        _id: "user",
        authorType: "user",
        internal: false,
        notificationPending: true,
      },
    ],
  };
  const records = new Map();
  let fail = options.fail,
    ackFailure = options.ackFailure,
    filter;
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(
      require.resolve("../services/supportReplyDelivery"),
      "utf8",
    ),
    {
      module,
      require: (name) =>
        name.includes("SupportCase")
          ? {
              find: (f) => {
                filter = f;
                return {
                  select() {
                    return this;
                  },
                  sort() {
                    return this;
                  },
                  limit() {
                    return this;
                  },
                  lean: async () => [
                    { ...item, messages: item.messages.map((m) => ({ ...m })) },
                  ],
                };
              },
              updateOne: async (f, u) => {
                if (ackFailure) throw Error("ack unavailable");
                assert.equal(f.customerId, "owner");
                const id = f.messages.$elemMatch._id;
                item.messages.find((m) => m._id === id).notificationPending =
                  false;
              },
            }
          : name.includes("Notification")
            ? {
                updateOne: async (f, u) => {
                  if (fail) throw Error("storage unavailable");
                  if (!records.has(f.dedupeKey))
                    records.set(f.dedupeKey, u.$setOnInsert);
                },
              }
            : { ensureDedupeIndex: async () => {} },
    },
  );
  return {
    api: module.exports,
    item,
    records,
    getFilter: () => filter,
    recover: () => {
      fail = false;
      ackFailure = false;
    },
  };
}
test("closed cases deliver public replies only to their owner", async () => {
  const s = setup();
  const r = await s.api.runSupportReplyDelivery();
  assert.equal(r.sent, 1);
  assert.equal(s.records.size, 1);
  assert.equal([...s.records.values()][0].userId, "owner");
  assert.equal(s.getFilter().status, undefined);
  assert.equal(s.item.messages[0].notificationPending, false);
  assert.equal(s.item.messages[1].notificationPending, true);
});
test("notification failure retains pending flag and recovers next scan", async () => {
  const s = setup({ fail: true });
  assert.equal((await s.api.runSupportReplyDelivery()).failed, 1);
  assert.equal(s.item.messages[0].notificationPending, true);
  s.recover();
  assert.equal((await s.api.runSupportReplyDelivery()).sent, 1);
  assert.equal(s.records.size, 1);
});
test("ack failure retries the same notice without resetting its read status", async () => {
  const s = setup({ ackFailure: true });
  await s.api.runSupportReplyDelivery();
  assert.equal(s.item.messages[0].notificationPending, true);
  const record = [...s.records.values()][0];
  record.read = true;
  s.recover();
  await s.api.runSupportReplyDelivery();
  assert.equal(s.records.size, 1);
  assert.equal(record.read, true);
  assert.equal(s.item.messages[0].notificationPending, false);
});
test("each public reply gets its own delivery record", async () => {
  const s = setup();
  s.item.messages.push({
    _id: "second",
    authorType: "staff",
    internal: false,
    notificationPending: true,
  });
  await s.api.runSupportReplyDelivery();
  assert.equal(s.records.size, 2);
  assert.equal(
    new Set([...s.records.values()].map((v) => v.metadata.supportMessageId))
      .size,
    2,
  );
});
test("cases without an owner never create a notice", async () => {
  const s = setup();
  s.item.customerId = null;
  assert.equal((await s.api.deliverCase(s.item)).sent, 0);
  assert.equal(s.records.size, 0);
});
