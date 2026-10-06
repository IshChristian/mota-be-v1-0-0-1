const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm");
const owner = "a".repeat(24),
  notice = "b".repeat(24);
function controller() {
  const calls = [],
    module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(
      require.resolve("../controllers/notificationController"),
      "utf8",
    ),
    {
      module,
      require: (name) =>
        name.includes("notificationService")
          ? {
              getUserNotifications: async (...args) => {
                calls.push(args);
                return { data: [] };
              },
              markAsRead: async (...args) => {
                calls.push(args);
                return null;
              },
              deleteNotification: async (...args) => {
                calls.push(args);
                return null;
              },
            }
          : { updateOne: async () => {} },
    },
  );
  return { api: module.exports, calls };
}
function response() {
  return {
    statusCode: 200,
    status(n) {
      this.statusCode = n;
      return this;
    },
    json(value) {
      this.body = value;
    },
  };
}
test("inbox pagination is bounded and scoped to the authenticated account", async () => {
  const s = controller(),
    res = response();
  await s.api.getNotifications(
    { user: { id: owner }, query: { page: "-5", limit: "999999" } },
    res,
  );
  assert.deepEqual(s.calls[0], [owner, false, 1, 100]);
  assert.equal(res.statusCode, 200);
});
test("unread query remains owner scoped", async () => {
  const s = controller();
  await s.api.getUnreadNotifications(
    { user: { id: owner }, query: {} },
    response(),
  );
  assert.deepEqual(s.calls[0], [owner, true, 1, 20]);
});
test("read and delete operations pass ownership and return 404 for unavailable records", async () => {
  for (const method of ["markAsRead", "deleteNotification"]) {
    const s = controller(),
      res = response();
    await s.api[method]({ user: { id: owner }, params: { id: notice } }, res);
    assert.deepEqual(s.calls[0], [notice, owner]);
    assert.equal(res.statusCode, 404);
  }
});
test("malformed notification ids return 400", async () => {
  for (const method of ["markAsRead", "deleteNotification"]) {
    const s = controller(),
      res = response();
    await s.api[method](
      { user: { id: owner }, params: { id: "invalid" } },
      res,
    );
    assert.equal(res.statusCode, 400);
    assert.equal(s.calls.length, 0);
  }
});
test("own inbox works during onboarding while push token writes retain the full gate", async () => {
  const express = require("express"),
    c = controller(),
    module = { exports: {} };
  const authenticate = (full) => (req, res, next) => {
    if (!req.headers.authorization)
      return res.status(401).json({ message: "Sign in" });
    if (full && req.headers.authorization === "Bearer onboarding")
      return res.status(403).json({ message: "Complete account" });
    req.user = { id: owner };
    next();
  };
  vm.runInNewContext(
    fs.readFileSync(require.resolve("../routes/notificationRoutes"), "utf8"),
    {
      module,
      require: (name) =>
        name === "express"
          ? express
          : name.includes("notificationController")
            ? c.api
            : {
                protect: authenticate(true),
                protectOnboardingStatus: authenticate(false),
              },
    },
  );
  const app = express();
  app.use(express.json());
  app.use("/api/notifications", module.exports);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/notifications`;
  try {
    assert.equal(
      (await fetch(base, { headers: { Authorization: "Bearer onboarding" } }))
        .status,
      200,
    );
    assert.equal((await fetch(base)).status, 401);
    assert.equal(
      (
        await fetch(`${base}/push-token`, {
          method: "DELETE",
          headers: {
            Authorization: "Bearer onboarding",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ token: "ExpoPushToken[valid]" }),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/${notice}/read`, {
          method: "PATCH",
          headers: { Authorization: "Bearer onboarding" },
        })
      ).status,
      404,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
