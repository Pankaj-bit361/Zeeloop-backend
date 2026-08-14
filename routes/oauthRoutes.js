const express = require("express");
const authFunctions = require("../functions/auth/authFunctions");
const generalFunctions = require("../functions/utilFunctions/generalFunctions");
const sessionFunctions = require("../functions/utilFunctions/sessionFunctions");
const config = require("../config/config");

// Mounted at the server root, not under /api — these paths are registered as
// redirect URIs with Google and GitHub, so they are fixed strings that must
// match character for character:
//
//   ${API_URL}/auth/google/callback
//   ${API_URL}/auth/github/callback
//
// No CORS is applied: every hop here is a top-level browser navigation, not a
// fetch from the dashboard origin.
const router = express.Router();

// A provider failure must never surface as a JSON 500 — the browser is mid
// redirect and would render raw JSON. Everything lands back on /login with a
// reason the page can explain.
function bounceToLogin(res, reason) {
    return res.redirect(`${config.APP_URL}/login?error=${reason}`);
}

router.get("/google", (req, res) => {
    try {
        const { url, state } = authFunctions.googleAuthorize();
        if (state) sessionFunctions.setOAuthStateCookie(res, state);
        return res.redirect(url);
    } catch (error) {
        console.error("OAuth router /google catch block");
        console.error(error);
        generalFunctions.captureSentryException(error);
        return bounceToLogin(res, "google");
    }
});

router.get("/google/callback", async (req, res) => {
    try {
        const result = await authFunctions.googleCallback({
            code: req.query.code,
            state: req.query.state,
            expectedState: req.cookies && req.cookies[config.OAUTH_STATE_COOKIE],
        });
        sessionFunctions.clearOAuthStateCookie(res);
        if (result.accountId) sessionFunctions.setSessionCookie(res, result.accountId);
        return res.redirect(result.redirectUrl);
    } catch (error) {
        console.error("OAuth router /google/callback catch block");
        console.error(error);
        generalFunctions.captureSentryException(error);
        return bounceToLogin(res, "google");
    }
});

router.get("/github", (req, res) => {
    try {
        const { url, state } = authFunctions.githubAuthorize();
        if (state) sessionFunctions.setOAuthStateCookie(res, state);
        return res.redirect(url);
    } catch (error) {
        console.error("OAuth router /github catch block");
        console.error(error);
        generalFunctions.captureSentryException(error);
        return bounceToLogin(res, "github");
    }
});

router.get("/github/callback", async (req, res) => {
    try {
        const result = await authFunctions.githubCallback({
            code: req.query.code,
            state: req.query.state,
            expectedState: req.cookies && req.cookies[config.OAUTH_STATE_COOKIE],
        });
        sessionFunctions.clearOAuthStateCookie(res);
        if (result.accountId) sessionFunctions.setSessionCookie(res, result.accountId);
        return res.redirect(result.redirectUrl);
    } catch (error) {
        console.error("OAuth router /github/callback catch block");
        console.error(error);
        generalFunctions.captureSentryException(error);
        return bounceToLogin(res, "github");
    }
});

module.exports = router;
