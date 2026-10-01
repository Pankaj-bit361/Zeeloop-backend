"use strict";
const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const { Client, StreamableHTTPClientTransport } = require("@modelcontextprotocol/client");
const { BASE_URL, createIsolatedOrg, get, post, del, authHeader } = require("./helpers/client");
const { McpClient, McpRequest, McpGrant } = require("../models/security/mcpOAuth");
const Account = require("../models/user/account");
const Member = require("../models/org/member");
const Org = require("../models/org/org");
const RateBucket = require("../models/security/rateBucket");
const { MemberRole, MemberStatus } = require("../config/enums");
const scope = "zealoop:install", resource = `${BASE_URL}/mcp`;
const callback = "https://client.example/callback";
let owner, sibling, client;
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
before(async () => {
    await mongoose.connect(process.env.TEST_MONGODB_URI);
    owner = await createIsolatedOrg("mcp-oauth-owner"); sibling = await createIsolatedOrg("mcp-oauth-sibling");
    const registered = await post("/oauth/mcp/register", { body: { client_name: "OAuth regression client", redirect_uris: [callback], token_endpoint_auth_method: "none" } });
    assert.equal(registered.status, 201); client = registered.json;
});
beforeEach(async () => {
    await RateBucket.deleteMany({ key: { $in: ["127.0.0.1", "::ffff:127.0.0.1", "::1"].flatMap(ip => [sha(`mcp-oauth:ip:${ip}`), sha(`mcp:ip:${ip}`)]) } });
    await McpGrant.updateMany({ orgId: { $in: [owner.orgId, sibling.orgId] } }, { $set: { revokedAt: new Date() }, $unset: { activeSlot: 1 } });
});
after(async () => { await mongoose.disconnect(); });
async function begin(overrides = {}, using = client) {
    const verifier = crypto.randomBytes(48).toString("base64url");
    const params = { client_id: using.client_id, redirect_uri: callback, response_type: "code", code_challenge_method: "S256",
        code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"), scope, resource, state: "fixture-state", ...overrides };
    const response = await fetch(`${BASE_URL}/oauth/mcp/authorize?${new URLSearchParams(params)}`, { redirect: "manual" });
    const location = response.headers.get("location");
    const id = location ? new URL(location).searchParams.get("request") : null;
    return { response, id, verifier, location, using };
}
async function approve(workspace = owner, overrides = {}, using = client) {
    const start = await begin(overrides, using); assert.equal(start.response.status, 302);
    const info = await get(`/api/auth/mcp/authorize/${start.id}`, { cookie: workspace.cookie }); assert.equal(info.status, 200);
    const decision = await post(`/api/auth/mcp/authorize/${start.id}`, { cookie: workspace.cookie,
        body: { csrfToken: info.json.data.csrfToken, decision: "approve", orgId: workspace.orgId } });
    assert.equal(decision.status, 200);
    return { ...start, info: info.json.data, redirect: new URL(decision.json.data.redirectUrl), code: new URL(decision.json.data.redirectUrl).searchParams.get("code") };
}
const exchange = (grant, overrides = {}) => post("/oauth/mcp/token", { body: { client_id: grant.using.client_id,
    ...(grant.using.client_secret ? { client_secret: grant.using.client_secret } : {}), grant_type: "authorization_code", code: grant.code,
    redirect_uri: callback, code_verifier: grant.verifier, resource, ...overrides } });
async function connected(workspace = owner) { const grant = await approve(workspace); const response = await exchange(grant); assert.equal(response.status, 200); return { ...grant, tokens: response.json }; }
const refresh = (tokens, overrides = {}) => post("/oauth/mcp/token", { body: { client_id: client.client_id, grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource, ...overrides } });
const rpc = async token => {
    const response = await fetch(resource, { method: "POST", headers: { ...authHeader(token), "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "oauth", method: "tools/list", params: {} }) });
    return response;
};

describe("MCP OAuth discovery, consent and issuance", () => {
    test("the unauthorized MCP challenge advertises resource metadata and least-privilege scope", async () => {
        const response = await fetch(resource);
        assert.equal(response.status, 401);
        assert.ok(response.headers.get("www-authenticate").includes(`${BASE_URL}/.well-known/oauth-protected-resource/mcp`));
        assert.ok(response.headers.get("www-authenticate").includes(scope));
        const metadata = await get("/.well-known/oauth-protected-resource/mcp");
        assert.equal(metadata.json.resource, resource); assert.deepEqual(metadata.json.authorization_servers, [BASE_URL]);
        const issuer = await get("/.well-known/oauth-authorization-server");
        assert.equal(issuer.json.issuer, BASE_URL); assert.deepEqual(issuer.json.code_challenge_methods_supported, ["S256"]);
        assert.equal(issuer.json.authorization_response_iss_parameter_supported, true);
        assert.equal(issuer.json.client_id_metadata_document_supported, true);
    });
    test("registration rejects insecure callbacks, fragments, credentials and unsupported client authentication", async () => {
        for (const redirect of ["http://example.com/callback", "javascript:alert(1)", "https://example.com/callback#fragment", "https://user:password@example.com/callback"]) {
            assert.equal((await post("/oauth/mcp/register", { body: { redirect_uris: [redirect] } })).status, 400);
        }
        assert.equal((await post("/oauth/mcp/register", { body: { redirect_uris: [callback], token_endpoint_auth_method: "bad-method" } })).status, 400);
    });
    test("authorization refuses unregistered callbacks, incorrect audiences, scopes and non-PKCE requests without redirecting", async () => {
        for (const override of [{ redirect_uri: "https://attacker.example/callback" }, { resource: "https://attacker.example/mcp" }, { scope: "billing:write" }, { code_challenge_method: "plain" }, { code_challenge: "short" }, { response_type: "token" }]) {
            const start = await begin(override); assert.equal(start.response.status, 400); assert.equal(start.location, null);
        }
    });
    test("consent requires a live verified session, offers only eligible organizations and pins the account", async () => {
        const start = await begin();
        assert.equal((await get(`/api/auth/mcp/authorize/${start.id}`)).status, 401);
        const info = await get(`/api/auth/mcp/authorize/${start.id}`, { cookie: owner.cookie });
        assert.deepEqual(info.json.data.organizations.map(row => row.orgId), [owner.orgId]);
        assert.equal(info.json.data.clientName, "OAuth regression client");
        assert.equal((await get(`/api/auth/mcp/authorize/${start.id}`, { cookie: sibling.cookie })).status, 400);
        const account = await Account.findOne({ email: owner.email }).lean();
        await Account.updateOne({ _id: account._id }, { $set: { emailVerifiedAt: null } });
        try { assert.equal((await get(`/api/auth/mcp/authorize/${start.id}`, { cookie: owner.cookie })).status, 403); }
        finally { await Account.updateOne({ _id: account._id }, { $set: { emailVerifiedAt: account.emailVerifiedAt } }); }
    });
    test("forged consent, foreign organizations and untrusted origins cannot mint credentials", async () => {
        const start = await begin();
        const info = (await get(`/api/auth/mcp/authorize/${start.id}`, { cookie: owner.cookie })).json.data;
        for (const body of [{ csrfToken: "forged", orgId: owner.orgId }, { csrfToken: info.csrfToken, orgId: sibling.orgId }]) {
            assert.equal((await post(`/api/auth/mcp/authorize/${start.id}`, { cookie: owner.cookie, body: { decision: "approve", ...body } })).status, 403);
        }
        assert.equal((await post(`/api/auth/mcp/authorize/${start.id}`, { cookie: owner.cookie, headers: { origin: "https://attacker.example" }, body: { csrfToken: info.csrfToken, orgId: owner.orgId, decision: "approve" } })).status, 403);
        assert.equal(await McpGrant.countDocuments({ codeHash: sha("forged") }), 0);
    });
    test("cancellation preserves state and issuer and does not create a connection", async () => {
        const count = await McpGrant.countDocuments({ orgId: owner.orgId });
        const start = await begin(); const info = (await get(`/api/auth/mcp/authorize/${start.id}`, { cookie: owner.cookie })).json.data;
        const result = await post(`/api/auth/mcp/authorize/${start.id}`, { cookie: owner.cookie, body: { csrfToken: info.csrfToken, decision: "deny" } });
        const url = new URL(result.json.data.redirectUrl);
        assert.equal(url.searchParams.get("error"), "access_denied"); assert.equal(url.searchParams.get("state"), "fixture-state"); assert.equal(url.searchParams.get("iss"), BASE_URL);
        assert.equal(await McpGrant.countDocuments({ orgId: owner.orgId }), count);
        assert.equal((await post(`/api/auth/mcp/authorize/${start.id}`, { cookie: owner.cookie, body: { csrfToken: info.csrfToken, decision: "approve", orgId: owner.orgId } })).status, 400);
    });
    test("approval issues only one code and success includes state and issuer", async () => {
        const grant = await approve();
        assert.equal(grant.redirect.searchParams.get("state"), "fixture-state"); assert.equal(grant.redirect.searchParams.get("iss"), BASE_URL);
        assert.ok(grant.code.startsWith("za_"));
        assert.equal((await post(`/api/auth/mcp/authorize/${grant.id}`, { cookie: owner.cookie, body: { csrfToken: grant.info.csrfToken, decision: "approve", orgId: owner.orgId } })).status, 400);
    });
    test("PKCE, exact callback and resource failures do not consume a valid code", async () => {
        const grant = await approve();
        for (const override of [{ code_verifier: "x".repeat(64) }, { redirect_uri: "https://other.example/callback" }, { resource: "https://other.example/mcp" }]) assert.equal((await exchange(grant, override)).status, 400);
        const result = await exchange(grant); assert.equal(result.status, 200); assert.ok(result.json.expires_in > 3500 && result.json.expires_in <= 3600);
        assert.equal((await exchange(grant)).status, 400);
        const row = await McpGrant.findOne({ codeHash: sha(grant.code) }).select("+accessHash +refreshHash +codeHash").lean();
        assert.equal(row.accessHash, sha(result.json.access_token)); assert.equal(row.refreshHash, sha(result.json.refresh_token));
        assert.ok(!JSON.stringify(row).includes(result.json.access_token));
    });
    test("concurrent authorization-code exchange has one winner", async () => {
        const grant = await approve(); const results = await Promise.all(Array.from({ length: 6 }, () => exchange(grant)));
        assert.equal(results.filter(row => row.status === 200).length, 1); assert.equal(results.filter(row => row.status === 400).length, 5);
    });
    test("expired authorization requests and codes cannot be used", async () => {
        const start = await begin(); await McpRequest.updateOne({ requestId: start.id }, { $set: { expiresAt: new Date(0) } });
        assert.equal((await get(`/api/auth/mcp/authorize/${start.id}`, { cookie: owner.cookie })).status, 400);
        const grant = await approve(); await McpGrant.updateOne({ codeHash: sha(grant.code) }, { $set: { codeExpiresAt: new Date(0) } });
        assert.equal((await exchange(grant)).status, 400);
    });
});
describe("MCP OAuth token isolation, rotation and disconnect", () => {
    test("the SDK discovers, registers, authorizes, exchanges and refreshes without a pasted token", async () => {
        let savedClient, savedTokens, verifier, authorizationUrl;
        const provider = {
            redirectUrl: "http://127.0.0.1:54321/callback",
            clientMetadata: { client_name: "SDK OAuth client", redirect_uris: ["http://127.0.0.1:54321/callback"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" },
            clientInformation: () => savedClient, saveClientInformation: value => { savedClient = value; },
            tokens: () => savedTokens, saveTokens: value => { savedTokens = value; },
            redirectToAuthorization: url => { authorizationUrl = url; }, saveCodeVerifier: value => { verifier = value; }, codeVerifier: () => verifier,
            state: () => "sdk-state",
        };
        const first = new Client({ name: "sdk-sign-in", version: "1" });
        const transport = new StreamableHTTPClientTransport(new URL(resource), { authProvider: provider });
        await assert.rejects(first.connect(transport)); assert.ok(authorizationUrl); assert.ok(savedClient.client_id);
        const start = await fetch(authorizationUrl, { redirect: "manual" });
        assert.equal(start.status, 302); const id = new URL(start.headers.get("location")).searchParams.get("request");
        const info = (await get(`/api/auth/mcp/authorize/${id}`, { cookie: owner.cookie })).json.data;
        assert.equal(info.scope, "zealoop:install zealoop:read zealoop:write");
        const decision = await post(`/api/auth/mcp/authorize/${id}`, { cookie: owner.cookie, body: { csrfToken: info.csrfToken, decision: "approve", orgId: owner.orgId } });
        const params = new URL(decision.json.data.redirectUrl).searchParams; assert.equal(params.get("state"), "sdk-state");
        const forged = new URLSearchParams(params); forged.set("iss", "https://attacker.example");
        await assert.rejects(transport.finishAuth(forged));
        await transport.finishAuth(params); assert.ok(savedTokens.access_token); await first.close();
        const sdk = new Client({ name: "sdk-after-sign-in", version: "1" });
        try {
            await sdk.connect(new StreamableHTTPClientTransport(new URL(resource), { authProvider: provider }));
            assert.equal((await sdk.listTools()).tools.length, 38);
            const old = savedTokens.access_token;
            await McpGrant.updateOne({ accessHash: sha(old) }, { $set: { accessExpiresAt: new Date(0) } });
            assert.equal((await sdk.listTools()).tools.length, 38); assert.notEqual(savedTokens.access_token, old);
        } finally { await sdk.close(); }
    });
    test("a real SDK connects with an OAuth token and sees only the selected organization", async () => {
        const connection = await connected(sibling);
        const sdk = new Client({ name: "oauth-test", version: "1" });
        try {
            await sdk.connect(new StreamableHTTPClientTransport(new URL(resource), { requestInit: { headers: authHeader(connection.tokens.access_token) } }));
            const config = await sdk.callTool({ name: "zealoop_get_install_config", arguments: {} });
            assert.equal(config.structuredContent.orgId, sibling.orgId); assert.equal(config.structuredContent.publicKey, sibling.publicKey);
            assert.equal((await sdk.listTools()).tools.length, 3);
        } finally { await sdk.close(); }
        assert.equal((await get(`/api/org/${sibling.orgId}/settings`, { headers: authHeader(connection.tokens.access_token) })).status, 401);
        assert.equal((await rpc(connection.tokens.refresh_token)).status, 401);
    });
    test("refresh rotates both credentials without extending the thirty-day connection", async () => {
        const connection = await connected(); const before = await McpGrant.findOne({ refreshHash: sha(connection.tokens.refresh_token) }).lean();
        const next = await refresh(connection.tokens); assert.equal(next.status, 200);
        assert.notEqual(next.json.access_token, connection.tokens.access_token); assert.notEqual(next.json.refresh_token, connection.tokens.refresh_token);
        assert.equal((await rpc(connection.tokens.access_token)).status, 401); assert.equal((await rpc(next.json.access_token)).status, 200);
        const after = await McpGrant.findOne({ grantId: before.grantId }).lean(); assert.equal(+after.refreshExpiresAt, +before.refreshExpiresAt);
    });
    test("replaying a rotated refresh token revokes its replacement family", async () => {
        const connection = await connected(); const next = await refresh(connection.tokens); assert.equal(next.status, 200);
        assert.equal((await refresh(connection.tokens)).status, 400);
        assert.equal((await rpc(next.json.access_token)).status, 401); assert.equal((await refresh(next.json)).status, 400);
    });
    test("concurrent refresh has one winner and replay revokes the resulting family", async () => {
        const connection = await connected(); const results = await Promise.all([refresh(connection.tokens), refresh(connection.tokens)]);
        assert.equal(results.filter(row => row.status === 200).length, 1); assert.equal(results.filter(row => row.status === 400).length, 1);
        assert.equal((await rpc(results.find(row => row.status === 200).json.access_token)).status, 401);
    });
    test("a wrong client, resource or scope cannot redeem a refresh token", async () => {
        const connection = await connected();
        for (const override of [{ client_id: "unknown" }, { resource: "https://attacker.example/mcp" }, { scope: "billing:write" }]) assert.ok((await refresh(connection.tokens, override)).status >= 400);
        assert.equal((await refresh(connection.tokens)).status, 200);
    });
    test("access and connection expiry are enforced independently", async () => {
        const connection = await connected(); await McpGrant.updateOne({ refreshHash: sha(connection.tokens.refresh_token) }, { $set: { accessExpiresAt: new Date(0) } });
        assert.equal((await rpc(connection.tokens.access_token)).status, 401);
        const next = await refresh(connection.tokens); assert.equal(next.status, 200);
        await McpGrant.updateOne({ refreshHash: sha(next.json.refresh_token) }, { $set: { refreshExpiresAt: new Date(0) } });
        assert.equal((await rpc(next.json.access_token)).status, 401); assert.equal((await refresh(next.json)).status, 400);
    });
    test("a disconnect invalidates access and refresh tokens and releases capacity", async () => {
        const connection = await connected(); const row = await McpGrant.findOne({ refreshHash: sha(connection.tokens.refresh_token) }).lean();
        assert.equal((await del(`/api/org/${sibling.orgId}/mcp/oauth/connections/${row.grantId}`, { headers: authHeader(sibling.token) })).status, 404);
        assert.equal((await del(`/api/org/${owner.orgId}/mcp/oauth/connections/${row.grantId}`, { headers: authHeader(owner.token) })).status, 200);
        assert.equal((await rpc(connection.tokens.access_token)).status, 401); assert.equal((await refresh(connection.tokens)).status, 400);
        const stored = await McpGrant.findOne({ grantId: row.grantId }).select("+activeSlot").lean(); assert.equal(stored.activeSlot, undefined);
    });
    test("standard token revocation disconnects the whole connection", async () => {
        const connection = await connected();
        assert.equal((await post("/oauth/mcp/revoke", { body: { client_id: client.client_id, token: connection.tokens.refresh_token } })).status, 200);
        assert.equal((await rpc(connection.tokens.access_token)).status, 401); assert.equal((await refresh(connection.tokens)).status, 400);
    });
    test("offboarding, verification changes and sign-out invalidate access and refresh", async () => {
        const fresh = await createIsolatedOrg("mcp-oauth-offboard"); const connection = await connected(fresh);
        const account = await Account.findOne({ email: fresh.email }).lean();
        await Member.updateOne({ orgId: fresh.orgId, email: fresh.email }, { $set: { role: MemberRole.AGENT } });
        assert.equal((await rpc(connection.tokens.access_token)).status, 401); assert.equal((await refresh(connection.tokens)).status, 400);
        await Member.updateOne({ orgId: fresh.orgId, email: fresh.email }, { $set: { role: MemberRole.OWNER, status: MemberStatus.INVITED } });
        assert.equal((await rpc(connection.tokens.access_token)).status, 401);
        await Member.updateOne({ orgId: fresh.orgId, email: fresh.email }, { $set: { status: MemberStatus.ACTIVE } });
        await Account.updateOne({ _id: account._id }, { $set: { emailVerifiedAt: null } });
        assert.equal((await rpc(connection.tokens.access_token)).status, 401);
        await Account.updateOne({ _id: account._id }, { $set: { emailVerifiedAt: account.emailVerifiedAt } });
        assert.equal((await rpc(connection.tokens.access_token)).status, 200);
        await post("/api/auth/logout", { cookie: fresh.cookie });
        assert.equal((await rpc(connection.tokens.access_token)).status, 401); assert.equal((await refresh(connection.tokens)).status, 400);
    });
    test("deleting an account or organization invalidates its credential", async () => {
        const fresh = await createIsolatedOrg("mcp-oauth-delete"); const connection = await connected(fresh);
        await Org.deleteOne({ orgId: fresh.orgId }); assert.equal((await rpc(connection.tokens.access_token)).status, 401);
        await Account.deleteOne({ email: fresh.email }); assert.equal((await refresh(connection.tokens)).status, 400);
    });
});
describe("MCP OAuth named clients and management", () => {
    test("parallel approvals cannot exceed connection capacity and revocation frees the final slot", async () => {
        const fresh = await createIsolatedOrg("oauth-capacity"), account = await Account.findOne({ email: fresh.email }).lean();
        await McpGrant.insertMany(Array.from({ length: 19 }, (_, index) => ({ grantId: `capacity-${fresh.orgId}-${index}`, clientId: client.client_id, clientName: "Fixture", orgId: fresh.orgId, accountId: account.accountId,
            sessionVersion: 0, resource, activeSlot: index, codeHash: sha(`${fresh.orgId}-${index}`), codeChallenge: "x".repeat(43), redirectUri: callback,
            codeExpiresAt: new Date(Date.now() + 60_000), codeUsedAt: new Date(), refreshExpiresAt: new Date(Date.now() + 86_400_000) })));
        const prepared = await Promise.all(Array.from({ length: 8 }, async () => {
            const start = await begin(); const info = (await get(`/api/auth/mcp/authorize/${start.id}`, { cookie: fresh.cookie })).json.data; return { start, info };
        }));
        const results = await Promise.all(prepared.map(({ start, info }) => post(`/api/auth/mcp/authorize/${start.id}`, { cookie: fresh.cookie, body: { csrfToken: info.csrfToken, decision: "approve", orgId: fresh.orgId } })));
        const callbacks = results.map(row => new URL(row.json.data.redirectUrl));
        assert.equal(callbacks.filter(url => url.searchParams.has("code")).length, 1); assert.equal(callbacks.filter(url => url.searchParams.get("error") === "access_denied").length, 7);
        assert.equal(await McpGrant.countDocuments({ orgId: fresh.orgId, activeSlot: { $exists: true } }), 20);
        const grant = await McpGrant.findOne({ orgId: fresh.orgId, activeSlot: 19 }).lean();
        await del(`/api/org/${fresh.orgId}/mcp/oauth/connections/${grant.grantId}`, { headers: authHeader(fresh.token) });
        const retry = await approve(fresh); assert.ok(retry.code);
        assert.equal(await McpGrant.countDocuments({ orgId: fresh.orgId, activeSlot: { $exists: true } }), 20);
    });
    test("named clients store only a secret hash, stay scoped and disconnect when removed", async () => {
        const created = await post(`/api/org/${owner.orgId}/mcp/oauth/clients`, { headers: authHeader(owner.token), body: { name: "Named connector", redirectUris: [callback] } });
        assert.equal(created.status, 201); const named = created.json.data;
        const stored = await McpClient.findOne({ clientId: named.clientId }).select("+secretHash").lean(); assert.equal(stored.secretHash, sha(named.clientSecret));
        const using = { client_id: named.clientId, client_secret: named.clientSecret };
        const start = await begin({}, using); const info = (await get(`/api/auth/mcp/authorize/${start.id}`, { cookie: sibling.cookie })).json.data;
        assert.equal(info.organizations.length, 0);
        const grant = await approve(owner, {}, using);
        assert.equal((await exchange(grant, { client_secret: "wrong" })).status, 401);
        const tokens = (await exchange(grant)).json; assert.equal((await rpc(tokens.access_token)).status, 200);
        const listed = (await get(`/api/org/${owner.orgId}/mcp/oauth`, { headers: authHeader(owner.token) })).json.data;
        assert.ok(listed.clients.some(row => row.clientId === named.clientId)); assert.ok(listed.connections.some(row => row.clientName === "Named connector"));
        assert.ok(!JSON.stringify(listed).includes(named.clientSecret)); assert.ok(!JSON.stringify(listed).includes(stored.secretHash));
        assert.equal((await del(`/api/org/${sibling.orgId}/mcp/oauth/clients/${named.clientId}`, { headers: authHeader(sibling.token) })).status, 404);
        assert.equal((await del(`/api/org/${owner.orgId}/mcp/oauth/clients/${named.clientId}`, { headers: authHeader(owner.token) })).status, 200);
        assert.equal((await rpc(tokens.access_token)).status, 401);
    });
    test("management rejects non-admin members and cross-organization dashboard tokens", async () => {
        assert.equal((await get(`/api/org/${owner.orgId}/mcp/oauth`, { headers: authHeader(sibling.token) })).status, 403);
        await Member.updateOne({ orgId: owner.orgId, email: owner.email }, { $set: { role: MemberRole.AGENT } });
        try { assert.equal((await get(`/api/org/${owner.orgId}/mcp/oauth`, { headers: authHeader(owner.token) })).status, 403); }
        finally { await Member.updateOne({ orgId: owner.orgId, email: owner.email }, { $set: { role: MemberRole.OWNER } }); }
    });
    test("OAuth body limits, CORS and cache policy are explicit", async () => {
        const oversized = await fetch(`${BASE_URL}/oauth/mcp/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ padding: "x".repeat(17_000) }) });
        assert.equal(oversized.status, 413); assert.equal(oversized.headers.get("cache-control"), "private, no-store");
        const metadata = await get("/.well-known/oauth-protected-resource/mcp", { headers: { origin: "https://client.example" } });
        assert.equal(metadata.headers.get("access-control-allow-origin"), "*"); assert.equal(metadata.headers.get("cache-control"), "private, no-store");
        const settings = await get(`/api/org/${owner.orgId}/mcp/oauth`, { headers: authHeader(owner.token) }); assert.equal(settings.headers.get("cache-control"), "private, no-store");
        const grant = await approve();
        const response = await fetch(`${BASE_URL}/oauth/mcp/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ client_id: client.client_id, grant_type: "authorization_code", code: grant.code, redirect_uri: callback, code_verifier: grant.verifier, resource }) });
        assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
    });
});

describe("MCP workspace scope authorization", () => {
    test("requested workspace scopes survive consent, code exchange, refresh and transport discovery", async () => {
        const requested = "zealoop:write zealoop:read zealoop:install zealoop:read";
        const grant = await approve(owner, { scope: requested });
        assert.equal(grant.info.scope, "zealoop:install zealoop:read zealoop:write");
        const exchanged = await exchange(grant); assert.equal(exchanged.status, 200);
        assert.equal(exchanged.json.scope, grant.info.scope);
        const sdk = new Client({ name: "workspace-oauth", version: "1" });
        try {
            await sdk.connect(new StreamableHTTPClientTransport(new URL(resource), { requestInit: { headers: authHeader(exchanged.json.access_token) } }));
            assert.equal((await sdk.listTools()).tools.length, 38);
            const status = await sdk.callTool({ name: "zealoop_get_workspace_status", arguments: {} });
            assert.equal(status.structuredContent.data.workspace.orgId, owner.orgId);
        } finally { await sdk.close(); }
        const rotated = await refresh(exchanged.json, { scope: "zealoop:read" }); assert.equal(rotated.status, 200); assert.equal(rotated.json.scope, "zealoop:read");
        const read = new Client({ name: "oauth-reader", version: "1" });
        try {
            await read.connect(new StreamableHTTPClientTransport(new URL(resource), { requestInit: { headers: authHeader(rotated.json.access_token) } }));
            const names = (await read.listTools()).tools.map(row => row.name);
            assert.ok(names.includes("zealoop_get_workspace_status")); assert.ok(!names.includes("zealoop_create_config")); assert.ok(!names.includes("zealoop_get_install_config"));
        } finally { await read.close(); }
    });
    test("installation consent cannot upgrade through code or refresh scope parameters", async () => {
        const grant = await approve();
        const forbidden = await exchange(grant, { scope: "zealoop:install zealoop:read zealoop:write" });
        assert.equal(forbidden.status, 400); assert.equal(forbidden.json.error, "invalid_scope");
        const original = await exchange(grant); assert.equal(original.status, 200); assert.equal(original.json.scope, scope);
        const upgraded = await refresh(original.json, { scope: "zealoop:write" }); assert.equal(upgraded.status, 400); assert.equal(upgraded.json.error, "invalid_scope");
        const valid = await refresh(original.json); assert.equal(valid.status, 200); assert.equal(valid.json.scope, scope);
        const credential = await McpGrant.findOne({ accessHash: sha(valid.json.access_token) }).lean();
        await McpGrant.collection.updateOne({ grantId: credential.grantId }, { $unset: { scope: 1, accessScope: 1 } });
        const response = await rpc(valid.json.access_token); assert.equal(response.status, 200);
        const text = await response.text(); const payload = JSON.parse(text.split("\n").find(line => line.startsWith("data:"))?.slice(5) || text);
        assert.equal(payload.result.tools.length, 3);
    });
});
