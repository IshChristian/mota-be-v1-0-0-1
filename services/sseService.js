// services/sseService.js
// Server-Sent Events hub. Every signed-in app (passenger or driver) may hold
// one or more streams; events are written to all streams of the target user.

const clients = new Map(); // userId -> Set<res>

const addClient = (userId, res, req) => {
    const key = String(userId);
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    });
    res.write(`data: ${JSON.stringify({ status: "connected" })}\n\n`);
    if (!clients.has(key)) clients.set(key, new Set());
    clients.get(key).add(res);
    // Comment frames keep Render/Nginx from closing idle connections.
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 25000);
    heartbeat.unref?.();
    (req || res).on("close", () => {
        clearInterval(heartbeat);
        clients.get(key)?.delete(res);
        if (clients.get(key)?.size === 0) clients.delete(key);
    });
};

const sendEventToUser = (userId, eventName, payload) => {
    if (!userId) return 0;
    const set = clients.get(String(userId));
    if (!set) return 0;
    const frame = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of set) res.write(frame);
    return set.size;
};

// Kept for existing callers.
const sendEventToDriver = sendEventToUser;
const isConnected = (userId) => (clients.get(String(userId))?.size || 0) > 0;

module.exports = {
    addClient,
    sendEventToUser,
    sendEventToDriver,
    isConnected,
};
