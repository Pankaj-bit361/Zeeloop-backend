const express = require("express");
const cors = require("cors");
const oauth = require("../functions/mcp/oauthFunctions");
const { reqSessionAuth, reqOrgOwnerAuth, requireRole, OWNER_OR_ADMIN } = require("../middlewares/auth");
const { consumeShared, clientIp } = require("../middlewares/rateLimit");
const general = require("../functions/utilFunctions/generalFunctions");
const config = require("../config/config");
const publicRoutes = express.Router();
const session = express.Router();
const management = express.Router();
const wrap = work => async (req, res, next) => {
    try { await work(req, res, next); }
    catch (error) {
        if (error instanceof oauth.OAuthError) return res.status(error.status).json({ success: false, error: error.oauthError, error_description: error.message });
        general.captureException(error); next(error);
    }
};
const privateResponse = (req, res, next) => { res.setHeader("Cache-Control", "private, no-store"); next(); };
const bodyObject = (req, res, next) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) return res.status(400).json({ error: "invalid_request", error_description: "Provide an object or form body" });
    next();
};
publicRoutes.use(["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource", "/oauth/mcp"], cors({ origin: "*", exposedHeaders: ["WWW-Authenticate"] }), privateResponse);
publicRoutes.get("/.well-known/oauth-authorization-server", (req, res) => res.json(oauth.authorizationMetadata()));
publicRoutes.get(["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"], (req, res) => res.json(oauth.protectedMetadata()));
publicRoutes.use("/oauth/mcp", wrap(async (req, res, next) => {
    if (req.get("host") !== new URL(config.API_URL).host) return res.status(403).json({ error: "invalid_request", error_description: "Untrusted OAuth host" });
    const budget = await consumeShared(`mcp-oauth:ip:${clientIp(req)}`, 120, 60_000);
    if (!budget.allowed) { res.setHeader("Retry-After", String(budget.retryAfterSeconds)); return res.status(429).json({ error: "temporarily_unavailable", error_description: "Too many authorization requests" }); }
    next();
}));
publicRoutes.post("/oauth/mcp/register", bodyObject, wrap(async (req, res) => {
    const budgets = await Promise.all([
        consumeShared(`mcp-oauth:registration:${clientIp(req)}`, 10, 3_600_000),
        consumeShared("mcp-oauth:registration:global", 1000, 3_600_000),
    ]);
    const denied = budgets.find(value => !value.allowed);
    if (denied) { res.setHeader("Retry-After", String(denied.retryAfterSeconds)); return res.status(429).json({ error: "temporarily_unavailable", error_description: "Client registration limit reached" }); }
    res.status(201).json(await oauth.register(req.body));
}));
publicRoutes.get("/oauth/mcp/authorize", wrap(async (req, res) => res.redirect(302, await oauth.startAuthorization(req.query))));
publicRoutes.post("/oauth/mcp/token", bodyObject, wrap(async (req, res) => res.json(await oauth.token(req.body))));
publicRoutes.post("/oauth/mcp/revoke", bodyObject, wrap(async (req, res) => { await oauth.revoke(req.body); res.status(200).end(); }));
// Cookie/session authentication is separate from the agent's OAuth credentials.
// The consent decision requires both that session and a request-bound CSRF token.
session.use("/mcp/authorize", privateResponse, reqSessionAuth);
session.get("/mcp/authorize/:requestId", wrap(async (req, res) => res.json({ success: true, data: await oauth.consentInfo(req.params.requestId, req.account) })));
session.post("/mcp/authorize/:requestId", bodyObject, wrap(async (req, res) => {
    const origin = req.get("origin");
    if (origin && !config.CORS_DASHBOARD_ORIGINS.includes(origin)) return res.status(403).json({ success: false, error: "access_denied", error_description: "Untrusted consent origin" });
    res.json({ success: true, data: await oauth.decide(req.params.requestId, req.account, req.body) });
}));
management.use("/:orgId/mcp/oauth", privateResponse, reqOrgOwnerAuth, requireRole(...OWNER_OR_ADMIN));
management.get("/:orgId/mcp/oauth", wrap(async (req, res) => res.json({ success: true, data: await oauth.management(req.params.orgId) })));
management.post("/:orgId/mcp/oauth/clients", bodyObject, wrap(async (req, res) => res.status(201).json({ success: true, data: await oauth.createClient(req.params.orgId, req.body) })));
management.delete("/:orgId/mcp/oauth/clients/:clientId", wrap(async (req, res) => { await oauth.deleteClient(req.params.orgId, req.params.clientId); res.json({ success: true }); }));
management.delete("/:orgId/mcp/oauth/connections/:grantId", wrap(async (req, res) => { await oauth.revokeConnection(req.params.orgId, req.params.grantId); res.json({ success: true }); }));
module.exports = { publicRoutes, session, management };
