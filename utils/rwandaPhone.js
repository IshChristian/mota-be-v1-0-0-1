// Same rules as the mobile app (utils/rwandaPhone.ts): returns "+2507XXXXXXXX" or "".
const normalizeRwandaPhone = (value) => {
    const digits = String(value || "").replace(/\D/g, "");
    const local = digits.startsWith("250") ? digits.slice(3, 12) : digits.startsWith("0") ? digits.slice(1, 10) : digits.slice(0, 9);
    return local.length === 9 && local.startsWith("7") ? `+250${local}` : "";
};

module.exports = { normalizeRwandaPhone };
