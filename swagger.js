const swaggerJsdoc = require("swagger-jsdoc");

const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "MOTA API",
      version: "1.0.0",
      description:
        "Mota - Digital platform for moto-taxi drivers in Kigali, Rwanda. Provides ride tracking, performance tiers, daily streak rewards, referral growth, SMS notifications, and admin/agent dashboards.",
      contact: {
        name: "MOTA Support",
      },
    },
    servers: [
      {
        url: "http://localhost:" + (process.env.PORT || 5000),
        description: "Development server",
      },{
	url: "https://mota-be-v1-0-0-1.onrender.com",
        description: "Production server",
	}
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "Enter your JWT token obtained from /api/auth/login",
        },
      },
      schemas: {
        User: {
          type: "object",
          properties: {
            _id: {
              type: "string",
              format: "objectId",
              description: "MongoDB ObjectId",
            },
            firstName: { type: "string", description: "User first name" },
            lastName: { type: "string", description: "User last name" },
            phone: { type: "string", description: "Phone number" },
            nationalId: { type: "string", description: "National ID" },
            role: {
              type: "string",
              enum: ["driver", "agent", "admin"],
              description: "User role",
            },
            isVerified: { type: "boolean" },
            isActive: { type: "boolean" },
            kycLevel: {
              type: "string",
              enum: ["basic", "full"],
            },
            referralCode: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        DriverProfile: {
          type: "object",
          properties: {
            _id: { type: "string" },
            driverId: { type: "string" },
            plateNumber: { type: "string" },
            cooperativeName: { type: "string" },
            nid: { type: "string" },
            insuranceAttachment: { type: "string" },
            permitAttachment: { type: "string" },
            permitId: { type: "string" },
            wallet: { type: "number" },
          },
        },
        Ride: {
          type: "object",
          properties: {
            _id: { type: "string" },
            driverId: { type: "string" },
            passengerPhone: {
              type: "string",
              description: "Normalised Rwandan phone (+2507XXXXXXXX)",
              example: "+250782123456",
            },
            fare: { type: "number", description: "Ride fare in RWF", example: 3000 },
            commissionAmount: { type: "number", example: 300 },
            driverEarning: { type: "number", example: 2700 },
            paymentMethod: {
              type: "string",
              enum: ["momo", "wallet"],
              example: "momo",
            },
            paymentStatus: {
              type: "string",
              enum: ["pending", "completed", "failed"],
              description: "Set to 'completed' only after Paypack webhook confirms payment",
              example: "pending",
            },
            paypackRef: { type: "string", description: "Paypack transaction reference" },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        Tier: {
          type: "object",
          properties: {
            driverId: { type: "string" },
            totalRides: { type: "number" },
            monthlyRides: { type: "number" },
            tier: {
              type: "string",
              enum: ["bronze", "silver", "gold", "platinum"],
            },
            multiplier: { type: "number" },
          },
        },
        Streak: {
          type: "object",
          properties: {
            driverId: { type: "string" },
            currentStreak: { type: "number" },
            longestStreak: { type: "number" },
            todayRideCount: { type: "number" },
            lastRideDate: { type: "string", format: "date-time" },
          },
        },
        Referral: {
          type: "object",
          properties: {
            referrerId: { type: "string" },
            referredUserId: { type: "string" },
            reward: { type: "number" },
            status: {
              type: "string",
              enum: ["pending", "completed"],
            },
          },
        },
        ErrorResponse: {
          type: "object",
          properties: {
            message: { type: "string", description: "Error message" },
          },
        },
      },
    },
    security: [
      {
        bearerAuth: [],
      },
    ],
  },
  apis: ["./routes/*.js", "./index.js"],
};

const swaggerSpec = swaggerJsdoc(options);

module.exports = swaggerSpec;
