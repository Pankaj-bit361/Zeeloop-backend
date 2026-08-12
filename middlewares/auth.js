const jwt = require("jsonwebtoken");
const config = require("../config/config");
const Account = require("../models/user/account");
const generalFunctions = require("../functions/utilFunctions/generalFunctions");
const sessionFunctions = require("../functions/utilFunctions/sessionFunctions");

// Org auth: Bearer JWT whose orgId must match the path orgId. Minted by
// POST /api/auth/token once membership is checked, so possession of a valid
// token here already means the holder had a seat when it was issued.
function reqOrgOwnerAuth(req, res, next) {
    try {
        const header = req.headers.authorization || "";
        const token = header.startsWith("Bearer ") ? header.slice(7) : null;
        if (!token) {
            return res.status(401).json({ success: false, error: "Missing authorization token" });
        }

        let payload;
        try {
            payload = jwt.verify(token, config.JWT_SECRET);
        } catch (error) {
            return res.status(401).json({ success: false, error: "Invalid or expired token" });
        }

        if (!payload.orgId || payload.orgId !== req.params.orgId) {
            return res.status(403).json({ success: false, error: "Token does not grant access to this org" });
        }

        req.auth = { orgId: payload.orgId, email: payload.email };
        return next();
    } catch (error) {
        console.log("auth:reqOrgOwnerAuth: Catch block");
        console.log(error);
        generalFunctions.captureSentryException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
}

// Dashboard sign-in: the HttpOnly session cookie. Answers "who is this", never
// "which org" — that is reqOrgOwnerAuth's job, and keeping them apart is why a
// signed-out user cannot keep using a still-valid org token.
async function reqSessionAuth(req, res, next) {
    try {
        const accountId = sessionFunctions.verifySessionToken(req.cookies && req.cookies[config.SESSION_COOKIE]);
        if (!accountId) {
            return res.status(401).json({ success: false, error: "Not signed in" });
        }

        // Re-read the account on every request rather than trusting the cookie's
        // payload: a deleted account must stop working immediately, not in seven
        // days when its token happens to expire.
        const account = await Account.findOne({ accountId });
        if (!account) {
            return res.status(401).json({ success: false, error: "Not signed in" });
        }

        req.account = account;
        return next();
    } catch (error) {
        console.log("auth:reqSessionAuth: Catch block");
        console.log(error);
        generalFunctions.captureSentryException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
}

module.exports = { reqOrgOwnerAuth, reqSessionAuth };
