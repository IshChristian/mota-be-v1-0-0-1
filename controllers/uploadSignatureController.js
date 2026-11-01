const { randomUUID } = require("node:crypto");
const { cloudinary } = require("../services/uploadService");

// Sign server-owned parameters only. Never accept client supplied signing options.
const createUploadSignature = (req, res) => {
  res.set("Cache-Control", "no-store");
  const config = cloudinary.config();
  if (!config.cloud_name || !config.api_key || !config.api_secret) {
    return res
      .status(503)
      .json({
        message:
          "Upload storage is not configured on the MOTA server. Configure CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET, then restart the backend.",
      });
  }
  const userId = String(req.user?.id || req.user?._id || "");
  if (!/^[a-zA-Z0-9_-]+$/.test(userId))
    return res.status(401).json({ message: "Sign in again to upload files." });
  const params = {
    timestamp: Math.floor(Date.now() / 1000),
    folder: `mota_uploads/${userId}`,
    public_id: randomUUID(),
    overwrite: false,
  };
  try {
    const signature = cloudinary.utils.api_sign_request(
      params,
      config.api_secret,
    );
    return res
      .status(200)
      .json({
        data: {
          cloudName: config.cloud_name,
          apiKey: config.api_key,
          signature,
          params,
        },
      });
  } catch {
    return res
      .status(503)
      .json({
        message:
          "Could not authorize file upload. Please retry or contact support.",
      });
  }
};
module.exports = { createUploadSignature };
