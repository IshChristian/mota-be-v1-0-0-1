const searchService = require("../services/searchService");

const getUniversalSearch = async (req, res) => {
    try {
        const { q } = req.query;
        if (!q) {
            return res.status(400).json({ message: "Search query 'q' is required" });
        }
        
        const results = await searchService.universalSearch(q);
        res.status(200).json({ data: results });
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

const searchUsers = async (req, res) => {
    try {
        const { q } = req.query;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;

        if (!q) {
            return res.status(400).json({ message: "Search query 'q' is required" });
        }

        const result = await searchService.searchUsers(q, page, limit);
        res.status(200).json(result);
    } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
    }
};

module.exports = {
    getUniversalSearch,
    searchUsers,
};
