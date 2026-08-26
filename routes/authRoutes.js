const express = require("express");
const geoFunctions = require("../functions/utilFunctions/geoFunctions");
const authFunctions = require("../functions/auth/authFunctions");
const generalFunctions = require("../functions/utilFunctions/generalFunctions");
const sessionFunctions = require("../functions/utilFunctions/sessionFunctions");
const { reqSessionAuth } = require("../middlewares/auth");

// Dashboard session surface, mounted at /api/auth. The OAuth redirect round-trip
// lives in oauthRoutes.js at the server root, because the callback path is
// registered with Google and GitHub and cannot carry an /api prefix.
//
// Routes stay thin: the cookie side effects live here because they need the
// Express `res`, everything else is authFunctions'.
const router = express.Router();

function fail(req, res, error) {
    console.error(`Auth router ${req.path} catch block`);
    console.error(error);
    generalFunctions.captureException(error);
    return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
}

router.get("/config", async (req, res) => {
    try {
        const { status, json } = await authFunctions.getConfig();
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/signup", async (req, res) => {
    try {
        const result = await authFunctions.signup(req.body);
        if (!result.json.success) return res.status(result.status).json(result.json);
        sessionFunctions.setSessionCookie(res, result.json.data.accountId);
        return res.status(result.status).json({ success: true, data: { ok: true } });
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/login", async (req, res) => {
    try {
        const result = await authFunctions.login(req.body);
        if (!result.json.success) return res.status(result.status).json(result.json);
        sessionFunctions.setSessionCookie(res, result.json.data.accountId);
        return res.status(200).json({ success: true, data: { ok: true } });
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/logout", async (req, res) => {
    try {
        sessionFunctions.clearSessionCookie(res);
        const { status, json } = await authFunctions.logout();
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.get("/me", reqSessionAuth, async (req, res) => {
    try {
        const { status, json } = await authFunctions.me({ account: req.account });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.patch("/me", reqSessionAuth, async (req, res) => {
    try {
        const { status, json } = await authFunctions.updateMe({ account: req.account, name: req.body.name });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

// Exchange the session for an org-scoped Bearer token. The membership check
// lives in mintOrgToken.
router.post("/token", reqSessionAuth, async (req, res) => {
    try {
        const { status, json } = await authFunctions.mintOrgToken({ account: req.account, orgId: req.body.orgId });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

// The workspaces this account can open. Same data as /me's `orgs`, split out so
// the switcher can refetch without re-reading the identity.
router.get("/orgs", reqSessionAuth, async (req, res) => {
    try {
        const { status, json } = await authFunctions.me({ account: req.account });
        if (!json.success) return res.status(status).json(json);
        return res.status(200).json({ success: true, data: json.data.orgs, total: json.data.orgs.length });
    } catch (error) {
        return fail(req, res, error);
    }
});

// Onboarding — creates the workspace and its owner seat.
router.post("/orgs", reqSessionAuth, async (req, res) => {
    try {
        const { status, json } = await authFunctions.createOrg({
            account: req.account,
            name: req.body.name,
            website: req.body.website,
            country: geoFunctions.countryFromRequest(req),
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/forgot-password", async (req, res) => {
    try {
        const { status, json } = await authFunctions.forgotPassword(req.body);
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/reset-password", async (req, res) => {
    try {
        const result = await authFunctions.resetPassword(req.body);
        if (!result.json.success) return res.status(result.status).json(result.json);
        // A completed reset signs you in — the alternative is bouncing someone
        // who just proved control of the address back to the login form.
        sessionFunctions.setSessionCookie(res, result.json.data.accountId);
        return res.status(200).json({ success: true, data: { ok: true } });
    } catch (error) {
        return fail(req, res, error);
    }
});

// Dev-only, and it says so in the function. Kept for the API test harness.
router.post("/dev-login", async (req, res) => {
    try {
        const { status, json } = await authFunctions.devLogin({ orgId: req.body.orgId });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

module.exports = router;
