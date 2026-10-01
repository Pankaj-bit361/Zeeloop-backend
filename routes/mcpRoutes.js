const express = require("express");
const { McpServer, createMcpHandler } = require("@modelcontextprotocol/server");
const { toNodeHandler } = require("@modelcontextprotocol/node");
const z = require("zod");
const config = require("../config/config");
const InstallToken = require("../models/security/installToken");
const Account = require("../models/user/account");
const Member = require("../models/org/member");
const Org = require("../models/org/org");
const { MemberStatus } = require("../config/enums");
const { reqOrgOwnerAuth, requireRole, OWNER_OR_ADMIN } = require("../middlewares/auth");
const { consumeShared, clientIp } = require("../middlewares/rateLimit");
const install = require("../functions/mcp/installFunctions");
const oauth = require("../functions/mcp/oauthFunctions");

const management = express.Router();
management.use("/:orgId/mcp/tokens", (req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store"); next();
}, reqOrgOwnerAuth, requireRole(...OWNER_OR_ADMIN));
management.get("/:orgId/mcp/tokens", async (req, res, next) => {
    try { res.json({ success: true, data: await install.listTokens(req.params.orgId) }); } catch (error) { next(error); }
});
management.post("/:orgId/mcp/tokens", async (req, res, next) => {
    try { const result = await install.createToken({ orgId: req.params.orgId, email: req.auth.email, name: req.body.name }); res.status(result.status).json(result.json); } catch (error) { next(error); }
});
management.delete("/:orgId/mcp/tokens/:tokenId", async (req, res, next) => {
    try { const result = await install.revokeToken({ orgId: req.params.orgId, email: req.auth.email, tokenId: req.params.tokenId }); res.status(result.status).json(result.json); } catch (error) { next(error); }
});

const endpoint = express.Router();
endpoint.use(async (req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    try {
        const origin = req.get("origin");
        if (req.get("host") !== new URL(config.API_URL).host || (origin && ![new URL(config.API_URL).origin, ...config.CORS_DASHBOARD_ORIGINS].includes(origin))) {
            return res.status(403).json({ error: "Untrusted MCP host or origin" });
        }
        const ip = await consumeShared(`mcp:ip:${clientIp(req)}`, 120, 60_000);
        if (!ip.allowed) { res.setHeader("Retry-After", String(ip.retryAfterSeconds)); return res.status(429).json({ error: "Too many MCP requests" }); }
        const bearer = (req.get("authorization") || "").match(/^Bearer (\S+)$/)?.[1];
        const connection = bearer?.startsWith("zo_") ? await oauth.resolveAccess(bearer) : null;
        if (connection) {
            const limit = await consumeShared(`mcp:token:${connection.tokenId}`, 60, 60_000);
            if (!limit.allowed) { res.setHeader("Retry-After", String(limit.retryAfterSeconds)); return res.status(429).json({ error: "MCP connection request limit reached" }); }
            req.installOrgId = connection.orgId;
            return next();
        }
        const token = (req.get("authorization") || "").match(/^Bearer (zi_[0-9a-f]{64})$/)?.[1];
        const row = token ? await InstallToken.findOne({ tokenHash: install.hash(token), revokedAt: null, expiresAt: { $gt: new Date() } }).lean() : null;
        const account = row ? await Account.findOne({ accountId: row.accountId }).select("email emailVerifiedAt sessionVersion").lean() : null;
        const member = account ? await Member.findOne({ orgId: row.orgId, email: account.email, status: MemberStatus.ACTIVE }).select("role").lean() : null;
        if (!row || !account?.emailVerifiedAt || (account.sessionVersion || 0) !== row.sessionVersion || !member || !OWNER_OR_ADMIN.includes(member.role)
            || !(await Org.exists({ orgId: row.orgId }))) {
            res.setHeader("WWW-Authenticate", `${oauth.CHALLENGE}, error="invalid_token"`);
            return res.status(401).json({ error: "Connect by signing in to Zealoop, or use a valid installation token" });
        }
        const limit = await consumeShared(`mcp:token:${row.tokenId}`, 60, 60_000);
        if (!limit.allowed) { res.setHeader("Retry-After", String(limit.retryAfterSeconds)); return res.status(429).json({ error: "Installation token request limit reached" }); }
        req.installOrgId = row.orgId;
        await InstallToken.updateOne({ tokenId: row.tokenId }, { $set: { lastUsedAt: new Date() } });
        next();
    } catch (error) { next(error); }
});

function serverFor(orgId) {
    const server = new McpServer({ name: "zealoop-installation", version: "1.0.0" }, {
        instructions: "Read the workspace installation config, inspect the website repository, use the appropriate installation instructions, run its checks, and verify the deployed page. Website edits and deployments need the website owner's authorization. No tool returns signing secrets or can publish a website." });
    const result = async work => {
        try { const data = await work(); return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data }; }
        catch (error) { return { isError: true, content: [{ type: "text", text: "Installation check failed. Check the page URL, public reachability and workspace access, then retry." }] }; }
    };
    server.registerTool("zealoop_get_install_config", { description: "Read public widget configuration for the authenticated workspace. No signing secrets.", inputSchema: z.object({}).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }, () => result(() => install.getConfig(orgId)));
    server.registerTool("zealoop_get_install_instructions", { description: "Get framework-specific installation code and steps. The coding agent must edit the website with its existing repository/CMS access.",
        inputSchema: z.object({ framework: z.enum(["html", "react", "next", "wordpress"]).default("html") }).strict(), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
        ({ framework }) => result(() => install.instructions(orgId, framework)));
    server.registerTool("zealoop_verify_installation", { description: "Fetch a public HTTP(S) website page and check for this workspace's loader/key and embedding policy. Does not execute JavaScript or certify browser runtime.",
        inputSchema: z.object({ websiteUrl: z.string().url().max(2048) }).strict(), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true } },
        ({ websiteUrl }) => result(() => install.verify(orgId, websiteUrl)));
    return server;
}
endpoint.all("/", async (req, res, next) => {
    const handler = createMcpHandler(() => serverFor(req.installOrgId), { legacy: "stateless" });
    // SSE responses carry SDK cache headers; preserve our privacy policy after
    // dispatch so writeHead cannot replace it with the transport's defaults.
    const privateHandler = { fetch: async (...args) => {
        const response = await handler.fetch(...args);
        const headers = new Headers(response.headers);
        headers.set("Cache-Control", "private, no-store");
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } };
    try { await toNodeHandler(privateHandler, { maxRequestBodySize: 65_536 })(req, res, req.body); }
    catch (error) { next(error); }
    finally { await handler.close(); }
});

module.exports = { endpoint, management };
