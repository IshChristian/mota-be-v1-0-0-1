const mongoose = require("mongoose");
const models = Object.fromEntries(
  [
    "User",
    "Ride",
    "Transaction",
    "Wallet",
    "WithdrawalRequest",
    "Referral",
    "SupportCase",
    "AuditLog",
    "Upload",
    "SmsLog",
    "Session",
    "DriverOfferReceipt",
    "SafetyEvent",
    "RideDispute",
  ].map((name) => [name, require(`../models/${name}`)]),
);
const { effectivePermissions } = require("./reportAccess");
const sections = {
  users: "analytics:users",
  rides: "analytics:rides",
  drivers: "analytics:rides",
  finance: "analytics:finance",
  withdrawals: "analytics:finance",
  referrals: "analytics:operations",
  demand: "analytics:operations",
  support: "analytics:operations",
  documents: "analytics:operations",
  security: "audit:view",
  quality: "analytics:finance",
};
const error = (message, status = 400) => {
  const e = new Error(message);
  e.status = status;
  throw e;
};
function filters(query = {}) {
  const now = new Date(),
    end = query.to ? new Date(`${query.to}T23:59:59.999+02:00`) : now;
  const start = query.from
    ? new Date(`${query.from}T00:00:00.000+02:00`)
    : new Date(end.getTime() - 30 * 86400000);
  for (const value of [query.from, query.to])
    if (
      value &&
      (typeof value !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(+new Date(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value)
    )
      error("Use valid YYYY-MM-DD dates.");
  if (
    !Number.isFinite(+start) ||
    !Number.isFinite(+end) ||
    start > end ||
    end - start > 366 * 86400000
  )
    error("Choose a valid period of at most 366 days.");
  if (
    query.role &&
    ![
      "driver",
      "client",
      "agent",
      "admin",
      "superadmin",
      "financial",
      "caller_support",
      "manager",
      "moderator",
    ].includes(query.role)
  )
    error("Invalid account type.");
  const page = Number(query.page || 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000)
    error("Invalid page.");
  const q = String(query.q || "").trim();
  if (q.length > 100) error("Search must be at most 100 characters.");
  return {
    from: start,
    to: end,
    page,
    q,
    role: query.role || "",
    date: { $gte: start, $lte: end },
  };
}
const safe = (value, sensitive = false, depth = 0) => {
  if (depth > 8) return "[nested value]";
  if (value == null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (value._bsontype) return String(value);
  if (Array.isArray(value))
    return value.slice(0, 200).map((v) => safe(v, sensitive, depth + 1));
  const result = {};
  for (const [key, v] of Object.entries(value)) {
    if (
      /password|secret|token|authorization|cookie|otp|providerEvent|paypackEvent/i.test(
        key,
      )
    )
      result[key] = "[redacted]";
    else if (
      !sensitive &&
      /phone|email|nationalId|^nid$|address|url|ipAddress|firstName|lastName|fullName|emergency|location|description|message|note|reason|attachment|evidence|resolution|comment|contact|plateNumber|permitId/i.test(
        key,
      )
    )
      result[key] = "[restricted]";
    else result[key] = safe(v, sensitive, depth + 1);
  }
  return result;
};
function ensure(user, section, exporting = false) {
  const p = effectivePermissions(user);
  if (!sections[section]) error("Unknown report.", 400);
  if (
    !p.includes(section === "security" ? "audit:view" : "analytics:view") ||
    !p.includes(sections[section]) ||
    (exporting &&
      !p.includes(section === "security" ? "audit:export" : "analytics:export"))
  )
    error("You do not have access to this report.", 403);
}
const group = (field, extra = {}) => ({
  $group: { _id: `$${field}`, count: { $sum: 1 }, ...extra },
});
const trend = (date) => [
  {
    $group: {
      _id: {
        $dateToString: {
          format: "%Y-%m-%d",
          date: `$${date}`,
          timezone: "Africa/Kigali",
        },
      },
      count: { $sum: 1 },
    },
  },
  { $sort: { _id: 1 } },
];
async function aggregate(name, pipeline) {
  return models[name].aggregate(pipeline).option({ maxTimeMS: 15000 });
}
async function summarySection(section, f) {
  const dated = { createdAt: f.date };
  const run = (model, pipeline) => aggregate(model, pipeline);
  const status = (model, field, date = "createdAt") =>
    run(model, [
      { $match: { [date]: f.date } },
      group(field),
      { $sort: { count: -1 } },
    ]);
  if (section === "users") {
    const match = { ...dated, ...(f.role ? { role: f.role } : {}) };
    const [breakdown, daily, funnel, stock] = await Promise.all([
      run("User", [{ $match: match }, group("role")]),
      run("User", [{ $match: match }, ...trend("createdAt")]),
      run("User", [
        { $match: match },
        {
          $group: {
            _id: null,
            registered: { $sum: 1 },
            phoneVerified: { $sum: { $cond: ["$isVerified", 1, 0] } },
            emailVerified: { $sum: { $cond: ["$isEmailVerified", 1, 0] } },
            kycApproved: {
              $sum: { $cond: [{ $eq: ["$kycLevel", "full"] }, 1, 0] },
            },
            active: { $sum: { $cond: ["$isActive", 1, 0] } },
            driverFeesPaid: {
              $sum: {
                $cond: [
                  { $and: [{ $eq: ["$role", "driver"] }, "$registrationPaid"] },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]),
      run("User", [
        { $match: { role: "driver", isActive: true, deletedAt: null } },
        { $count: "count" },
      ]),
    ]);
    return {
      title: "Users and onboarding",
      breakdown,
      daily,
      funnel: funnel[0] || {},
      cards: {
        "New accounts": breakdown.reduce((s, r) => s + r.count, 0),
        "Active drivers now": stock[0]?.count || 0,
      },
      note: "Verification counts are current states for accounts created in this period. Email verification is optional; passenger registration is free. Active drivers is a current snapshot.",
    };
  }
  if (section === "rides") {
    const [breakdown, daily, reasons] = await Promise.all([
      status("Ride", "rideStatus"),
      run("Ride", [{ $match: dated }, ...trend("createdAt")]),
      run("Ride", [
        { $match: { ...dated, rideStatus: "cancelled" } },
        {
          $group: {
            _id: {
              $cond: [
                { $eq: ["$cancelledBy", "$driverId"] },
                "Driver cancelled",
                {
                  $cond: [
                    { $eq: ["$cancelledBy", "$passengerId"] },
                    "Passenger cancelled",
                    "Other / unknown",
                  ],
                },
              ],
            },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);
    return {
      title: "Ride operations",
      breakdown,
      daily,
      reasons,
      cards: {
        "Requests created": breakdown.reduce((s, r) => s + r.count, 0),
        Completed: breakdown.find((r) => r._id === "completed")?.count || 0,
      },
      note: "Grouped by booking creation date and latest ride outcome. Driver-logged rides are labelled separately. Cancellation free text remains restricted.",
    };
  }
  if (section === "drivers") {
    const [ranking, offers] = await Promise.all([
      run("Ride", [
        { $match: { driverId: { $ne: null }, acceptedAt: f.date } },
        {
          $group: {
            _id: "$driverId",
            accepted: { $sum: 1 },
            completed: {
              $sum: { $cond: [{ $eq: ["$rideStatus", "completed"] }, 1, 0] },
            },
            driverCancelled: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$rideStatus", "cancelled"] },
                      { $eq: ["$cancelledBy", "$driverId"] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            earnings: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$rideStatus", "completed"] },
                      { $eq: ["$paymentStatus", "successful"] },
                    ],
                  },
                  { $ifNull: ["$driverEarning", 0] },
                  0,
                ],
              },
            },
          },
        },
        { $sort: { completed: -1 } },
        { $limit: 20 },
      ]),
      run("DriverOfferReceipt", [
        { $match: { receivedAt: f.date } },
        {
          $lookup: {
            from: "rides",
            localField: "rideId",
            foreignField: "_id",
            as: "ride",
          },
        },
        { $unwind: "$ride" },
        {
          $group: {
            _id: null,
            offers: { $sum: 1 },
            accepted: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$driverId", "$ride.driverId"] },
                      { $ne: [{ $ifNull: ["$ride.acceptedAt", null] }, null] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]),
    ]);
    return {
      title: "Driver performance",
      ranking,
      breakdown: ranking.map((r) => ({
        _id: String(r._id),
        count: r.completed,
      })),
      cards: {
        "Tracked offers": offers[0]?.offers || 0,
        "Accepted tracked offers": offers[0]?.accepted || 0,
      },
      note: "Rankings use accepted-at cohorts. Offer rates use app-acknowledged receipt cohorts; historical dispatches are not proof of delivery. Earnings use stored confirmed ride earnings, excluding tips.",
    };
  }
  if (section === "finance") {
    const [breakdown, daily, balances] = await Promise.all([
      run("Transaction", [
        { $match: dated },
        {
          $group: {
            _id: { type: "$type", status: "$status" },
            count: { $sum: 1 },
            amount: { $sum: "$amount" },
            fee: { $sum: "$feeAmount" },
          },
        },
        { $sort: { count: -1 } },
      ]),
      run("Transaction", [
        { $match: { ...dated, status: "successful" } },
        {
          $group: {
            _id: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$createdAt",
                timezone: "Africa/Kigali",
              },
            },
            count: { $sum: 1 },
            amount: { $sum: "$amount" },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      run("Wallet", [
        {
          $group: {
            _id: null,
            available: { $sum: "$balance" },
            held: { $sum: "$heldBalance" },
          },
        },
      ]),
    ]);
    return {
      title: "Financial analysis",
      breakdown: breakdown.map((r) => ({
        ...r,
        _id: `${r._id.type} / ${r._id.status}`,
      })),
      daily,
      cards: {
        "Wallet available now (RWF)": balances[0]?.available || 0,
        "Reserved now (RWF)": balances[0]?.held || 0,
      },
      note: "Transaction signed amounts are wallet movements, not total platform revenue. Commission, registration fees, tips and refunds are shown only where ledger rows exist; deposits and internal transfers are not revenue. Balances are current snapshots.",
    };
  }
  if (section === "withdrawals") {
    const [breakdown, review, wait] = await Promise.all([
      run("WithdrawalRequest", [
        { $match: dated },
        group("status", {
          amount: { $sum: "$amount" },
          fee: { $sum: "$fee" },
          reserved: { $sum: "$totalHeld" },
        }),
      ]),
      status("WithdrawalRequest", "reviewStatus"),
      run("WithdrawalRequest", [
        { $match: { ...dated, status: { $in: ["successful", "failed"] } } },
        {
          $group: {
            _id: null,
            minutes: {
              $avg: {
                $divide: [{ $subtract: ["$updatedAt", "$createdAt"] }, 60000],
              },
            },
          },
        },
      ]),
    ]);
    return {
      title: "Withdrawals",
      breakdown,
      review,
      cards: {
        Requests: breakdown.reduce((s, r) => s + r.count, 0),
        "Mean last-update delay (min)": wait[0]?.minutes == null ? null : Math.round(wait[0].minutes),
      },
      note: "Staff review is separate from provider payout. Delay uses last update minus creation, not a guaranteed provider settlement timestamp.",
    };
  }
  if (section === "referrals") {
    const [breakdown, daily, paid] = await Promise.all([
      status("Referral", "status"),
      run("Referral", [{ $match: dated }, ...trend("createdAt")]),
      run("Transaction", [
        { $match: { ...dated, type: "referral_reward", status: "successful" } },
        {
          $group: {
            _id: null,
            amount: { $sum: "$amount" },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);
    return {
      title: "Referrals",
      breakdown,
      daily,
      cards: {
        Invitations: breakdown.reduce((s, r) => s + r.count, 0),
        "Rewards paid (RWF)": paid[0]?.amount || 0,
      },
      note: "Potential rewards are not wallet payments. Historic pending referrals can require manual ledger review.",
    };
  }
  if (section === "demand") {
    const [cells, hours] = await Promise.all([
      run("Ride", [
        {
          $match: {
            ...dated,
            "pickup.latitude": { $gte: -90, $lte: 90 },
            "pickup.longitude": { $gte: -180, $lte: 180 },
          },
        },
        {
          $group: {
            _id: {
              lat: {
                $divide: [
                  { $floor: { $multiply: ["$pickup.latitude", 100] } },
                  100,
                ],
              },
              lng: {
                $divide: [
                  { $floor: { $multiply: ["$pickup.longitude", 100] } },
                  100,
                ],
              },
            },
            count: { $sum: 1 },
          },
        },
        { $match: { count: { $gte: 5 } } },
        { $sort: { count: -1 } },
        { $limit: 100 },
      ]),
      run("Ride", [
        { $match: dated },
        {
          $group: {
            _id: { $hour: { date: "$createdAt", timezone: "Africa/Kigali" } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
    ]);
    return {
      title: "Demand and locations",
      cells,
      breakdown: hours,
      cards: { "Visible demand cells": cells.length },
      note: "Approximate 0.01-degree pickup cells with at least 5 bookings. No individual locations. Hours use Africa/Kigali. Legacy coordinates absent from latitude/longitude are excluded.",
    };
  }
  if (section === "support") {
    const [breakdown, categories, safety, disputes, delay] = await Promise.all([
      status("SupportCase", "status"),
      status("SupportCase", "category"),
      status("SafetyEvent", "status"),
      status("RideDispute", "status"),
      run("SupportCase", [
        { $match: { ...dated, status: { $in: ["resolved", "closed"] } } },
        {
          $group: {
            _id: null,
            minutes: {
              $avg: {
                $divide: [{ $subtract: ["$updatedAt", "$createdAt"] }, 60000],
              },
            },
          },
        },
      ]),
    ]);
    return {
      title: "Support and safety",
      breakdown,
      categories,
      safety,
      disputes,
      cards: {
        Cases: breakdown.reduce((s, r) => s + r.count, 0),
        "Safety events": safety.reduce((s, r) => s + r.count, 0),
        Disputes: disputes.reduce((s, r) => s + r.count, 0),
        "Mean case last-update delay (min)": delay[0]?.minutes == null ? null : Math.round(delay[0].minutes),
      },
      note: "Recorded support cases, reported safety events and ride disputes. Last-update delay approximates resolution time. This does not measure unrecorded incidents or automated monitoring coverage.",
    };
  }
  if (section === "documents") {
    const [breakdown, driverKyc, passengerKyc] = await Promise.all([
      status("Upload", "format"),
      require("../models/DriverKyc")
        .aggregate([{ $match: dated }, group("status")])
        .option({ maxTimeMS: 15000 }),
      require("../models/PassengerKyc")
        .aggregate([{ $match: dated }, group("status")])
        .option({ maxTimeMS: 15000 }),
    ]);
    return {
      title: "Documents and KYC",
      breakdown,
      driverKyc,
      passengerKyc,
      cards: { "Recorded uploads": breakdown.reduce((s, r) => s + r.count, 0) },
      note: "Direct Cloudinary uploads only appear here when a backend upload record exists. KYC review records are counted separately. Missing upload-failure telemetry is not shown as zero failures.",
    };
  }
  if (section === "security") {
    const [breakdown, daily, delivery] = await Promise.all([
      status("AuditLog", "action", "timestamp"),
      run("AuditLog", [
        { $match: { timestamp: f.date } },
        ...trend("timestamp"),
      ]),
      status("SmsLog", "status", "sentAt"),
    ]);
    return {
      title: "Security and system events",
      breakdown,
      daily,
      delivery,
      cards: {
        "Recorded audit events": breakdown.reduce((s, r) => s + r.count, 0),
      },
      note: "Only persisted events are measurable. New authentication/permission denials start recording after deployment; old unrecorded failures cannot be reconstructed. SMS status is recorded delivery telemetry.",
    };
  }
  if (section === "quality") {
    const [missing, duplicates, balances] = await Promise.all([
      run("Transaction", [
        {
          $match: {
            ...dated,
            status: "successful",
            $or: [{ driverId: null }, { amount: { $exists: false } }],
          },
        },
        { $count: "count" },
      ]),
      run("Transaction", [
        {
          $match: {
            ...dated,
            paypackRef: { $type: "string" },
            type: "cash_in",
          },
        },
        { $group: { _id: "$paypackRef", count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
        { $limit: 100 },
      ]),
      run("Wallet", [
        {
          $lookup: {
            from: "transactions",
            let: { user: "$driverId" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ["$driverId", "$$user"] },
                      { $eq: ["$status", "successful"] },
                    ],
                  },
                },
              },
              { $group: { _id: null, total: { $sum: "$amount" } } },
            ],
            as: "ledger",
          },
        },
        {
          $project: {
            _id: 0,
            userId: "$driverId",
            available: "$balance",
            held: "$heldBalance",
            recordedLedger: {
              $ifNull: [{ $arrayElemAt: ["$ledger.total", 0] }, 0],
            },
          },
        },
        {
          $set: {
            difference: {
              $subtract: [{ $add: ["$available", "$held"] }, "$recordedLedger"],
            },
          },
        },
        { $match: { difference: { $ne: 0 } } },
        { $limit: 100 },
      ]),
    ]);
    return {
      title: "Data quality and reconciliation",
      exceptions: balances,
      duplicates,
      breakdown: [
        {
          _id: "Successful transactions with missing fields",
          count: missing[0]?.count || 0,
        },
        {
          _id: "Repeated deposit provider references",
          count: duplicates.length,
        },
        { _id: "Wallet review candidates (max 100)", count: balances.length },
      ],
      cards: { "Missing-field records": missing[0]?.count || 0 },
      note: "Wallet vs ledger is an all-time screening comparison, capped at 100 candidates. Opening balances, historical missing entries and withdrawal fee conventions can explain differences. These are review candidates, not proven accounting errors.",
    };
  }
}
async function summary(user, query) {
  const f = filters(query),
    allowed = Object.keys(sections).filter((s) => {
      try {
        ensure(user, s);
        return true;
      } catch {
        return false;
      }
    });
  const selected = query.section ? [String(query.section)] : allowed;
  if (query.section) ensure(user, String(query.section));
  const entries = await Promise.all(
    selected.map(async (section) => {
      const report = await summarySection(section, f);
      if (query.compare === "true") {
        const length = f.to - f.from + 1;
        const previous = {
          ...f,
          from: new Date(+f.from - length),
          to: new Date(+f.from - 1),
          date: {
            $gte: new Date(+f.from - length),
            $lte: new Date(+f.from - 1),
          },
        };
        report.previousCards = (await summarySection(section, previous)).cards;
        report.comparisonPeriod = { from: previous.from, to: previous.to };
      }
      return [section, report];
    }),
  );
  return {
    generatedAt: new Date(),
    period: { from: f.from, to: f.to, timezone: "Africa/Kigali" },
    sections: Object.fromEntries(entries),
    available: allowed,
    coverage: [
      "Current states are not historical point-in-time snapshots.",
      "Unrecorded events are unavailable, not assumed zero.",
      "No passwords, tokens, document URLs or individual map coordinates are returned.",
    ],
  };
}
const datasets = {
  users: [
    "User",
    "createdAt",
    "role isActive isVerified isEmailVerified kycLevel registrationPaid registrationStatus createdAt",
  ],
  rides: [
    "Ride",
    "createdAt",
    "driverId passengerId rideStatus paymentStatus fare driverEarning createdAt acceptedAt completedAt cancelledBy",
  ],
  drivers: [
    "Ride",
    "acceptedAt",
    "driverId rideStatus paymentStatus driverEarning acceptedAt completedAt cancelledBy",
  ],
  finance: [
    "Transaction",
    "createdAt",
    "driverId rideId amount feeAmount type status reference createdAt",
  ],
  withdrawals: [
    "WithdrawalRequest",
    "createdAt",
    "driverId amount fee totalHeld status reviewStatus failureReason createdAt updatedAt",
  ],
  referrals: [
    "Referral",
    "createdAt",
    "referrerId referredUserId reward status createdAt rewardedAt",
  ],
  support: [
    "SupportCase",
    "createdAt",
    "customerId driverId rideId category priority status escalated createdAt updatedAt",
  ],
  documents: [
    "Upload",
    "createdAt",
    "userId format resourceType size createdAt",
  ],
  security: [
    "AuditLog",
    "timestamp",
    "actorId actorRole action targetType targetId metadata ipAddress timestamp",
  ],
};
async function records(user, section, query, limit = 50) {
  ensure(user, section);
  const f = filters(query);
  if (!datasets[section])
    return {
      rows: [],
      total: 0,
      page: 1,
      note: "This report is aggregated. Export its summary instead.",
    };
  const [name, date, select] = datasets[section];
  const match = { [date]: f.date };
  if (section === "users" && f.role) match.role = f.role;
  if (query.status) {
    if (typeof query.status !== "string" || !/^\w{1,40}$/.test(query.status))
      error("Invalid status.");
    match[
      section === "rides" || section === "drivers"
        ? "rideStatus"
        : section === "users"
          ? "registrationStatus"
          : "status"
    ] = query.status;
  }
  if (f.q) {
    if (mongoose.isValidObjectId(f.q))
      match.$or = [
        { _id: f.q },
        ...select
          .split(" ")
          .filter((k) => k.endsWith("Id"))
          .map((k) => ({ [k]: f.q })),
      ];
    else if (["finance", "security"].includes(section)) {
      const escaped = f.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      match[section === "security" ? "action" : "reference"] = {
        $regex: escaped,
        $options: "i",
      };
    } else error("Search this list using an exact record or user ID.");
  }
  if (section === "security") {
    for (const key of ["action", "targetType"])
      if (query[key]) {
        if (!/^[\w]{1,80}$/.test(query[key])) error("Invalid audit filter.");
        match[key] = query[key];
      }
    for (const key of ["actorId", "targetId"])
      if (query[key]) {
        if (!mongoose.isValidObjectId(query[key])) error("Invalid audit ID.");
        match[key] = query[key];
      }
  }
  const [rows, total] = await Promise.all([
    models[name]
      .find(match)
      .select(select)
      .sort({ [date]: -1, _id: -1 })
      .skip((f.page - 1) * limit)
      .limit(limit)
      .lean()
      .maxTimeMS(15000),
    models[name].countDocuments(match).maxTimeMS(15000),
  ]);
  return {
    rows: rows.map((row) =>
      safe(
        row,
        section === "security" &&
          effectivePermissions(user).includes("audit:sensitive"),
      ),
    ),
    total,
    page: f.page,
    limit,
    pages: Math.ceil(total / limit),
  };
}
async function investigate(user, type, id, query) {
  if (!effectivePermissions(user).includes("audit:view"))
    error("Audit access required.", 403);
  if (
    !["User", "Ride", "Transaction", "WithdrawalRequest"].includes(type) ||
    !mongoose.isValidObjectId(id)
  )
    error("Invalid investigation target.");
  const oid = new mongoose.Types.ObjectId(id),
    f = filters(query);
  const timeline = await models.AuditLog.find({
    timestamp: f.date,
    $or: [{ targetId: oid }, { actorId: oid }],
  })
    .sort({ timestamp: -1 })
    .limit(200)
    .lean()
    .maxTimeMS(15000);
  const result = {
    timeline: timeline.map((r) =>
      safe(r, effectivePermissions(user).includes("audit:sensitive")),
    ),
    note: "Audit events are capped at 200. Related records require their own report permissions.",
  };
  const p = effectivePermissions(user);
  if (p.includes("analytics:finance"))
    result.transactions = await models.Transaction.find({
      createdAt: f.date,
      $or: [
        { _id: oid },
        { driverId: oid },
        { rideId: oid },
        { reference: String(id) },
      ],
    })
      .select("amount type status driverId rideId createdAt")
      .limit(100)
      .lean()
      .maxTimeMS(15000);
  if (p.includes("analytics:rides"))
    result.rides = await models.Ride.find({
      createdAt: f.date,
      $or: [{ _id: oid }, { driverId: oid }, { passengerId: oid }],
    })
      .select("rideStatus paymentStatus createdAt driverId passengerId")
      .limit(100)
      .lean()
      .maxTimeMS(15000);
  return safe(result, p.includes("audit:sensitive"));
}
module.exports = {
  filters,
  safe,
  ensure,
  sections,
  summary,
  summarySection,
  records,
  investigate,
};
