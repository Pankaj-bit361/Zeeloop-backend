const jwt = require("jsonwebtoken");
const config = require("../config/config");
const Account = require("../models/user/account");
const generalFunctions = require("../functions/utilFunctions/generalFunctions");
const sessionFunctions = require("../functions/utilFunctions/sessionFunctions");
const Member = require("../models/org/member");
const { MemberRole, MemberStatus } = require("../config/enums");

/* Org auth: Bearer JWT whose orgId must match the path orgId.

   §8.6 — the seat is re-checked on every request, not merely at mint time.

   The comment that used to sit here said possession of a valid token "already
   means the holder had a seat when it was issued", which is true and was the
   whole problem: tokens live seven days, so removing someone from a workspace
   left them full access for up to a week. Offboarding is a first-month
   operation for any business customer, and it did nothing.

   That is one indexed lookup on (orgId, email) — a unique index — per request.
   Worth it: the alternative is either a token short enough to be annoying or a
   revocation list, and a revocation list is this lookup with extra steps.

   `req.auth.role` is populated here so route guards can use it. Before this,
   MemberRole existed in the enum and appeared at exactly zero authorization
   sites, which meant an invited AGENT could rotate the widget secret, mint API
   keys and cancel the subscription. */
async function reqOrgOwnerAuth(req, res, next) {
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

        const member = await Member.findOne({
            orgId: payload.orgId,
            email: String(payload.email || "").trim().toLowerCase(),
        })
            .select("role status memberId")
            .lean();

        if (!member || member.status !== MemberStatus.ACTIVE) {
            // Deliberately the same shape as an expired token: someone whose
            // access was removed does not need to be told whether the seat is
            // gone or merely suspended.
            return res.status(401).json({ success: false, error: "Invalid or expired token" });
        }

        req.auth = {
            orgId: payload.orgId,
            email: payload.email,
            role: member.role,
            memberId: member.memberId,
        };
        return next();
    } catch (error) {
        console.error("auth:reqOrgOwnerAuth: Catch block");
        console.error(error);
        generalFunctions.captureException(error);
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
        console.error("auth:reqSessionAuth: Catch block");
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
}

/* Route guard for operations that should not be available to every seat.

   Applied to the things whose blast radius is the whole workspace: rotating
   the widget secret (which is the HMAC key proving customer identity), minting
   API keys, changing who has access, moving money, and exporting or erasing
   the conversation corpus. Everything else stays open to any active member,
   because a support agent who cannot do support is not a useful role. */
function requireRole(...roles) {
    return function roleGuard(req, res, next) {
        if (!req.auth || !roles.includes(req.auth.role)) {
            return res.status(403).json({
                success: false,
                error: "Your role does not permit this action",
            });
        }
        return next();
    };
}

const OWNER_OR_ADMIN = [MemberRole.OWNER, MemberRole.ADMIN];

module.exports = { reqOrgOwnerAuth, reqSessionAuth, requireRole, OWNER_OR_ADMIN };
