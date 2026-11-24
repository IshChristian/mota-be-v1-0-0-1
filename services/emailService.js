// Every email goes through nodemailer. Routes are tried in order until one delivers:
// Brevo's HTTPS API when BREVO_API_KEY is set, the configured SMTP port, then the
// provider's other ports. (Render's free services block 25, 465 and 587, not 2525 or HTTPS.)
const nodemailer = require("nodemailer");

const ALTERNATE_PORTS = [
    [/(^|\.)gmail\.com$/i, [587, 465]],
    [/(^|\.)brevo\.com$|(^|\.)sendinblue\.com$|(^|\.)mailgun\.org$|(^|\.)sendgrid\.net$|(^|\.)postmarkapp\.com$|(^|\.)smtp2go\.com$/i, [587, 2525]],
];
// Could not talk to the server at all: worth trying another route.
// (A wrong password or refused recipient fails the same way everywhere.)
const UNREACHABLE = new Set(["ETIMEDOUT", "ECONNECTION", "ESOCKET", "EDNS", "ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH"]);

const host = () => process.env.SMTP_HOST || "smtp.gmail.com";

const fromAddress = () => {
    const configured = process.env.SMTP_FROM_EMAIL || "MOTA <no-reply@mota.rw>";
    // Gmail only sends as the signed-in account (it rewrites anything else, which hurts delivery).
    if (!process.env.BREVO_API_KEY && /(^|\.)gmail\.com$/i.test(host()) && process.env.SMTP_USER) return { name: "MOTA", address: process.env.SMTP_USER };
    const match = configured.match(/^\s*"?(.*?)"?\s*<(.+)>\s*$/);
    return match ? { name: match[1] || "MOTA", address: match[2] } : { name: "MOTA", address: configured.trim() };
};

/** A nodemailer transport that hands the message to Brevo over HTTPS. */
const brevoTransport = {
    name: "brevo-https",
    version: "1.0.0",
    send(mail, callback) {
        const { from, to, subject, text, html } = mail.data;
        fetch("https://api.brevo.com/v3/smtp/email", {
            method: "POST",
            headers: { "api-key": process.env.BREVO_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ sender: { name: from.name, email: from.address }, to: [{ email: to }], subject, ...(html ? { htmlContent: html } : {}), ...(text ? { textContent: text } : {}) }),
            signal: AbortSignal.timeout(8000),
        }).then(async (response) => {
            if (!response.ok) throw new Error(`Brevo refused the email (${response.status}): ${await response.text()}`);
            callback(null, { accepted: [to], rejected: [] });
        }).catch((error) => callback(error));
    },
};

const smtpRoute = (port, secure) => ({
    name: `smtp ${host()}:${port}`,
    create: () => nodemailer.createTransport({
        host: host(),
        port,
        secure,
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
        // Two SMTP routes must both be able to fail inside the app's 30 s request timeout.
        dnsTimeout: 3000,
        connectionTimeout: 6000,
        greetingTimeout: 6000,
        socketTimeout: 10000,
    }),
});

let lastGood = null;

const routes = () => {
    const list = [];
    if (process.env.BREVO_API_KEY) list.push({ name: "brevo https", create: () => nodemailer.createTransport(brevoTransport) });
    const port = Number(process.env.SMTP_PORT) || 587;
    list.push(smtpRoute(port, process.env.SMTP_SECURE === "true" || port === 465));
    const others = ALTERNATE_PORTS.find(([pattern]) => pattern.test(host()))?.[1] || [];
    for (const other of others) if (other !== port) { list.push(smtpRoute(other, other === 465)); break; }
    // The route that worked last time goes first, so a blocked port is not retried for every email.
    return list.sort((a, b) => Number(b.name === lastGood) - Number(a.name === lastGood));
};

/** Never throws: returns false when the email was not sent. */
const sendEmail = async (to, subject, text, html) => {
    for (const route of routes()) {
        const transport = route.create();
        try {
            await transport.sendMail({ from: fromAddress(), to, subject, text, html });
            lastGood = route.name;
            return true;
        } catch (error) {
            console.error(`Email not sent over ${route.name}:`, error.code || "", error.message);
            if (!route.name.startsWith("brevo") && !UNREACHABLE.has(error.code)) return false;
        } finally { transport.close(); }
    }
    return false;
};

/** Which routes this server can use, without sending anything. Never includes credentials. */
const checkEmail = async () => Promise.all(routes().map(async (route) => {
    if (route.name.startsWith("brevo")) {
        try {
            const response = await fetch("https://api.brevo.com/v3/account", { headers: { "api-key": process.env.BREVO_API_KEY }, signal: AbortSignal.timeout(8000) });
            return { route: route.name, ok: response.ok, ...(response.ok ? {} : { error: `HTTP ${response.status}` }) };
        } catch (error) { return { route: route.name, ok: false, error: error.message }; }
    }
    const transport = route.create();
    try { await transport.verify(); return { route: route.name, ok: true }; }
    catch (error) { return { route: route.name, ok: false, error: [error.code, error.message].filter(Boolean).join(": ") }; }
    finally { transport.close(); }
}));

module.exports = { sendEmail, checkEmail };
