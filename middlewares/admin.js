const config = require("../config/config");
const { reqSessionAuth } = require("./auth");

function isAdminEmail(email) {
    return Boolean(email) && config.ADMIN_EMAILS.includes(String(email).trim().toLowerCase());
}

// The admin panel rides the dashboard session cookie, not an org token: staff
// look across every workspace, so no single org's token could describe them.
// A verified account whose email is in ADMIN_EMAILS, and nobody else.
function requireAdmin(req, res, next) {
    return reqSessionAuth(req, res, () => {
        if (!req.account.emailVerifiedAt || !isAdminEmail(req.account.email)) {
            return res.status(403).json({ success: false, error: "This page is for Zealoop staff" });
        }
        req.adminEmail = req.account.email;
        return next();
    });
}

module.exports = { requireAdmin, isAdminEmail };
