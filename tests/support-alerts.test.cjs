const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm");
const now = new Date("2026-10-06T12:00:00Z");
function setup(options = {}) {
  const roles = require("../constants/staffRoles"),
    access = require("../services/reportAccess");
  const users = options.users || [
    { _id: "admin", role: "admin" },
    { _id: "support", role: "caller_support" },
    { _id: "finance", role: "financial" },
    { _id: "custom", role: "admin", roleId: { permissions: ["admin:access"] } },
  ];
  const item = {
    _id: "case",
    status: "open",
    staffAlertRevision: 0,
    staffAlertedRevision: -1,
    responseDueAt: new Date(now.getTime() + 3600000),
    ...options.item,
  };
  const notices = new Map(),
    updates = [],
    filters = [];
  let indexCalls = 0,
    fail = options.fail;
  const chain = (value) => ({
    select() {
      return this;
    },
    populate() {
      return this;
    },
    sort() {
      return this;
    },
    limit() {
      return this;
    },
    lean: async () => value,
  });
  const pending = () =>
    ["open", "in_progress", "waiting", "reopened"].includes(item.status) &&
    ((!item.staffAlertCancelled &&
      item.staffAlertRevision > item.staffAlertedRevision) ||
      (item.responseDueAt &&
        item.responseDueAt <= now &&
        new Date(item.staffOverdueAlertedFor || 0).getTime() !==
          item.responseDueAt.getTime()));
  const model = {
    find: (filter) => {
      filters.push(filter);
      return chain(pending() ? [{ ...item }] : []);
    },
    updateOne: async (filter, update) => {
      updates.push(filter);
      if (filter.$expr && filter.$expr.$eq[1] !== item.staffAlertRevision)
        return;
      if (
        filter.responseDueAt &&
        String(filter.responseDueAt) !== String(item.responseDueAt)
      )
        return;
      Object.assign(item, update.$set);
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(require.resolve("../services/supportAlerts"), "utf8"),
    {
      module,
      Date,
      process: { env: options.env || {} },
      console,
      setInterval,
      require: (name) =>
        name.includes("SupportCase")
          ? model
          : name.includes("/User")
            ? { find: () => chain(users) }
            : name.includes("/Notification")
              ? {
                  collection: {
                    createIndex: async () => {
                      indexCalls++;
                    },
                  },
                  updateOne: async (filter, update) => {
                    if (options.pause) await options.pause;
                    if (fail && update.$setOnInsert.userId === "support")
                      throw Error("temporary failure");
                    if (!notices.has(filter.dedupeKey))
                      notices.set(filter.dedupeKey, update.$setOnInsert);
                  },
                }
              : name.includes("reportAccess")
                ? access
                : roles,
    },
  );
  return {
    api: module.exports,
    item,
    notices,
    updates,
    filters,
    getIndexCalls: () => indexCalls,
    recover: () => {
      fail = false;
    },
  };
}
test("staff alert permissions match route permissions and custom roles are authoritative", () => {
  const s = setup();
  assert.equal(s.api.canReceive({ role: "admin" }), true);
  assert.equal(
    s.api.canReceive({ role: "superadmin", roleId: { permissions: [] } }),
    true,
  );
  assert.equal(s.api.canReceive({ role: "financial" }), false);
  assert.equal(
    s.api.canReceive({
      role: "admin",
      roleId: { permissions: ["admin:access"] },
    }),
    false,
  );
});
test("new request delivers only permitted staff and generic notice once", async () => {
  const s = setup();
  await s.api.runSupportAlerts(now);
  assert.equal(s.notices.size, 2);
  assert.equal(s.item.staffAlertedRevision, 0);
  await s.api.runSupportAlerts(now);
  assert.equal(s.notices.size, 2);
  assert.equal(s.getIndexCalls(), 1);
  for (const notice of s.notices.values()) {
    assert.equal(notice.metadata.supportCaseId, "case");
    assert.equal(notice.metadata.audience, "staff");
    assert.equal(notice.message.includes("phone"), false);
  }
});
test("partial failure keeps revision pending and retries without duplicate notices", async () => {
  const s = setup({ fail: true });
  const first = await s.api.runSupportAlerts(now);
  assert.equal(first.failed, 1);
  assert.equal(s.item.staffAlertedRevision, -1);
  assert.equal(s.notices.size, 1);
  s.recover();
  await s.api.runSupportAlerts(now);
  assert.equal(s.notices.size, 2);
  assert.equal(s.item.staffAlertedRevision, 0);
});
test("overdue target escalates once, then a new reply revision creates fresh alerts", async () => {
  const s = setup({ item: { responseDueAt: new Date(now.getTime() - 60000) } });
  await s.api.runSupportAlerts(now);
  assert.equal(s.notices.size, 4);
  assert.equal(s.item.escalated, true);
  await s.api.runSupportAlerts(now);
  assert.equal(s.notices.size, 4);
  s.item.staffAlertRevision++;
  s.item.responseDueAt = new Date(now.getTime() + 3600000);
  await s.api.runSupportAlerts(now);
  assert.equal(s.notices.size, 6);
});
test("closed and already-answered cases do not notify staff", async () => {
  for (const item of [
    { status: "closed" },
    { staffAlertCancelled: true, responseDueAt: null },
  ]) {
    const s = setup({ item });
    await s.api.runSupportAlerts(now);
    assert.equal(s.notices.size, 0);
  }
});
test("no authorized recipients leaves the revision for a future scan", async () => {
  const s = setup({ users: [{ _id: "finance", role: "financial" }] });
  const result = await s.api.runSupportAlerts(now);
  assert.equal(result.recipients, 0);
  assert.equal(s.item.staffAlertedRevision, -1);
});
test("overlapping local scans are skipped", async () => {
  let release;
  const pause = new Promise((resolve) => {
    release = resolve;
  });
  const s = setup({ pause });
  const first = s.api.runSupportAlerts(now);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await s.api.runSupportAlerts(now)).skipped, true);
  release();
  await first;
});
test("response target defaults to a day and clamps configured minutes", () => {
  for (const [value, minutes] of [
    [undefined, 1440],
    ["5", 15],
    ["20000", 10080],
  ]) {
    const env = value ? { SUPPORT_RESPONSE_TARGET_MINUTES: value } : {};
    const before = Date.now(),
      deadline = setup({ env }).api.responseDeadline().getTime();
    assert.ok(
      deadline >= before + minutes * 60000 &&
        deadline <= Date.now() + minutes * 60000,
    );
  }
});
test("legacy overdue cases generate overdue notices without announcing a new request", async () => {
  const s = setup({
    item: {
      staffAlertRevision: undefined,
      responseDueAt: new Date(now.getTime() - 60000),
    },
  });
  await s.api.runSupportAlerts(now);
  assert.equal(s.notices.size, 2);
  for (const notice of s.notices.values())
    assert.equal(notice.metadata.event, "overdue");
});
test("retry preserves an already-read staff notice", async () => {
  const s = setup({ fail: true });
  await s.api.runSupportAlerts(now);
  const first = [...s.notices.values()][0];
  first.read = true;
  s.recover();
  await s.api.runSupportAlerts(now);
  assert.equal(first.read, true);
  assert.equal(s.notices.size, 2);
});
