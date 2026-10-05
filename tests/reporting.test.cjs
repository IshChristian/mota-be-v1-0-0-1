const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm"),
  path = require("node:path");
const access = require("../services/reportAccess");
const { PERMISSIONS } = require("../constants/staffRoles");
const superadmin = { role: "superadmin" };
test("superadmin receives all capabilities, including access management", () => {
  assert.ok(
    access.effectivePermissions(superadmin).includes("data:access_manage"),
  );
  assert.equal(
    access.effectivePermissions(superadmin).length,
    PERMISSIONS.length,
  );
});
test("stored roles are authoritative; individual report overrides replace scoped permissions only", () => {
  const p = access.effectivePermissions({
    role: "admin",
    roleId: {
      permissions: [
        "admin:access",
        "user:view",
        "analytics:view",
        "analytics:finance",
        "audit:view",
      ],
    },
    reportPermissions: ["analytics:view", "analytics:users"],
  });
  assert.deepEqual(
    p.sort(),
    ["admin:access", "user:view", "analytics:view", "analytics:users"].sort(),
  );
});
test("empty override revokes reporting while retaining other permissions", () => {
  assert.deepEqual(
    access.effectivePermissions({
      role: "financial",
      roleId: {
        permissions: ["admin:access", "analytics:view", "analytics:finance"],
      },
      reportPermissions: [],
    }),
    ["admin:access"],
  );
});
test("grant rejects escalation and permission prerequisites", () => {
  assert.throws(
    () =>
      access.validateGrant({ role: "agent" }, [
        "analytics:view",
        "analytics:finance",
      ]),
    (e) => e.status === 403,
  );
  assert.throws(
    () => access.validateGrant(superadmin, ["analytics:finance"]),
    (e) => e.status === 400,
  );
  assert.throws(
    () => access.validateGrant(superadmin, ["audit:export"]),
    (e) => e.status === 400,
  );
  assert.throws(
    () => access.validateGrant(superadmin, ["wallet:adjust"]),
    (e) => e.status === 400,
  );
});
test("authorized admin can delegate its reports but not access-management ownership", () => {
  assert.deepEqual(
    access.validateGrant({ role: "admin" }, [
      "analytics:view",
      "analytics:users",
    ]),
    ["analytics:view", "analytics:users"],
  );
  assert.throws(
    () => access.validateGrant({ role: "admin" }, ["data:access_manage"]),
    (e) => e.status === 403,
  );
});
function service() {
  const module = { exports: {} };
  const stub = {};
  vm.runInNewContext(
    fs.readFileSync(
      path.join(__dirname, "../services/reportService.js"),
      "utf8",
    ),
    {
      module,
      exports: module.exports,
      Date,
      require: (name) =>
        name === "mongoose"
          ? { isValidObjectId: (v) => /^[a-f0-9]{24}$/.test(v) }
          : name === "./reportAccess"
            ? access
            : stub,
    },
  );
  return module.exports;
}
test("validates reporting periods, Kigali boundaries and page limits", () => {
  const s = service();
  const f = s.filters({ from: "2026-10-01", to: "2026-10-05" });
  assert.equal(f.from.toISOString(), "2026-09-30T22:00:00.000Z");
  assert.equal(f.to.toISOString(), "2026-10-05T21:59:59.999Z");
  for (const q of [
    { from: "2026-02-30" },
    { from: "2026-13-01" },
    { from: "2026-10-06", to: "2026-10-05" },
    { from: "2020-01-01", to: "2026-10-05" },
    { page: -1 },
    { page: "1.5" },
    { role: "root" },
    { q: "a".repeat(101) },
  ])
    assert.throws(() => s.filters(q));
});
test("scoped viewing/export permissions do not leak finance to user analysts", () => {
  const s = service(),
    user = {
      role: "agent",
      reportPermissions: [
        "analytics:view",
        "analytics:users",
        "analytics:export",
      ],
    };
  s.ensure(user, "users", true);
  assert.throws(
    () => s.ensure(user, "finance"),
    (e) => e.status === 403,
  );
  assert.throws(
    () => s.ensure(user, "security", true),
    (e) => e.status === 403,
  );
});
test("redacts secrets even with sensitive audit permission", () => {
  const s = service(),
    row = {
      password: "secret",
      nested: {
        twoFactorSecret: "secret",
        phone: "0788",
        email: "a@example.test",
        before: { nationalId: "123" },
      },
    };
  const hidden = s.safe(row, false);
  assert.equal(hidden.nested.phone, "[restricted]");
  assert.equal(hidden.nested.before.nationalId, "[restricted]");
  const sensitive = s.safe(row, true);
  assert.equal(sensitive.nested.phone, "0788");
  assert.equal(sensitive.password, "[redacted]");
  assert.equal(sensitive.nested.twoFactorSecret, "[redacted]");
});

test("driver and passenger accounts cannot inherit staff reporting permissions from a mismatched role record", () => {
  for (const role of ["driver", "client"])
    assert.deepEqual(
      access.effectivePermissions({
        role,
        roleId: { permissions: PERMISSIONS },
        reportPermissions: ["analytics:view", "analytics:finance"],
      }),
      [],
    );
});
test("legacy user role route requires role-assignment authorization", () => {
  const routes = [];
  const router = {
    get() {},
    post() {},
    put() {},
    delete() {},
    use() {},
    patch: (...args) => routes.push(args),
  };
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "../routes/userRoutes.js"), "utf8"),
    {
      module,
      require: (name) =>
        name === "express"
          ? { Router: () => router }
          : name.includes("authMiddleware")
            ? {
                protect: () => {},
                protectOnboardingStatus: () => {},
                authorize: (permission) => ({ required: permission }),
              }
            : name.includes("uploadService")
              ? { uploadMiddleware: { single: () => () => {} } }
              : new Proxy({}, { get: () => () => {} }),
    },
  );
  const roleRoute = routes.find((r) => r[0] === "/:id/role");
  assert.equal(roleRoute[1].required, "user:assign_role");
});

test("role creation cannot bypass reporting grants or delegate access-management ownership", async () => {
  let created = 0;
  const module = { exports: {} };
  const roles = {
    getRoleByName: async () => null,
    createRole: async (name, description, permissions) => {
      created++;
      return { _id: "test", name, permissions };
    },
  };
  vm.runInNewContext(
    fs.readFileSync(
      path.join(__dirname, "../controllers/roleController.js"),
      "utf8",
    ),
    {
      module,
      require: (name) =>
        name.includes("reportAccess")
          ? access
          : name.includes("roleService")
            ? roles
            : { log: async () => {} },
    },
  );
  for (const permissions of [
    ["analytics:view", "analytics:finance"],
    ["data:access_manage"],
  ]) {
    const response = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json() {
        return this;
      },
    };
    await module.exports.createRole(
      {
        body: { name: "test", permissions },
        user: {
          role: "manager",
          roleId: {
            permissions: ["role:manage", "analytics:view", "analytics:users"],
          },
        },
      },
      response,
    );
    assert.equal(response.statusCode, 403);
  }
  assert.equal(created, 0);
});

test("audit hides legacy ID fields, document attachments and resolution text without sensitive access",()=>{const row=service().safe({nid:"123",insuranceAttachment:"https://example.test/private",resolution:"Personal details"});for(const value of Object.values(row))assert.equal(value,"[restricted]");});
