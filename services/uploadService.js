const cloudinary = require("cloudinary").v2;
const multer = require("multer");
const Upload = require("../models/Upload");

const configuration = {
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
};
// Preserve CLOUDINARY_URL configuration when individual environment variables are absent.
cloudinary.config(Object.fromEntries(Object.entries(configuration).filter(([, value]) => value)));

const multipart = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
const uploadBuffer = (file, field) => new Promise((resolve, reject) => {
    const config = cloudinary.config();
    if (!config.cloud_name || !config.api_key || !config.api_secret) {
        const error = new Error("Upload storage is not configured. Please contact support.");
        error.status = 503;
        return reject(error);
    }
    const stream = cloudinary.uploader.upload_stream({
        folder: "mota_uploads",
        resource_type: field === "avatar" ? "image" : "auto",
        timeout: 90000,
    }, (error, result) => {
        if (error) return reject(error);
        if (!result?.public_id || !/^https:\/\//i.test(result.secure_url || "")) {
            return reject(new Error("Cloudinary did not return a secure file URL."));
        }
        resolve({
            path: result.secure_url,
            filename: result.public_id,
            format: result.format || file.originalname?.split(".").pop() || "unknown",
            resource_type: result.resource_type,
            size: result.bytes,
        });
    });
    stream.on("error", reject);
    stream.end(file.buffer);
});

// Keep the existing routes' .single(field) interface, but wait for Cloudinary before continuing.
const uploadMiddleware = {
    single: (field) => (req, res, next) => {
        const finish = async (error) => {
            if (error) {
                const tooLarge = error.code === "LIMIT_FILE_SIZE";
                return res.status(tooLarge ? 413 : 400).json({ message: tooLarge ? "Choose a file smaller than 20 MB." : "Upload one file using the correct upload field." });
            }
            if (!req.file) return next();
            if (!req.file.buffer?.length) return res.status(400).json({ message: "This file is empty. Choose another file." });
            try {
                const result = await uploadBuffer(req.file, field);
                delete req.file.buffer;
                Object.assign(req.file, result);
                return next();
            } catch (failure) {
                delete req.file.buffer;
                console.error("Cloudinary upload failed", { code: failure.http_code || failure.status || 502 });
                const status = failure.status === 503 ? 503 : failure.http_code === 400 ? 400 : 502;
                const message = status === 503 ? "Upload storage is not configured. Please contact support." : status === 400 ? "Cloudinary could not accept this file. Try another image or document." : "Cloudinary upload failed. Please check your connection and retry.";
                return res.status(status).json({ message });
            }
        };
        if (req.is?.("application/json")) {
            const value = req.body?.fileBase64;
            if (req.body?.fieldName !== field || typeof value !== "string" || !value.length || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
                return res.status(400).json({ message: "The selected image data is invalid. Select it again." });
            }
            if (value.length > Math.ceil(20 * 1024 * 1024 / 3) * 4) return res.status(413).json({ message: "Choose a file smaller than 20 MB." });
            const buffer = Buffer.from(value, "base64");
            if (buffer.length > 20 * 1024 * 1024) return res.status(413).json({ message: "Choose a file smaller than 20 MB." });
            req.file = { buffer, originalname: req.body.fileName || "image.jpg", mimetype: "image/jpeg" };
            return finish();
        }
        return multipart.single(field)(req, res, finish);
    },
};

const saveUploadRecord = async (userId, fileData) => {
    if (!fileData.filename || !/^https:\/\//i.test(fileData.path || "")) throw new Error("No confirmed Cloudinary upload was returned.");
    return Upload.create({
        userId, url: fileData.path, publicId: fileData.filename,
        format: fileData.format, resourceType: fileData.resource_type || "image", size: fileData.size,
    });
};
const getUploadById = async (id) => Upload.findById(id);
const deleteUpload = async (id) => {
    const upload = await Upload.findById(id);
    if (!upload) return null;
    await cloudinary.uploader.destroy(upload.publicId, { resource_type: upload.resourceType || "image" });
    await upload.deleteOne();
    return true;
};
module.exports = { cloudinary, uploadMiddleware, saveUploadRecord, getUploadById, deleteUpload };
