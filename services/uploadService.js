const cloudinary = require("cloudinary").v2;
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const multer = require("multer");
const Upload = require("../models/Upload");

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: "mota_uploads",
        allowed_formats: ["jpg", "png", "jpeg", "pdf"],
    },
});

const uploadMiddleware = multer({ storage: storage });

const saveUploadRecord = async (userId, fileData) => {
    return await Upload.create({
        userId,
        url: fileData.path,
        publicId: fileData.filename,
        format: fileData.format || (fileData.mimetype ? fileData.mimetype.split("/")[1] : "unknown"),
        resourceType: fileData.resource_type || "image",
        size: fileData.size,
    });
};

const getUploadById = async (id) => {
    return await Upload.findById(id);
};

const deleteUpload = async (id) => {
    const upload = await Upload.findById(id);
    if (!upload) return null;

    try {
        await cloudinary.uploader.destroy(upload.publicId);
    } catch (e) {
        console.error("Cloudinary destroy error:", e);
    }

    await upload.deleteOne();
    return true;
};

module.exports = {
    cloudinary,
    uploadMiddleware,
    saveUploadRecord,
    getUploadById,
    deleteUpload,
};
