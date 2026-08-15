const Org = require("../models/org/org");
const generalFunctions = require("../functions/utilFunctions/generalFunctions");
const securityFunctions = require("../functions/security/securityFunctions");

// §8.4 — origin allowlist per workspace, so a stolen embed id cannot be used
// from another domain.
//
// Mounted on the whole widget router rather than inside individual handlers, so
// a route added later is covered by default instead of by remembering — same
// reasoning as widgetRateLimit.
//
// Fails OPEN in every ambiguous case, deliberately:
//   - enforcement not enabled       → allow
//   - allowlist empty               → allow
//   - no publicKey on the request   → allow (the handler will reject it anyway)
//   - the lookup threw              → allow
//
// This is a hardening measure against a leaked publicKey, not an authentication
// boundary. The real boundaries are the org JWT for the dashboard and the HMAC
// signature for identity. Failing closed here would mean a database blip takes
// down every customer's support widget to defend against a threat that requires
// someone to have already scraped a key.

function _publicKey(req) {
    return req.body && req.body.publicKey ? req.body.publicKey : req.query.publicKey || null;
}

async function enforceOriginAllowlist(req, res, next) {
    try {
        const publicKey = _publicKey(req);
        if (!publicKey) return next();

        const org = await Org.findOne({ publicKey }).select("orgId widget").lean();
        if (!org) return next();

        const verdict = securityFunctions.isOriginAllowed({ org, origin: req.get("origin") });
        if (verdict.allowed) return next();

        console.log("originAllowlist: refused orgId:", org.orgId, "origin:", req.get("origin"));
        return res.status(403).json({
            success: false,
            error: "This site is not authorised to use this workspace's widget",
            reason: "ORIGIN_NOT_ALLOWED",
        });
    } catch (error) {
        console.error("originAllowlist: Catch block");
        console.error(error);
        generalFunctions.captureException(error);
        // See the header note: an error here must not take the widget down.
        return next();
    }
}

module.exports = { enforceOriginAllowlist };
