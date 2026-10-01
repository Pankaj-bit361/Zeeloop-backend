const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const mongoose = require("mongoose");
const { Client, StreamableHTTPClientTransport } = require("@modelcontextprotocol/client");
const { BASE_URL, createIsolatedOrg, get, post, del, authHeader } = require("./helpers/client");
const InstallToken = require("../models/security/installToken");
const Account = require("../models/user/account");
const Member = require("../models/org/member");
const { MemberRole } = require("../config/enums");
const install = require("../functions/mcp/installFunctions");

let workspace, other, token, tokenId, fixture, url;
const rpc = async (method, params = {}, bearer = token, headers = {}) => {
    const response = await fetch(`${BASE_URL}/mcp`, { method: "POST",
        headers: { "content-type": "application/json", ...authHeader(bearer), accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5))).find(item => item.id === 1); }
    return { status: response.status, headers: response.headers, json };
};
before(async () => {
    await mongoose.connect(process.env.TEST_MONGODB_URI);
    workspace = await createIsolatedOrg("mcp"); other = await createIsolatedOrg("mcp-other");
    fixture = http.createServer((req, res) => {
        res.setHeader("content-type", "text/html");
        res.end(req.url === "/empty" ? "<html>Nothing here</html>" : `<html><script>window.zealoop={publicKey:"${workspace.publicKey}"}</script><script src="${BASE_URL}/widget.js"></script></html>`);
    });
    await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${fixture.address().port}`;
});
after(async () => { await new Promise(resolve => fixture.close(resolve)); await mongoose.disconnect(); });

describe("MCP installation integration", () => {
    test("only an owner/admin creates a named token, returned once and hashed", async () => {
        const bad = await post(`/api/org/${workspace.orgId}/mcp/tokens`, { headers: authHeader(workspace.token), body: { name: " " } });
        assert.equal(bad.status, 400);
        const created = await post(`/api/org/${workspace.orgId}/mcp/tokens`, { headers: authHeader(workspace.token), body: { name: "Coding agent" } });
        assert.equal(created.status, 201);
        ({ token, tokenId } = created.json.data);
        assert.match(token, /^zi_[0-9a-f]{64}$/);
        const stored = await InstallToken.findOne({ tokenId }).select("+tokenHash").lean();
        assert.equal(stored.tokenHash, install.hash(token));
        assert.equal(JSON.stringify(stored).includes(token), false);
        const listed = await get(`/api/org/${workspace.orgId}/mcp/tokens`, { headers: authHeader(workspace.token) });
        assert.equal(listed.status, 200);
        assert.equal(JSON.stringify(listed.json).includes(token), false);
        assert.equal(JSON.stringify(listed.json).includes(stored.tokenHash), false);
    });
    test("unauthenticated requests and dashboard JWTs cannot access MCP", async () => {
        assert.equal((await rpc("tools/list", {}, "")).status, 401);
        assert.equal((await rpc("tools/list", {}, workspace.token)).status, 401);
    });
    test("modern SDK client negotiates transport and calls installation tools", async () => {
        const client = new Client({ name: "zealoop-regression", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
        try {
            await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`), { requestInit: { headers: authHeader(token) } }));
            const listed = await client.listTools();
            assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ["zealoop_get_install_config", "zealoop_get_install_instructions", "zealoop_verify_installation"].sort());
            const config = await client.callTool({ name: "zealoop_get_install_config", arguments: {} });
            assert.equal(config.structuredContent.publicKey, workspace.publicKey);
            assert.equal(JSON.stringify(config).includes("widgetSecret"), false);
            const next = await client.callTool({ name: "zealoop_get_install_instructions", arguments: { framework: "next" } });
            assert.equal(next.isError, undefined);
            assert.match(next.structuredContent.code, /"use client"/);
            assert.match(next.structuredContent.code, /useEffect/);
            assert.match(next.structuredContent.code, /shutdown/);
            assert.equal(next.structuredContent.code.includes("npm install"), false);
        } finally { await client.close(); }
    });
    test("legacy initialization and tools/call work without process-local sessions", async () => {
        const initialized = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy-test", version: "1" } });
        assert.equal(initialized.status, 200);
        assert.equal(initialized.json.result.serverInfo.name, "zealoop");
        const result = await rpc("tools/call", { name: "zealoop_get_install_config", arguments: {} });
        assert.equal(result.status, 200);
        assert.equal(result.json.result.structuredContent.orgId, workspace.orgId);
    });
    test("tenant override, unknown tools and invalid frameworks are rejected", async () => {
        for (const params of [
            { name: "zealoop_get_install_config", arguments: { orgId: other.orgId } },
            { name: "zealoop_get_install_config", arguments: { "$ne": null } },
            { name: "zealoop_get_install_instructions", arguments: { framework: "unknown" } },
            { name: "delete_workspace", arguments: {} },
        ]) {
            const response = await rpc("tools/call", params);
            assert.ok(response.json.error || response.json.result?.isError);
        }
    });
    test("wrong workspace cannot list or revoke installation tokens", async () => {
        assert.equal((await get(`/api/org/${workspace.orgId}/mcp/tokens`, { headers: authHeader(other.token) })).status, 403);
        assert.equal((await del(`/api/org/${other.orgId}/mcp/tokens/${tokenId}`, { headers: authHeader(other.token) })).status, 404);
    });
    test("untrusted browser Origin and Host are rejected before dispatch", async () => {
        assert.equal((await rpc("tools/list", {}, token, { origin: "https://attacker.invalid" })).status, 403);
        const status = await new Promise((resolve, reject) => {
            const req = http.request(`${BASE_URL}/mcp`, { method: "POST", headers: { host: "attacker.invalid", ...authHeader(token) } }, res => { res.resume(); resolve(res.statusCode); });
            req.on("error", reject); req.end();
        });
        assert.equal(status, 403);
    });
    test("verification detects only this workspace's source without certifying runtime", async () => {
        const result = await rpc("tools/call", { name: "zealoop_verify_installation", arguments: { websiteUrl: url } });
        assert.equal(result.json.result.structuredContent.status, "snippet_detected");
        assert.equal(result.json.result.structuredContent.runtime.verified, false);
        const empty = await rpc("tools/call", { name: "zealoop_verify_installation", arguments: { websiteUrl: `${url}/empty` } });
        assert.equal(empty.json.result.structuredContent.status, "not_detected");
    });
    test("non-http and credential-bearing verification URLs fail as tool errors", async () => {
        for (const websiteUrl of ["file:///etc/passwd", "http://name:password@example.com/"]) {
            const result = await rpc("tools/call", { name: "zealoop_verify_installation", arguments: { websiteUrl } });
            assert.equal(result.json.result.isError, true);
        }
    });
    test("agent downgrade disables both token management and tool access", async () => {
        await Member.updateOne({ orgId: workspace.orgId, email: workspace.email }, { $set: { role: MemberRole.AGENT } });
        assert.equal((await rpc("tools/list")).status, 401);
        assert.equal((await post(`/api/org/${workspace.orgId}/mcp/tokens`, { headers: authHeader(workspace.token), body: { name: "Denied" } })).status, 403);
        await Member.updateOne({ orgId: workspace.orgId, email: workspace.email }, { $set: { role: MemberRole.OWNER } });
    });
    test("expiry is enforced even while the document remains in MongoDB", async () => {
        await InstallToken.updateOne({ tokenId }, { $set: { expiresAt: new Date(0) } });
        assert.equal((await rpc("tools/list")).status, 401);
        await InstallToken.updateOne({ tokenId }, { $set: { expiresAt: new Date(Date.now() + 60_000) } });
    });
    test("session revocation disables tokens", async () => {
        await Account.updateOne({ email: workspace.email }, { $inc: { sessionVersion: 1 } });
        assert.equal((await rpc("tools/list")).status, 401);
        await Account.updateOne({ email: workspace.email }, { $inc: { sessionVersion: -1 } });
    });
    test("token limits are shared MongoDB budgets", async () => {
        const { consumeShared } = require("../middlewares/rateLimit");
        for (let i = 0; i < 60; i++) await consumeShared(`mcp:token:${tokenId}`, 60, 60_000);
        const limited = await rpc("tools/list");
        assert.equal(limited.status, 429);
        assert.ok(limited.headers.get("retry-after"));
        const RateBucket = require("../models/security/rateBucket");
        await RateBucket.deleteMany({ key: install.hash(`mcp:token:${tokenId}`) });
    });
    test("revoked tokens cannot initialize or invoke tools", async () => {
        assert.equal((await del(`/api/org/${workspace.orgId}/mcp/tokens/${tokenId}`, { headers: authHeader(workspace.token) })).status, 200);
        assert.equal((await rpc("tools/list")).status, 401);
    });
});
