"use strict";
const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const vm = require("node:vm");
const mongoose = require("mongoose");
const { Client, StreamableHTTPClientTransport } = require("@modelcontextprotocol/client");
const { BASE_URL, createIsolatedOrg, get, post, del, authHeader } = require("./helpers/client");
const InstallToken = require("../models/security/installToken");
const Account = require("../models/user/account");
const Member = require("../models/org/member");
const Org = require("../models/org/org");
const WidgetPing = require("../models/org/widgetPing");
const AuditLog = require("../models/org/auditLog");
const RateBucket = require("../models/security/rateBucket");
const { MemberRole, MemberStatus, AuditAction } = require("../config/enums");
const install = require("../functions/mcp/installFunctions");

let workspace, sibling, credential, server, site;
const hits = [];
const snippet = key => `<html><script>window.zealoop={publicKey:${JSON.stringify(key)}};document.cookie='untrusted-page';</script><script src="${BASE_URL}/widget.js"></script></html>`;
async function raw(body, { method = "POST", headers = {} } = {}) {
    const response = await fetch(`${BASE_URL}/mcp`, { method, headers: {
        "content-type": "application/json", accept: "application/json, text/event-stream", ...authHeader(credential.token), ...headers,
    }, ...(body !== undefined ? { body } : {}) });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text.split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5))).find(item => item.id === "regression"); }
    return { status: response.status, headers: response.headers, json, text };
}
const rpc = (method, params = {}, options) => raw(JSON.stringify({ jsonrpc: "2.0", id: "regression", method, params }), options);
const tool = (name, args = {}) => rpc("tools/call", { name, arguments: args });
const verify = path => tool("zealoop_verify_installation", { websiteUrl: `${site}${path}` });
const data = response => { assert.equal(response.status, 200); assert.notEqual(response.json?.result?.isError, true, response.text); return response.json.result.structuredContent; };

