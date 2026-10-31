// Emergency contacts (SOS texts all of them) and saved places (Home, Work, …).
const User = require("../models/User");
const Ride = require("../models/Ride");
const { normalizeRwandaPhone } = require("../utils/rwandaPhone");

const loadUser = (id) => User.findById(id).select("emergencyContacts emergencyContactName emergencyContactPhone savedPlaces phone");

/** Keep the single legacy fields equal to the first contact for older app versions and the admin panel. */
function mirrorFirstContact(user) {
    const first = user.emergencyContacts[0];
    user.emergencyContactName = first?.name;
    user.emergencyContactPhone = first?.phone;
}

/** Older accounts have only the single legacy contact; surface it as the first list entry. */
function withLegacyContact(user) {
    if (!user.emergencyContacts.length && user.emergencyContactPhone) {
        user.emergencyContacts.push({ name: user.emergencyContactName || "Emergency contact", phone: user.emergencyContactPhone });
    }
}

exports.listContacts = async (req, res) => {
    const user = await loadUser(req.user.id);
    withLegacyContact(user);
    res.json({ data: user.emergencyContacts });
};

exports.addContact = async (req, res) => {
    try {
        const phone = normalizeRwandaPhone(req.body.phone);
        const name = String(req.body.name || "").trim();
        if (!name || !phone) return res.status(400).json({ message: "Name and a valid Rwandan phone number are required." });
        const user = await loadUser(req.user.id);
        withLegacyContact(user);
        if (normalizeRwandaPhone(user.phone) === phone) return res.status(400).json({ message: "Add someone other than yourself." });
        if (user.emergencyContacts.some((c) => c.phone === phone)) return res.status(409).json({ message: "This contact is already saved." });
        if (user.emergencyContacts.length >= 5) return res.status(400).json({ message: "You can save up to 5 emergency contacts." });
        user.emergencyContacts.push({ name: name.slice(0, 80), phone, relationship: req.body.relationship ? String(req.body.relationship).slice(0, 40) : undefined });
        mirrorFirstContact(user);
        await user.save();
        res.status(201).json({ data: user.emergencyContacts });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

exports.removeContact = async (req, res) => {
    const user = await loadUser(req.user.id);
    withLegacyContact(user);
    user.emergencyContacts = user.emergencyContacts.filter((c) => String(c._id) !== req.params.contactId);
    mirrorFirstContact(user);
    await user.save();
    res.json({ data: user.emergencyContacts });
};

exports.listPlaces = async (req, res) => {
    const user = await loadUser(req.user.id);
    // Recent = last distinct destinations of completed rides.
    const recent = await Ride.aggregate([
        { $match: { passengerId: user._id, rideStatus: "completed", "destination.latitude": { $exists: true } } },
        { $sort: { createdAt: -1 } },
        { $limit: 50 },
        { $group: { _id: { $ifNull: ["$destination.name", "$destination.address"] }, place: { $first: "$destination" }, lastUsed: { $first: "$createdAt" } } },
        { $sort: { lastUsed: -1 } },
        { $limit: 5 },
    ]);
    res.json({
        data: {
            saved: user.savedPlaces,
            recent: recent.map((r) => ({ name: r.place.name || r.place.address, address: r.place.address, latitude: r.place.latitude, longitude: r.place.longitude })),
        },
    });
};

exports.savePlace = async (req, res) => {
    try {
        const latitude = Number(req.body.latitude), longitude = Number(req.body.longitude);
        const label = String(req.body.label || "").trim(), name = String(req.body.name || "").trim();
        if (!label || !name || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
            return res.status(400).json({ message: "Label, name and valid coordinates are required." });
        }
        const user = await loadUser(req.user.id);
        const existing = user.savedPlaces.find((p) => p.label.toLowerCase() === label.toLowerCase());
        if (existing) Object.assign(existing, { name, latitude, longitude });
        else user.savedPlaces.push({ label, name, latitude, longitude });
        await user.save();
        res.status(existing ? 200 : 201).json({ data: user.savedPlaces });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

exports.removePlace = async (req, res) => {
    const user = await loadUser(req.user.id);
    user.savedPlaces = user.savedPlaces.filter((p) => String(p._id) !== req.params.placeId);
    await user.save();
    res.json({ data: user.savedPlaces });
};
