// services/sseService.js
// Basic Server-Sent Events (SSE) Manager

const clients = new Map();

/**
 * Add a new SSE client
 * @param {string} driverId 
 * @param {Response} res 
 */
const addClient = (driverId, res) => {
    // Set headers for SSE
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
    });

    res.write(`data: ${JSON.stringify({ status: "connected" })}\n\n`);

    clients.set(driverId, res);

    // Remove client on disconnect
    res.on("close", () => {
        clients.delete(driverId);
    });
};

/**
 * Broadcast an event to a specific driver via SSE
 * @param {string} driverId 
 * @param {string} eventName 
 * @param {object} payload 
 */
const sendEventToDriver = (driverId, eventName, payload) => {
    const res = clients.get(driverId.toString());
    if (res) {
        res.write(`event: ${eventName}\n`);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
};

module.exports = {
    addClient,
    sendEventToDriver
};