before(async () => {
    await mongoose.connect(process.env.TEST_MONGODB_URI);
    workspace = await createIsolatedOrg("mcp-regression");
    sibling = await createIsolatedOrg("mcp-regression-sibling");
    const created = await post(`/api/org/${workspace.orgId}/mcp/tokens`, { headers: authHeader(workspace.token), body: { name: "Regression agent" } });
    assert.equal(created.status, 201); credential = created.json.data;
    server = http.createServer((req, res) => {
        hits.push(req.url);
        res.setHeader("content-type", "text/html");
        if (req.url === "/redirect") { res.writeHead(302, { location: "/redirect-target" }); res.end(); return; }
        if (req.url === "/hang") return;
        if (req.url === "/oversized") { res.end("x".repeat(1_000_001)); return; }
        if (req.url === "/compressed") { res.setHeader("content-encoding", "gzip"); res.end(zlib.gzipSync("x".repeat(1_000_001))); return; }
        if (req.url === "/interrupted") { res.writeHead(200, { "content-length": "1000" }); res.write("<html>"); setImmediate(() => res.destroy()); return; }
        if (req.url === "/json") res.setHeader("content-type", "application/json");
        if (req.url === "/xhtml") res.setHeader("content-type", "application/xhtml+xml");
        if (req.url === "/error") res.statusCode = 503;
        const contents = {
            "/empty": "<html>No widget</html>", "/wrong-key": snippet(sibling.publicKey),
            "/key-only": `<html>${workspace.publicKey}</html>`, "/loader-only": `<html>${BASE_URL}/widget.js</html>`,
        };
        res.end(contents[req.url] || snippet(workspace.publicKey));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    site = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => { await RateBucket.deleteOne({ key: install.hash(`mcp:token:${credential.tokenId}`) }); });
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await mongoose.disconnect(); });

describe("MCP protocol and credential regression", () => {
    test("malformed JSON is a client error and the next valid request still succeeds", async () => {
        assert.equal((await raw('{"jsonrpc":')).status, 400);
        assert.equal((await rpc("tools/list")).status, 200);
    });
    test("MCP applies its 64 KiB limit before parsing even with whitespace padding", async () => {
        const message = JSON.stringify({ jsonrpc: "2.0", id: "regression", method: "tools/list", params: {} });
        assert.equal((await raw(message + " ".repeat(65_536))).status, 413);
        assert.equal((await rpc("tools/list")).status, 200);
    });
    test("compressed requests cannot bypass the decoded MCP body limit", async () => {
        const message = JSON.stringify({ jsonrpc: "2.0", id: "regression", method: "tools/list", params: { _meta: { padding: "x".repeat(70_000) } } });
        assert.equal((await raw(zlib.gzipSync(message), { headers: { "content-encoding": "gzip" } })).status, 413);
    });
    test("invalid JSON-RPC envelopes fail without dispatching an installation tool", async () => {
        for (const input of [[], { jsonrpc: "1.0", id: 1, method: "tools/list" }, { jsonrpc: "2.0", id: {}, method: "tools/list" }, { jsonrpc: "2.0", id: 1, method: 42 }]) {
            const result = await raw(JSON.stringify(input));
            assert.ok(result.status < 500, result.text);
            assert.ok(result.status >= 400 || result.json?.error, result.text);
            assert.equal(result.json?.result, undefined);
        }
    });
    test("transport rejects unsupported methods and media types", async () => {
        assert.equal((await raw("{}", { method: "PUT" })).status, 405);
        assert.equal((await raw("{}", { headers: { "content-type": "text/plain" } })).status, 415);
        assert.equal((await rpc("tools/list", {}, { headers: { accept: "text/plain" } })).status, 406);
    });
    test("approved origins, namespaced metadata and stateless responses remain compatible", async () => {
        const response = await rpc("tools/list", { _meta: { "example.com/request": "fixture" } }, { headers: { origin: BASE_URL } });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "private, no-store");
        assert.equal(response.headers.get("mcp-session-id"), null);
        assert.ok((await InstallToken.findOne({ tokenId: credential.tokenId }).lean()).lastUsedAt);
    });
    test("installation credentials cannot access token management, conversations or signing secrets", async () => {
        for (const path of [`/api/org/${workspace.orgId}/mcp/tokens`, `/api/org/${workspace.orgId}/conversations`]) {
            assert.equal((await get(path, { headers: authHeader(credential.token) })).status, 401);
        }
        assert.equal((await post(`/api/org/${workspace.orgId}/widget-secret/reveal`, { headers: authHeader(credential.token), body: {} })).status, 401);
    });
    test("unverified issuers lose both management and MCP access", async () => {
        const account = await Account.findOne({ email: workspace.email }).lean();
        try {
            await Account.updateOne({ _id: account._id }, { $set: { emailVerifiedAt: null } });
            assert.equal((await rpc("tools/list")).status, 401);
            assert.equal((await post(`/api/org/${workspace.orgId}/mcp/tokens`, { headers: authHeader(workspace.token), body: { name: "Denied" } })).status, 401);
        } finally { await Account.updateOne({ _id: account._id }, { $set: { emailVerifiedAt: account.emailVerifiedAt } }); }
    });
    test("an inactive membership invalidates existing credentials", async () => {
        try {
            await Member.updateOne({ orgId: workspace.orgId, email: workspace.email }, { $set: { status: MemberStatus.INVITED } });
            assert.equal((await rpc("tools/list")).status, 401);
        } finally { await Member.updateOne({ orgId: workspace.orgId, email: workspace.email }, { $set: { status: MemberStatus.ACTIVE } }); }
    });
    test("admins can create and revoke their credentials", async () => {
        try {
            await Member.updateOne({ orgId: workspace.orgId, email: workspace.email }, { $set: { role: MemberRole.ADMIN } });
            assert.equal((await rpc("tools/list")).status, 200);
            const result = await post(`/api/org/${workspace.orgId}/mcp/tokens`, { headers: authHeader(workspace.token), body: { name: "Admin credential" } });
            assert.equal(result.status, 201);
            assert.equal((await del(`/api/org/${workspace.orgId}/mcp/tokens/${result.json.data.tokenId}`, { headers: authHeader(workspace.token) })).status, 200);
        } finally { await Member.updateOne({ orgId: workspace.orgId, email: workspace.email }, { $set: { role: MemberRole.OWNER } }); }
    });
    test("account and workspace deletion invalidate otherwise live credentials", async () => {
        for (const [Model, query] of [[Account, { email: workspace.email }], [Org, { orgId: workspace.orgId }], [Member, { orgId: workspace.orgId, email: workspace.email }]]) {
            const saved = await Model.findOne(query).lean();
            try { await Model.deleteOne(query); assert.equal((await rpc("tools/list")).status, 401); }
            finally { await Model.create(saved); }
        }
    });
    test("token names reject non-strings and oversize input, and trim accepted values", async () => {
        for (const name of [null, 42, {}, "x".repeat(81)]) {
            assert.equal((await post(`/api/org/${workspace.orgId}/mcp/tokens`, { headers: authHeader(workspace.token), body: { name } })).status, 400);
        }
        const created = await post(`/api/org/${workspace.orgId}/mcp/tokens`, { headers: authHeader(workspace.token), body: { name: "  Trimmed agent  " } });
        assert.equal(created.status, 201); assert.equal(created.json.data.name, "Trimmed agent");
        assert.equal(created.headers.get("cache-control"), "private, no-store");
        const listed = await get(`/api/org/${workspace.orgId}/mcp/tokens`, { headers: authHeader(workspace.token) });
        assert.equal(listed.headers.get("cache-control"), "private, no-store");
        const lifetime = new Date(created.json.data.expiresAt) - new Date(created.json.data.createdAt);
        assert.ok(Math.abs(lifetime - 30 * 24 * 60 * 60_000) < 1000);
        await del(`/api/org/${workspace.orgId}/mcp/tokens/${created.json.data.tokenId}`, { headers: authHeader(workspace.token) });
    });
    test("active token capacity is enforced and expiry frees a slot", async () => {
        const account = await Account.findOne({ email: workspace.email }).lean();
        const rows = Array.from({ length: 19 }, () => ({ orgId: workspace.orgId, accountId: account.accountId,
            sessionVersion: account.sessionVersion || 0, tokenId: `capacity_${crypto.randomUUID()}`, tokenHash: crypto.randomBytes(32).toString("hex"),
            preview: "zi_fixture…", name: "Capacity fixture", expiresAt: new Date(Date.now() + 60_000) }));
        try {
            await InstallToken.insertMany(rows);
            assert.equal((await post(`/api/org/${workspace.orgId}/mcp/tokens`, { headers: authHeader(workspace.token), body: { name: "Too many" } })).status, 409);
            await InstallToken.updateOne({ tokenId: rows[0].tokenId }, { $set: { expiresAt: new Date(0) } });
            const created = await post(`/api/org/${workspace.orgId}/mcp/tokens`, { headers: authHeader(workspace.token), body: { name: "After expiry" } });
            assert.equal(created.status, 201);
            await del(`/api/org/${workspace.orgId}/mcp/tokens/${created.json.data.tokenId}`, { headers: authHeader(workspace.token) });
        } finally { await InstallToken.deleteMany({ tokenId: { $in: rows.map(row => row.tokenId) } }); }
    });
    test("audit records contain credential identities without raw tokens or hashes", async () => {
        const created = await post(`/api/org/${workspace.orgId}/mcp/tokens`, { headers: authHeader(workspace.token), body: { name: "Audit fixture" } });
        assert.equal(created.status, 201);
        await del(`/api/org/${workspace.orgId}/mcp/tokens/${created.json.data.tokenId}`, { headers: authHeader(workspace.token) });
        const logs = await AuditLog.find({ orgId: workspace.orgId, targetId: created.json.data.tokenId }).lean();
        assert.deepEqual(logs.map(row => row.action).sort(), [AuditAction.MCP_TOKEN_CREATED, AuditAction.MCP_TOKEN_REVOKED].sort());
        assert.equal(JSON.stringify(logs).includes(created.json.data.token), false);
        assert.equal(JSON.stringify(logs).includes(install.hash(created.json.data.token)), false);
    });
    test("simultaneous creation cannot exceed workspace token capacity", async () => {
        const account = await Account.findOne({ email: workspace.email }).lean();
        const rows = Array.from({ length: 18 }, () => ({ orgId: workspace.orgId, accountId: account.accountId,
            sessionVersion: account.sessionVersion || 0, tokenId: `concurrent_capacity_${crypto.randomUUID()}`,
            tokenHash: crypto.randomBytes(32).toString("hex"), preview: "zi_fixture…", name: "Concurrent capacity fixture",
            expiresAt: new Date(Date.now() + 60_000) }));
        let results = [];
        try {
            await InstallToken.insertMany(rows);
            results = await Promise.all(Array.from({ length: 8 }, (_, i) => post(`/api/org/${workspace.orgId}/mcp/tokens`, {
                headers: authHeader(workspace.token), body: { name: `Concurrent agent ${i}` },
            })));
            assert.equal(results.filter(result => result.status === 201).length, 1);
            assert.equal(results.filter(result => result.status === 409).length, 7);
            assert.equal(await InstallToken.countDocuments({ orgId: workspace.orgId, revokedAt: null, expiresAt: { $gt: new Date() } }), 20);
        } finally {
            await InstallToken.deleteMany({ tokenId: { $in: [...rows.map(row => row.tokenId), ...results.filter(result => result.status === 201).map(result => result.json.data.tokenId)] } });
        }
    });
    test("a burst into an empty workspace allocates exactly twenty unique slots", async () => {
        let results = [];
        try {
            results = await Promise.all(Array.from({ length: 26 }, (_, i) => post(`/api/org/${sibling.orgId}/mcp/tokens`, {
                headers: authHeader(sibling.token), body: { name: `Burst agent ${i}` },
            })));
            assert.equal(results.filter(result => result.status === 201).length, 20);
            assert.equal(results.filter(result => result.status === 409).length, 6);
            const active = await InstallToken.find({ orgId: sibling.orgId, revokedAt: null }).select("+activeSlot").lean();
            assert.equal(new Set(active.map(row => row.activeSlot)).size, 20);
        } finally { await InstallToken.deleteMany({ tokenId: { $in: results.filter(result => result.status === 201).map(result => result.json.data.tokenId) } }); }
    });
    test("expired assigned slots and revoked slots can be reused without erasing history", async () => {
        const account = await Account.findOne({ email: sibling.email }).lean();
        const rows = Array.from({ length: 20 }, (_, slot) => ({ orgId: sibling.orgId, accountId: account.accountId,
            sessionVersion: account.sessionVersion || 0, tokenId: `reuse_${crypto.randomUUID()}`, activeSlot: slot,
            tokenHash: crypto.randomBytes(32).toString("hex"), preview: "zi_fixture…", name: "Reuse fixture",
            expiresAt: slot === 7 ? new Date(0) : new Date(Date.now() + 60_000) }));
        const minted = [];
        try {
            await InstallToken.insertMany(rows);
            for (let attempt = 0; attempt < 2; attempt++) {
                const created = await post(`/api/org/${sibling.orgId}/mcp/tokens`, { headers: authHeader(sibling.token), body: { name: "Reused slot" } });
                assert.equal(created.status, 201); minted.push(created.json.data.tokenId);
                assert.equal((await InstallToken.findOne({ tokenId: created.json.data.tokenId }).select("+activeSlot").lean()).activeSlot, 7);
                await del(`/api/org/${sibling.orgId}/mcp/tokens/${created.json.data.tokenId}`, { headers: authHeader(sibling.token) });
            }
            assert.equal(await InstallToken.countDocuments({ tokenId: { $in: [rows[7].tokenId, ...minted] } }), 3);
        } finally { await InstallToken.deleteMany({ tokenId: { $in: [...rows.map(row => row.tokenId), ...minted] } }); }
    });
    test("concurrent SDK clients retain their own transport and workspace scope", async () => {
        const siblingCreated = await post(`/api/org/${sibling.orgId}/mcp/tokens`, { headers: authHeader(sibling.token), body: { name: "Sibling agent" } });
        assert.equal(siblingCreated.status, 201);
        await Promise.all([credential.token, siblingCreated.json.data.token, credential.token].map(async (token, index) => {
            const client = new Client({ name: `concurrent-${index}`, version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
            try {
                await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`), { requestInit: { headers: authHeader(token) } }));
                const result = await client.callTool({ name: "zealoop_get_install_config", arguments: {} });
                assert.equal(result.structuredContent.orgId, index === 1 ? sibling.orgId : workspace.orgId);
                assert.equal(JSON.stringify(result).includes(token), false);
            } finally { await client.close(); }
        }));
        await del(`/api/org/${sibling.orgId}/mcp/tokens/${siblingCreated.json.data.tokenId}`, { headers: authHeader(sibling.token) });
    });
});

describe("MCP public-page verification regression", () => {
    test("a different tenant's key or an incomplete snippet never passes source detection", async () => {
        for (const path of ["/empty", "/wrong-key", "/key-only", "/loader-only"]) assert.equal(data(await verify(path)).status, "not_detected", path);
    });
    test("only successful HTML/XHTML responses count; untrusted page text is not returned", async () => {
        for (const path of ["/json", "/error"]) assert.equal(data(await verify(path)).status, "not_detected", path);
        const response = await verify("/xhtml");
        assert.equal(data(response).status, "snippet_detected");
        assert.equal(response.text.includes("document.cookie"), false);
        assert.equal(response.text.includes("untrusted-page"), false);
    });
    test("embedding restrictions override source detection and fragments are stripped", async () => {
        try {
            await Org.updateOne({ orgId: workspace.orgId }, { $set: { "widget.enforceOriginAllowlist": true, "widget.allowedOrigins": ["https://allowed.example"] } });
            assert.equal(data(await verify("/")).status, "origin_blocked");
            await Org.updateOne({ orgId: workspace.orgId }, { $set: { "widget.allowedOrigins": [site] } });
            const response = data(await verify("/#ignored"));
            assert.equal(response.status, "snippet_detected"); assert.equal(response.websiteUrl, `${site}/`);
        } finally { await Org.updateOne({ orgId: workspace.orgId }, { $set: { "widget.enforceOriginAllowlist": false, "widget.allowedOrigins": [] } }); }
    });
    test("recent, stale and cross-tenant telemetry never certifies browser runtime", async () => {
        try {
            await WidgetPing.create({ orgId: sibling.orgId, origin: site, lastSeenAt: new Date() });
            assert.equal(data(await verify("/")).runtime.recentMatchingOriginReported, false);
            await WidgetPing.create({ orgId: workspace.orgId, origin: site, lastSeenAt: new Date() });
            const recent = data(await verify("/"));
            assert.equal(recent.runtime.recentMatchingOriginReported, true); assert.equal(recent.runtime.verified, false);
            await WidgetPing.updateOne({ orgId: workspace.orgId, origin: site }, { $set: { lastSeenAt: new Date(Date.now() - 25 * 60 * 60_000) } });
            assert.equal(data(await verify("/")).runtime.recentMatchingOriginReported, false);
        } finally { await WidgetPing.deleteMany({ orgId: { $in: [workspace.orgId, sibling.orgId] }, origin: site }); }
    });
    test("redirects fail without contacting the target page", async () => {
        const before = hits.filter(path => path === "/redirect-target").length;
        assert.equal((await verify("/redirect")).json.result.isError, true);
        assert.equal(hits.filter(path => path === "/redirect-target").length, before);
    });
    test("oversized, compressed and interrupted HTML fail without leaking response text", async () => {
        for (const path of ["/oversized", "/compressed", "/interrupted"]) {
            const response = await verify(path);
            assert.equal(response.json.result.isError, true, path);
            assert.ok(response.text.length < 2000);
        }
    });
    test("a stalled website stops at the installation check deadline", async () => {
        const start = Date.now();
        assert.equal((await verify("/hang")).json.result.isError, true);
        assert.ok(Date.now() - start < 15_000);
        assert.equal(data(await verify("/")).status, "snippet_detected");
    });
    test("metadata, private, local and mapped IPv6 destinations never reach the fixture", async () => {
        const before = hits.length;
        for (const websiteUrl of ["http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/", "http://[fd00::1]/", "http://[::ffff:127.0.0.1]/", "http://service.local/"]) {
            assert.equal((await tool("zealoop_verify_installation", { websiteUrl })).json.result.isError, true, websiteUrl);
        }
        assert.equal(hits.length, before);
    });
});

describe("generated MCP installation code regression", () => {
    test("every framework gets scoped public config and executable loader code", async () => {
        for (const framework of ["html", "wordpress", "react", "next"]) {
            const result = data(await tool("zealoop_get_install_instructions", { framework }));
            const scripts = [], effects = [], window = {};
            const context = vm.createContext({ window, useEffect: fn => effects.push(fn), document: {
                createElement: () => ({}), head: { appendChild: element => scripts.push(element) },
            } });
            if (framework === "html" || framework === "wordpress") {
                const source = result.code.replace(/^<script>\s*/, "").replace(/\s*<\/script>$/, "");
                vm.runInContext(source, context); vm.runInContext(source, context);
                assert.equal(window.Zealoop.q[0][0], "boot");
            } else {
                const source = result.code.replace(/import \{ useEffect \} from "react";\s*/, "").replace("export default function", "function");
                vm.runInContext(source, context); context.ZealoopMessenger();
                const cleanup = effects[0](); cleanup(); effects[0]();
                assert.deepEqual(Array.from(window.Zealoop.q, args => args[0]), ["boot", "shutdown", "boot"]);
            }
            assert.equal(scripts.length, 1, framework); assert.equal(scripts[0].async, true);
            assert.equal(scripts[0].src, `${BASE_URL}/widget.js`); assert.equal(window.zealoop.publicKey, workspace.publicKey);
            assert.equal(result.code.includes(credential.token), false);
            if (framework === "next") assert.ok(result.code.startsWith('"use client";'));
        }
    });
});
