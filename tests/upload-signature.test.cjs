const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  vm = require("node:vm"),
  path = require("node:path"),
  crypto = require("node:crypto");
function setup(options = {}) {
  const signed = [],
    config = options.unconfigured
      ? {}
      : {
          cloud_name: "test",
          api_key: "public-key",
          api_secret: "server-secret",
        },
    module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(
      path.join(__dirname, "../controllers/uploadSignatureController.js"),
      "utf8",
    ),
    {
      module,
      require: (name) =>
        name === "node:crypto"
          ? crypto
          : {
              cloudinary: {
                config: () => config,
                utils: {
                  api_sign_request: (params, secret) => {
                    if (options.failure) throw Error("secret error");
                    signed.push({ params, secret });
                    return crypto
                      .createHash("sha1")
                      .update(
                        Object.entries(params)
                          .sort(([a], [b]) => a.localeCompare(b))
                          .map(([k, v]) => `${k}=${v}`)
                          .join("&") + secret,
                      )
                      .digest("hex");
                  },
                },
              },
            },
      Date,
    },
  );
  return {
    signed,
    invoke(user = { id: "driver" }) {
      let body, status, cache;
      module.exports.createUploadSignature(
        {
          user,
          body: { folder: "other-user", overwrite: true, public_id: "stolen" },
        },
        {
          set: (k, v) => (cache = v),
          status: (value) => {
            status = value;
            return { json: (value) => (body = value) };
          },
        },
      );
      return { body, status, cache };
    },
  };
}
test("signs fixed per-user parameters without returning API secret", () => {
  const h = setup(),
    r = h.invoke();
  assert.equal(r.status, 200);
  assert.equal(r.cache, "no-store");
  assert.equal(r.body.data.params.folder, "mota_uploads/driver");
  assert.equal(r.body.data.params.overwrite, false);
  assert.notEqual(r.body.data.params.public_id, "stolen");
  assert.equal(h.signed[0].secret, "server-secret");
  assert.match(r.body.data.signature, /^[a-f0-9]{40}$/);
  assert.ok(Math.abs(r.body.data.params.timestamp - Date.now() / 1000) < 2);
  assert.ok(!JSON.stringify(r.body).includes("server-secret"));
});
test("separate signatures have unique asset ids", () => {
  const h = setup();
  assert.notEqual(
    h.invoke().body.data.params.public_id,
    h.invoke().body.data.params.public_id,
  );
});
test("missing configuration returns a deployable explanation", () => {
  const r = setup({ unconfigured: true }).invoke();
  assert.equal(r.status, 503);
  assert.match(r.body.message, /CLOUDINARY_API_SECRET/);
});
test("invalid user id cannot select an arbitrary upload folder", () => {
  assert.equal(setup().invoke({ id: "../another-user" }).status, 401);
});
test("signing failure does not expose server error details", () => {
  const r = setup({ failure: true }).invoke();
  assert.equal(r.status, 503);
  assert.ok(!JSON.stringify(r.body).includes("secret error"));
});

test("generated parameters have the exact installed Cloudinary SDK signature", () => {
  const { v2: sdk } = require("cloudinary");
  const result = setup().invoke().body.data;
  assert.equal(
    result.signature,
    sdk.utils.api_sign_request(result.params, "server-secret"),
  );
});

test("signature endpoint is authenticated and reachable before upload-id routes", async () => {
  const express = require("express");
  const controller = setup();
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "../routes/uploadRoutes.js"), "utf8"),
    {
      module,
      require: (name) =>
        ({
          express,
          "express-rate-limit": require("express-rate-limit"),
          "../controllers/uploadSignatureController": {
            createUploadSignature: (req, res) =>
              res.status(200).json(controller.invoke(req.user).body),
          },
          "../controllers/uploadController": {
            uploadFile: (_req, res) => res.sendStatus(201),
            getUpload: (_req, res) => res.sendStatus(404),
            deleteUpload: (_req, res) => res.sendStatus(204),
          },
          "../services/uploadService": {
            uploadMiddleware: { single: () => (_req, _res, next) => next() },
          },
          "../middleware/authMiddleware": {
            protectOnboarding: (req, res, next) => {
              if (req.headers.authorization !== "Bearer test-token")
                return res.status(401).json({ message: "Sign in" });
              req.user = { id: "driver" };
              next();
            },
          },
        })[name],
    },
  );
  const app = express();
  app.use("/api/uploads", module.exports);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/uploads/signature`;
    assert.equal((await fetch(url, { method: "POST" })).status, 401);
    const result = await fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer test-token" },
    });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).data.cloudName, "test");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
