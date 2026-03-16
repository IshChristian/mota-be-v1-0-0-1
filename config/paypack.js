const PaypackJs = require("paypack-js").default;

const paypack = PaypackJs.config({
    client_id: process.env.PAYPACK_CLIENT_ID || "",
    client_secret: process.env.PAYPACK_CLIENT_SECRET || "",
});

module.exports = paypack;
