const uploadService = require("../services/uploadService");

const uploadFile = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: "No file uploaded" });
        }

        const uploadRecord = await uploadService.saveUploadRecord(req.user.id, req.file);

        res.status(201).json({
            message: "File uploaded successfully",
            data: uploadRecord,
        });
    } catch (error) {
        res.status(500).json({ message: "File upload failed", error: error.message });
    }
};

const getUpload = async (req, res) => {
    try {
        const upload = await uploadService.getUploadById(req.params.id);
        if (!upload) {
            return res.status(404).json({ message: "Upload not found" });
        }
        res.status(200).json({ data: upload });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const deleteUpload = async (req, res) => {
    try {
        const success = await uploadService.deleteUpload(req.params.id);
        if (!success) {
            return res.status(404).json({ message: "Upload not found" });
        }
        res.status(200).json({ message: "File deleted successfully" });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

module.exports = {
    uploadFile,
    getUpload,
    deleteUpload,
};
