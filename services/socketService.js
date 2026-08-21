const socketIo = require("socket.io");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Ride = require("../models/Ride");
const rideEngineService = require("./rideEngineService");

let io;

const initSocket = (server) => {
    io = socketIo(server, {
        cors: {
            origin: "*",
            methods: ["GET", "POST"],
        },
    });

    // ── Authentication Middleware ──
    io.use((socket, next) => {
        const token = socket.handshake.auth.token || socket.handshake.query.token;
        if (!token) {
            return next(new Error("Authentication error: No token provided"));
        }

        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET || "default_secret_for_development");
            socket.user = decoded; // { id, role }
            next();
        } catch (err) {
            return next(new Error("Authentication error: Invalid token"));
        }
    });

    io.on("connection", (socket) => {
        console.log(`[Socket] User connected: ${socket.user.id} (${socket.user.role})`);

        // Join personal room for private notifications
        socket.join(`user_${socket.user.id}`);

        // If driver, allow location updates
        if (socket.user.role === "driver") {
            socket.on("updateLocation", async (data) => {
                try {
                    const { latitude, longitude, heading, speed } = data;
                    if (latitude && longitude) {
                        // Update DB (can be debounced/throttled if needed)
                        await rideEngineService.updateDriverLocation(
                            socket.user.id, latitude, longitude, heading, speed
                        );

                        // If driver is in an active ride, broadcast to passenger
                        const activeRide = await rideEngineService.getDriverActiveRide(socket.user.id);
                        if (activeRide && activeRide.passengerId) {
                            io.to(`user_${activeRide.passengerId._id}`).emit("driverLocation", {
                                driverId: socket.user.id,
                                latitude,
                                longitude,
                                heading,
                                speed,
                                rideId: activeRide._id,
                                status: activeRide.rideStatus,
                            });
                        }
                    }
                } catch (error) {
                    console.error("[Socket] Update location error:", error.message);
                }
            });
            
            // Allow drivers to toggle online/offline via socket too
            socket.on("setAvailability", async (data) => {
               try {
                   await rideEngineService.setDriverAvailability(socket.user.id, data.isOnline);
                   socket.emit("availabilityUpdated", { isOnline: data.isOnline });
               } catch (error) {
                   socket.emit("error", { message: error.message });
               }
            });
        }
        
        // Passengers can join a specific ride room to get updates
        if (socket.user.role === "user" || socket.user.role === "passenger") {
             socket.on("joinRide", async (data) => {
                 const { rideId } = data;
                 if (rideId) {
                     // Verify they own the ride
                     const ride = await Ride.findById(rideId);
                     if (ride && ride.passengerId.toString() === socket.user.id) {
                         socket.join(`ride_${rideId}`);
                         console.log(`[Socket] Passenger ${socket.user.id} joined ride_${rideId}`);
                     }
                 }
             });
        }

        socket.on("disconnect", () => {
            console.log(`[Socket] User disconnected: ${socket.user.id}`);
            // Optionally, mark driver offline if they disconnect (requires robust reconnection logic)
        });
    });

    return io;
};

const getIo = () => {
    if (!io) {
        throw new Error("Socket.io not initialized!");
    }
    return io;
};

module.exports = {
    initSocket,
    getIo,
};
