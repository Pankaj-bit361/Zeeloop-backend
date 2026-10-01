"use strict";
const crypto = require("node:crypto");
const config = require("../../config/config");
const { McpClient, McpRequest, McpGrant } = require("../../models/security/mcpOAuth");
const Account = require("../../models/user/account");
const Member = require("../../models/org/member");
const Org = require("../../models/org/org");
const { MemberStatus } = require("../../config/enums");
const { OWNER_OR_ADMIN } = require("../../middlewares/auth");
const { outboundRequest } = require("../utilFunctions/outboundRequest");

const ISSUER = config.API_URL.replace(/\/$/, "");
const RESOURCE = `${ISSUER}/mcp`;
const SCOPE = "zealoop:install";
const METADATA_URL = `${ISSUER}/.well-known/oauth-protected-resource/mcp`;
const CHALLENGE = `Bearer realm="Zealoop MCP", resource_metadata="${METADATA_URL}", scope="${SCOPE}"`;
const DAY = 86_400_000, HOUR = 3_600_000;
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const secret = prefix => prefix + crypto.randomBytes(32).toString("base64url");
class OAuthError extends Error {
    constructor(error, message, status = 400) { super(message); this.oauthError = error; this.status = status; }
}
const fail = (error, message, status) => { throw new OAuthError(error, message, status); };
function same(a, b) {
    if (typeof a !== "string" || typeof b !== "string") return false;
    const x = Buffer.from(a), y = Buffer.from(b);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function string(value, name, max = 2048, optional = false) {
    if (optional && value === undefined) return undefined;
    if (typeof value !== "string" || !value || value.length > max) fail("invalid_request", `Invalid ${name}`);
    return value;
}
function redirectAllowed(value) {
    if (typeof value !== "string" || value.length > 2048) return false;
    try {
        const url = new URL(value);
        return !url.username && !url.password && !url.hash &&
            (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
    } catch { return false; }
}
function resource(value) {
    // Native clients must explicitly name the resource; tokens are never
    // accepted by the dashboard API and never issued for another audience.
    try {
        const url = new URL(string(value, "resource"));
        if (url.hash || url.search || url.username || url.password || url.href.replace(/\/$/, "") !== RESOURCE) throw new Error();
    } catch { fail("invalid_target", "The resource must identify this Zealoop MCP server"); }
    return RESOURCE;
}
function scope(value) {
    if (value !== undefined && (typeof value !== "string" || value.trim().split(/\s+/).some(item => item !== SCOPE))) fail("invalid_scope", `Only ${SCOPE} is supported`);
    return SCOPE;
}
function redirects(value) {
    if (!Array.isArray(value) || !value.length || value.length > 10 || !value.every(redirectAllowed)) fail("invalid_client_metadata", "Provide up to ten HTTPS or loopback redirect URLs without credentials or fragments");
    return [...new Set(value)];
}
function matchesRedirect(registered, candidate) {
    if (registered === candidate) return true;
    if (!redirectAllowed(candidate)) return false;
    const expected = new URL(registered), actual = new URL(candidate);
    // RFC 8252 native clients choose a free listener port at sign-in. Only an
    // HTTP loopback callback registered without a port can vary this field;
    // scheme, host, path and query still match exactly.
    if (expected.protocol !== "http:" || expected.port || !["localhost", "127.0.0.1", "[::1]"].includes(expected.hostname)) return false;
    actual.port = "";
    return expected.href === actual.href;
}
const metadataCache = new Map();
async function clientById(id) {
    if (typeof id !== "string" || id.length > 2048) return null;
    if (!id.startsWith("https://")) return McpClient.findOne({ clientId: id, revokedAt: null,
        $or: [{ cleanupAt: { $exists: false } }, { cleanupAt: { $gt: new Date() } }] }).select("+secretHash").lean();
    // Client ID Metadata Documents are fetched through the same pinned-DNS,
    // bounded, no-redirect transport used for installation verification.
    try {
        const url = new URL(id);
        if (url.pathname === "/" || url.username || url.password || url.hash) return null;
        const cached = metadataCache.get(id);
        if (cached && cached.expires > Date.now()) return cached.client;
        const response = await outboundRequest(id, { headers: { accept: "application/json" }, timeoutMs: 5000, maxBytes: 65_536, maxRedirects: 0, redirect: "error" });
        if (!response.ok || !/^application\/(?:json|[\w.+-]+\+json)(?:;|$)/i.test(response.headers.get("content-type") || "")) return null;
        const doc = await response.json();
        if (doc.client_id !== id || (doc.token_endpoint_auth_method && doc.token_endpoint_auth_method !== "none")) return null;
        const client = { clientId: id, name: typeof doc.client_name === "string" ? doc.client_name.trim().slice(0, 80) || url.host : url.host,
            redirectUris: redirects(doc.redirect_uris), orgId: null };
        const cacheControl = response.headers.get("cache-control") || "";
        if (!/no-store|no-cache/i.test(cacheControl)) {
            if (metadataCache.size >= 200) metadataCache.delete(metadataCache.keys().next().value);
            const maxAge = cacheControl.match(/max-age=(\d+)/i);
            metadataCache.set(id, { client, expires: Date.now() + Math.min(maxAge ? Number(maxAge[1]) * 1000 : 300_000, HOUR) });
        }
        return client;
    } catch { return null; }
}
async function register(body) {
    const redirectUris = redirects(body.redirect_uris);
    const method = body.token_endpoint_auth_method ?? "none";
    if (!["none", "client_secret_post"].includes(method)) fail("invalid_client_metadata", "Use none or client_secret_post authentication");
    if (body.grant_types !== undefined && (!Array.isArray(body.grant_types) || body.grant_types.some(item => !["authorization_code", "refresh_token"].includes(item)))) fail("invalid_client_metadata", "Unsupported grant type");
    if (body.response_types !== undefined && (!Array.isArray(body.response_types) || body.response_types.length !== 1 || body.response_types[0] !== "code")) fail("invalid_client_metadata", "Only code responses are supported");
    const name = body.client_name === undefined ? "MCP client" : string(body.client_name, "client_name", 80);
    const clientId = secret("zc_");
    const clientSecret = method === "none" ? undefined : secret("zs_");
    await McpClient.create({ clientId, name, redirectUris, ...(clientSecret ? { secretHash: hash(clientSecret) } : {}), cleanupAt: new Date(Date.now() + 90 * DAY) });
    return { client_id: clientId, ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
        client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name, redirect_uris: redirectUris,
        token_endpoint_auth_method: method, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] };
}
async function authenticateClient(body) {
    const client = await clientById(string(body.client_id, "client_id"));
    if (!client || (client.secretHash ? !same(hash(typeof body.client_secret === "string" ? body.client_secret : ""), client.secretHash) : body.client_secret !== undefined)) fail("invalid_client", "Invalid client credentials", 401);
    if (client.cleanupAt) await McpClient.updateOne({ clientId: client.clientId, revokedAt: null }, { $set: { cleanupAt: new Date(Date.now() + 90 * DAY) } });
    return client;
}
async function startAuthorization(query) {
    const client = await clientById(string(query.client_id, "client_id"));
    if (!client) fail("invalid_client", "Unknown OAuth client");
    const redirectUri = string(query.redirect_uri, "redirect_uri");
    // Never redirect errors until the registered callback has been checked.
    if (!client.redirectUris.some(uri => matchesRedirect(uri, redirectUri))) fail("invalid_request", "The callback does not match this client's registered redirect URL");
    if (query.response_type !== "code" || query.code_challenge_method !== "S256" || typeof query.code_challenge !== "string" || !/^[\w-]{43}$/.test(query.code_challenge)) fail("invalid_request", "Authorization requires code response type and S256 PKCE");
    resource(query.resource); scope(query.scope);
    const state = string(query.state, "state", 2048, true);
    const requestId = secret("zr_");
    await McpRequest.create({ requestId, clientId: client.clientId, clientName: client.name, redirectUri, resource: RESOURCE,
        codeChallenge: query.code_challenge, state, expiresAt: new Date(Date.now() + 10 * 60_000) });
    return `${config.APP_URL.replace(/\/$/, "")}/mcp/authorize?request=${encodeURIComponent(requestId)}`;
}
async function eligibleOrgs(account, client) {
    const seats = await Member.find({ email: account.email, status: MemberStatus.ACTIVE, role: { $in: OWNER_OR_ADMIN }, ...(client.orgId ? { orgId: client.orgId } : {}) }).select("orgId role").lean();
    return Org.find({ orgId: { $in: seats.map(seat => seat.orgId) } }).select("orgId name").sort({ name: 1 }).lean();
}
function verified(account) {
    if (!account?.emailVerifiedAt) fail("access_denied", "Verify your email before connecting an agent", 403);
}
const csrf = (row, account) => crypto.createHmac("sha256", config.SESSION_SECRET).update(`mcp-consent:${row.requestId}:${account.accountId}:${account.sessionVersion || 0}`).digest("base64url");
async function consentInfo(requestId, account) {
    verified(account);
    const row = await McpRequest.findOneAndUpdate({ requestId, consumedAt: null, expiresAt: { $gt: new Date() },
        $or: [{ accountId: null }, { accountId: account.accountId, sessionVersion: account.sessionVersion || 0 }] },
    { $set: { accountId: account.accountId, sessionVersion: account.sessionVersion || 0 } }, { new: true }).lean();
    if (!row) fail("invalid_request", "This connection request expired or was already used. Start again in your MCP client.");
    const client = await clientById(row.clientId);
    if (!client || !client.redirectUris.some(uri => matchesRedirect(uri, row.redirectUri))) fail("invalid_client", "This OAuth client is no longer available");
    return { clientName: client.name, redirectHost: new URL(row.redirectUri).host, scope: SCOPE,
        organizations: await eligibleOrgs(account, client), csrfToken: csrf(row, account), expiresAt: row.expiresAt };
}
function callback(row, params) {
    const url = new URL(row.redirectUri);
    for (const [name, value] of Object.entries({ ...params, state: row.state, iss: ISSUER })) if (value !== undefined) url.searchParams.set(name, value);
    return url.href;
}
async function allocate(Model, orgId, values) {
    for (let slot = 0; slot < 20; slot++) {
        try { return await Model.create({ ...values, orgId, activeSlot: slot }); }
        catch (error) { if (error.code !== 11000 || !error.keyPattern?.activeSlot) throw error; }
    }
    fail("access_denied", `This organization has twenty active ${Model === McpClient ? "OAuth clients" : "MCP connections"}. Revoke one and retry.`);
}
async function decide(requestId, account, body) {
    const info = await consentInfo(requestId, account);
    if (!same(body.csrfToken, info.csrfToken) || !["approve", "deny"].includes(body.decision)) fail("access_denied", "Invalid consent request", 403);
    if (body.decision === "approve" && !info.organizations.some(org => org.orgId === body.orgId)) fail("access_denied", "You cannot connect this organization", 403);
    const row = await McpRequest.findOneAndUpdate({ requestId, accountId: account.accountId, sessionVersion: account.sessionVersion || 0, consumedAt: null, expiresAt: { $gt: new Date() } }, { $set: { consumedAt: new Date() } }).lean();
    if (!row) fail("invalid_request", "This request has already been used");
    if (body.decision === "deny") return { redirectUrl: callback(row, { error: "access_denied", error_description: "The user declined the connection" }) };
    const code = secret("za_");
    const now = new Date();
    await McpGrant.updateMany({ orgId: body.orgId, $or: [{ revokedAt: { $ne: null } }, { refreshExpiresAt: { $lte: now } }, { codeUsedAt: null, codeExpiresAt: { $lte: now } }] }, { $unset: { activeSlot: 1 } });
    try {
        await allocate(McpGrant, body.orgId, { grantId: secret("zg_"), clientId: row.clientId, clientName: row.clientName,
            accountId: account.accountId, sessionVersion: account.sessionVersion || 0, resource: row.resource,
            codeHash: hash(code), codeChallenge: row.codeChallenge, redirectUri: row.redirectUri,
            codeExpiresAt: new Date(Date.now() + 5 * 60_000), refreshExpiresAt: new Date(Date.now() + 30 * DAY) });
    } catch (error) {
        // Capacity failures can safely be reported to the validated callback;
        // infrastructure failures must not pretend to be an authorization denial.
        if (!(error instanceof OAuthError)) throw error;
        return { redirectUrl: callback(row, { error: error.oauthError, error_description: error.message }) };
    }
    return { redirectUrl: callback(row, { code }) };
}
async function validGrant(row) {
    if (!row || row.revokedAt || row.resource !== RESOURCE || row.refreshExpiresAt <= new Date()) return false;
    const [account, client] = await Promise.all([
        Account.findOne({ accountId: row.accountId }).select("email emailVerifiedAt sessionVersion").lean(),
        row.clientId.startsWith("https://") ? Promise.resolve({ orgId: null }) : McpClient.findOne({ clientId: row.clientId, revokedAt: null,
            $or: [{ cleanupAt: { $exists: false } }, { cleanupAt: { $gt: new Date() } }] }).lean(),
    ]);
    if (!account?.emailVerifiedAt || (account.sessionVersion || 0) !== row.sessionVersion || !client || (client.orgId && client.orgId !== row.orgId)) return false;
    return Boolean(await Member.exists({ orgId: row.orgId, email: account.email, status: MemberStatus.ACTIVE, role: { $in: OWNER_OR_ADMIN } }) && await Org.exists({ orgId: row.orgId }));
}
async function token(body) {
    const client = await authenticateClient(body);
    resource(body.resource); scope(body.scope);
    const now = new Date();
    let row, filter;
    if (body.grant_type === "authorization_code") {
        const code = string(body.code, "code", 100), redirectUri = string(body.redirect_uri, "redirect_uri");
        const verifier = string(body.code_verifier, "code_verifier", 128);
        if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) fail("invalid_grant", "Invalid PKCE verifier");
        row = await McpGrant.findOne({ clientId: client.clientId, codeHash: hash(code), codeUsedAt: null, codeExpiresAt: { $gt: now }, revokedAt: null }).select("+codeChallenge").lean();
        if (!row || redirectUri !== row.redirectUri || !same(crypto.createHash("sha256").update(verifier).digest("base64url"), row.codeChallenge)) fail("invalid_grant", "Invalid authorization code or PKCE verifier");
        filter = { grantId: row.grantId, codeHash: hash(code), codeUsedAt: null, codeExpiresAt: { $gt: now }, revokedAt: null };
    } else if (body.grant_type === "refresh_token") {
        const refreshHash = hash(string(body.refresh_token, "refresh_token", 100));
        row = await McpGrant.findOne({ clientId: client.clientId, refreshHash, revokedAt: null, refreshExpiresAt: { $gt: now } }).select("+usedRefreshHashes").lean();
        if (!row) {
            // A previously rotated credential is a replay. Revoke its entire
            // family, including the replacement token returned to a thief.
            await McpGrant.updateOne({ clientId: client.clientId, usedRefreshHashes: refreshHash, revokedAt: null }, { $set: { revokedAt: now }, $unset: { activeSlot: 1 } });
            fail("invalid_grant", "Invalid or already used refresh token");
        }
        if (row.usedRefreshHashes.length >= 1000) { await McpGrant.updateOne({ grantId: row.grantId }, { $set: { revokedAt: now }, $unset: { activeSlot: 1 } }); fail("invalid_grant", "Connect again to renew this grant"); }
        filter = { grantId: row.grantId, refreshHash, revokedAt: null, refreshExpiresAt: { $gt: now } };
    } else fail("unsupported_grant_type", "Use authorization_code or refresh_token");
    if (!await validGrant(row)) fail("invalid_grant", "Workspace access has expired or been revoked");
    const access = secret("zo_"), refresh = secret("zf_");
    const expires = new Date(Math.min(Date.now() + HOUR, row.refreshExpiresAt.getTime()));
    const update = { $set: { accessHash: hash(access), refreshHash: hash(refresh), accessExpiresAt: expires, codeUsedAt: row.codeUsedAt || now } };
    if (body.grant_type === "refresh_token") update.$push = { usedRefreshHashes: filter.refreshHash };
    if (!await McpGrant.findOneAndUpdate(filter, update)) {
        if (body.grant_type === "refresh_token") await McpGrant.updateOne({ grantId: row.grantId, usedRefreshHashes: filter.refreshHash }, { $set: { revokedAt: now }, $unset: { activeSlot: 1 } });
        fail("invalid_grant", "The credential was already used or revoked");
    }
    return { access_token: access, token_type: "Bearer", expires_in: Math.max(0, Math.floor((expires.getTime() - Date.now()) / 1000)), refresh_token: refresh, scope: SCOPE };
}
async function resolveAccess(access) {
    if (typeof access !== "string" || !/^zo_[\w-]{43}$/.test(access)) return null;
    const row = await McpGrant.findOne({ accessHash: hash(access), revokedAt: null, accessExpiresAt: { $gt: new Date() } }).lean();
    if (!await validGrant(row)) return null;
    await McpGrant.updateOne({ grantId: row.grantId, revokedAt: null }, { $set: { lastUsedAt: new Date() } });
    return { orgId: row.orgId, tokenId: `oauth:${row.grantId}` };
}
async function revoke(body) {
    const client = await authenticateClient(body);
    const digest = hash(string(body.token, "token", 100));
    await McpGrant.updateOne({ clientId: client.clientId, $or: [{ accessHash: digest }, { refreshHash: digest }, { usedRefreshHashes: digest }] }, { $set: { revokedAt: new Date() }, $unset: { activeSlot: 1 } });
}
async function management(orgId) {
    const [clients, grants] = await Promise.all([
        McpClient.find({ orgId, revokedAt: null }).sort({ createdAt: -1 }).lean(),
        McpGrant.find({ orgId, revokedAt: null, codeUsedAt: { $ne: null }, refreshExpiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).lean(),
    ]);
    const accounts = await Account.find({ accountId: { $in: grants.map(row => row.accountId) } }).select("accountId email").lean();
    const emailOf = new Map(accounts.map(row => [row.accountId, row.email]));
    return { clients: clients.map(row => ({ clientId: row.clientId, name: row.name, redirectUris: row.redirectUris, createdAt: row.createdAt })),
        connections: grants.map(row => ({ grantId: row.grantId, clientName: row.clientName, userEmail: emailOf.get(row.accountId) || "Former member", createdAt: row.createdAt, expiresAt: row.refreshExpiresAt, lastUsedAt: row.lastUsedAt })) };
}
async function createClient(orgId, body) {
    const name = string(body.name, "name", 80).trim(), redirectUris = redirects(body.redirectUris);
    if (!name) fail("invalid_client_metadata", "Give the client a name");
    const clientId = secret("zc_"), clientSecret = secret("zs_");
    await allocate(McpClient, orgId, { clientId, name, redirectUris, secretHash: hash(clientSecret) });
    return { clientId, clientSecret, name, redirectUris };
}
async function deleteClient(orgId, clientId) {
    if (!await McpClient.findOneAndUpdate({ orgId, clientId, revokedAt: null }, { $set: { revokedAt: new Date() }, $unset: { activeSlot: 1 } })) fail("invalid_request", "No such client in this organization", 404);
    await McpGrant.updateMany({ clientId, orgId, revokedAt: null }, { $set: { revokedAt: new Date() }, $unset: { activeSlot: 1 } });
}
async function revokeConnection(orgId, grantId) {
    if (!await McpGrant.findOneAndUpdate({ orgId, grantId, revokedAt: null }, { $set: { revokedAt: new Date() }, $unset: { activeSlot: 1 } })) fail("invalid_request", "No such connection in this organization", 404);
}
function authorizationMetadata() {
    return { issuer: ISSUER, authorization_endpoint: `${ISSUER}/oauth/mcp/authorize`, token_endpoint: `${ISSUER}/oauth/mcp/token`,
        registration_endpoint: `${ISSUER}/oauth/mcp/register`, revocation_endpoint: `${ISSUER}/oauth/mcp/revoke`,
        response_types_supported: ["code"], response_modes_supported: ["query"], grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
        scopes_supported: [SCOPE], authorization_response_iss_parameter_supported: true, client_id_metadata_document_supported: true };
}
function protectedMetadata() {
    return { resource: RESOURCE, authorization_servers: [ISSUER], scopes_supported: [SCOPE], bearer_methods_supported: ["header"], resource_name: "Zealoop widget installation" };
}
module.exports = { OAuthError, ISSUER, RESOURCE, SCOPE, CHALLENGE, register, startAuthorization, consentInfo, decide, token, revoke, resolveAccess,
    management, createClient, deleteClient, revokeConnection, authorizationMetadata, protectedMetadata, redirectAllowed, matchesRedirect, clientById };
