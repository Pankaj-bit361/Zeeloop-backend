"use strict";
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const crypto = require("node:crypto");
const http = require("node:http");
const zlib = require("node:zlib");
const WebSocket = require("ws");
const config = require("../config/config");
const Account = require("../models/user/account");
const AuthToken = require("../models/user/authToken");
const Member = require("../models/org/member");
const Conversation = require("../models/conversation/conversation");
const Message = require("../models/conversation/message");
const Action = require("../models/action/action");
const ActionExecution = require("../models/action/actionExecution");
const RealtimeEvent = require("../models/conversation/realtimeEvent");
const RateBucket = require("../models/security/rateBucket");
const Org = require("../models/org/org");
const auth = require("../functions/auth/authFunctions");
const chat = require("../functions/chat/chatFunctions");
const actions = require("../functions/action/actionFunctions");
const agent = require("../functions/agent/agentFunctions");
const session = require("../functions/utilFunctions/sessionFunctions");
const outbound = require("../functions/utilFunctions/outboundRequest");
const { consumeShared } = require("../middlewares/rateLimit");
const { BASE_URL, get, post, patch, authHeader, createIsolatedOrg, randomSuffix } = require("./helpers/client");
let org;
before(async () => {
    await mongoose.connect(process.env.TEST_MONGODB_URI);
    await Promise.all([ActionExecution.init(), RateBucket.init()]);
    org = await createIsolatedOrg("hardening");
});
after(async () => { await mongoose.disconnect(); });

async function signup() {
    const email = `secure-${randomSuffix()}@example.com`;
    const result = await post("/api/auth/signup", { body: { name: "Secure", email, password: "original-password" } });
    assert.equal(result.status, 201);
    return { email, cookie: result.setCookie.split(";")[0], token: new URL(result.json.data.verificationUrl).searchParams.get("token") };
}
async function proposal(extra = {}) {
    const actionId = `act_${randomSuffix()}`;
    await Action.create({ orgId: org.orgId, actionId, name: "Change order", description: "Test write", urlTemplate: "https://example.com/orders",
        accessType: "WRITE", method: "POST", enabled: true, lastTestStatus: "PASS", requiresIdentity: false, requiresConfirmation: false,
        mockEnabled: true, mockResponse: { ok: true } });
    const conversationId = `conv_${randomSuffix()}`, proposalId = `proposal_${randomSuffix()}`;
    await Conversation.create({ orgId: org.orgId, conversationId, pendingAction: {
        actionId, proposalId, args: { orderId: "own-order" }, state: "PENDING", expiresAt: new Date(Date.now() + 60_000), ...extra } });
    return { actionId, conversationId, proposalId, publicKey: org.publicKey };
}

describe("verified accounts and revocable credentials", () => {
    test("an invited address cannot claim a seat until its email is verified", async () => {
        const user = await signup();
        await Member.create({ orgId: org.orgId, memberId: `mem_${randomSuffix()}`, email: user.email, name: "Invited", role: "ADMIN", status: "INVITED" });
        assert.equal((await post("/api/auth/token", { cookie: user.cookie, body: { orgId: org.orgId } })).status, 403);
        assert.equal((await get("/api/auth/me", { cookie: user.cookie })).json.data.orgs.length, 0);
        assert.equal((await Member.findOne({ orgId: org.orgId, email: user.email })).status, "INVITED");
        assert.equal((await post("/api/auth/verify-email", { cookie: user.cookie, body: { token: user.token } })).status, 200);
        assert.equal((await post("/api/auth/token", { cookie: user.cookie, body: { orgId: org.orgId } })).status, 200);
    });
    test("verification tokens are hashed, scoped to the account, and single use", async () => {
        const a = await signup(), b = await signup();
        assert.equal(await AuthToken.countDocuments({ token: a.token }), 0);
        assert.equal(await AuthToken.countDocuments({ token: crypto.createHash("sha256").update(a.token).digest("hex") }), 1);
        assert.equal((await post("/api/auth/verify-email", { cookie: b.cookie, body: { token: a.token } })).status, 400);
        const results = await Promise.all([1, 2].map(() => post("/api/auth/verify-email", { cookie: a.cookie, body: { token: a.token } })));
        assert.deepEqual(results.map(r => r.status).sort(), [200, 400]);
    });
    test("expired verification links fail", async () => {
        const user = await signup();
        await AuthToken.updateOne({ token: crypto.createHash("sha256").update(user.token).digest("hex") }, { expiresAt: new Date(Date.now() - 1000) });
        assert.equal((await post("/api/auth/verify-email", { cookie: user.cookie, body: { token: user.token } })).status, 400);
    });
    test("logout revokes an existing cookie and org JWT", async () => {
        const isolated = await createIsolatedOrg("logout-revoke");
        assert.equal((await post("/api/auth/logout", { cookie: isolated.cookie })).status, 200);
        assert.equal((await get("/api/auth/me", { cookie: isolated.cookie })).status, 401);
        assert.equal((await get(`/api/org/${isolated.orgId}/settings`, { headers: authHeader(isolated.token) })).status, 401);
    });
    test("agent seats cannot change legacy workspace settings or reveal signing secrets", async () => {
        const isolated = await createIsolatedOrg("legacy-role");
        await Member.updateOne({ orgId: isolated.orgId, email: isolated.email }, { role: "AGENT" });
        const headers = authHeader(isolated.token);
        assert.equal((await patch(`/api/org/${isolated.orgId}/settings`, { headers, body: { name: "unauthorized" } })).status, 403);
        for (const operation of ["reveal", "rotate"]) {
            assert.equal((await post(`/api/org/${isolated.orgId}/widget-secret/${operation}`, { headers })).status, 403);
        }
    });
    test("concurrent reset links can change the password only once and revoke old sessions", async () => {
        const user = await signup();
        const links = await Promise.all([1, 2].map(() => post("/api/auth/forgot-password", { body: { email: user.email } })));
        const results = await Promise.all(links.map((link, i) => post("/api/auth/reset-password", { body: {
            token: new URL(link.json.data.resetUrl).searchParams.get("token"), password: `new-password-${i}` } })));
        assert.deepEqual(results.map(r => r.status).sort(), [200, 400]);
        assert.equal((await get("/api/auth/me", { cookie: user.cookie })).status, 401);
        assert.equal((await post("/api/auth/login", { body: { email: user.email, password: "original-password" } })).status, 401);
    });
    test("OAuth ownership cannot preserve a password planted by a pre-registration attacker", async () => {
        const user = await signup();
        const result = await auth._findOrCreateAccount({ email: user.email, name: "Owner", provider: "GOOGLE" });
        assert.equal(result.success, true);
        assert.ok(result.account.emailVerifiedAt);
        assert.equal(result.account.passwordHash, null);
        assert.equal((await get("/api/auth/me", { cookie: user.cookie })).status, 401);
        assert.equal((await post("/api/auth/login", { body: { email: user.email, password: "original-password" } })).status, 401);
    });
    test("email delivery really calls the provider and never exposes links without the development flag", async t => {
        const emailFunctions = require("../functions/email/emailFunctions");
        const originalKey = config.EMAIL_API_KEY, originalFlag = config.ALLOW_DEV_AUTH_LINKS;
        config.EMAIL_API_KEY = "fixture-email-key"; config.ALLOW_DEV_AUTH_LINKS = false;
        let sent;
        t.mock.method(emailFunctions, "_deliver", async input => { sent = input; return { success: true }; });
        try {
            const account = await Account.findOne({ email: org.email });
            const result = await auth.forgotPassword({ email: org.email });
            assert.equal(result.status, 200); assert.equal(result.json.data.resetUrl, null);
            assert.ok(sent.to === account.email && sent.text.includes("/reset-password?token="));
        } finally { config.EMAIL_API_KEY = originalKey; config.ALLOW_DEV_AUTH_LINKS = originalFlag; }
    });
});

describe("single-use action approvals", () => {
    test("missing and non-boolean confirmations never execute", async () => {
        const input = await proposal();
        for (const confirmed of [undefined, null, "true", 1]) assert.equal((await chat.confirmAction({ ...input, confirmed })).status, 400);
        assert.equal(await ActionExecution.countDocuments({ actionId: input.actionId }), 0);
    });
    test("a stale proposal cannot approve the current action", async () => {
        const input = await proposal();
        assert.equal((await chat.confirmAction({ ...input, proposalId: "old", confirmed: true })).status, 409);
    });
    test("expired approvals never run", async () => {
        const input = await proposal({ expiresAt: new Date(Date.now() - 1000) });
        assert.equal((await chat.confirmAction({ ...input, confirmed: true })).status, 409);
        assert.equal(await ActionExecution.countDocuments({ actionId: input.actionId }), 0);
        assert.equal((await chat.bootstrap(input)).json.data.pendingAction, null);
    });
    test("two simultaneous confirmations execute only once, including after replay", async () => {
        const input = await proposal();
        const results = await Promise.all([1, 2].map(() => chat.confirmAction({ ...input, confirmed: true })));
        assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
        assert.equal(await ActionExecution.countDocuments({ actionId: input.actionId, status: "EXECUTED" }), 1);
        assert.equal((await chat.confirmAction({ ...input, confirmed: true })).status, 409);
    });
    test("cancel consumes the proposal without executing", async () => {
        const input = await proposal();
        assert.equal((await chat.confirmAction({ ...input, confirmed: false })).status, 200);
        assert.equal(await ActionExecution.countDocuments({ actionId: input.actionId }), 0);
        assert.equal((await chat.confirmAction({ ...input, confirmed: true })).status, 409);
    });
    test("write approval is mandatory even if requiresConfirmation was disabled", async () => {
        const input = await proposal();
        const result = await actions.executeAction({ orgId: org.orgId, actionId: input.actionId, args: {}, confirmed: false, identityVerified: true });
        assert.equal(result.blockReason, "CONFIRMATION_REQUIRED");
    });
    test("an identity-bound proposal cannot be confirmed anonymously", async () => {
        const input = await proposal({ endUserId: "eu_verified_customer" });
        assert.equal((await chat.confirmAction({ ...input, confirmed: true })).status, 403);
    });
    test("the execution key blocks a second network request even outside the chat claim", async () => {
        const input = await proposal();
        const args = { orgId: org.orgId, actionId: input.actionId, confirmed: true, identityVerified: true, idempotencyKey: input.proposalId };
        const results = await Promise.all([actions.executeAction(args), actions.executeAction(args)]);
        assert.equal(results.filter(r => r.success).length, 1);
        assert.equal(results.filter(r => r.uncertain).length, 1);
        assert.equal(await ActionExecution.countDocuments({ idempotencyKey: input.proposalId }), 1);
    });
    test("unknown write outcomes escalate and cannot be automatically retried", async t => {
        const input = await proposal();
        t.mock.method(actions, "_callEndpoint", async () => ({ success: false, uncertain: true, error: "timeout" }));
        assert.equal((await chat.confirmAction({ ...input, confirmed: true })).status, 200);
        assert.equal((await Conversation.findOne({ conversationId: input.conversationId })).status, "ESCALATED");
        assert.equal((await ActionExecution.findOne({ idempotencyKey: input.proposalId })).status, "UNKNOWN");
        assert.equal((await chat.confirmAction({ ...input, confirmed: true })).status, 409);
    });
    test("a process interrupted during a write recovers to human review without retry", async () => {
        const input = await proposal();
        await Conversation.updateOne({ conversationId: input.conversationId }, { $set: {
            "pendingAction.state": "EXECUTING", "pendingAction.startedAt": new Date(Date.now() - 6 * 60_000) } });
        const result = await chat.bootstrap(input);
        assert.equal(result.status, 200);
        assert.equal(result.json.data.pendingAction, null);
        assert.equal((await Conversation.findOne({ conversationId: input.conversationId })).pendingAction.state, "UNKNOWN");
        assert.equal((await chat.confirmAction({ ...input, confirmed: true })).status, 409);
        const followup = await chat.sendMessage({ ...input, content: "Please check the outcome" });
        assert.equal(followup.json.data.awaitingHuman, true);
        assert.equal(await ActionExecution.countDocuments({ actionId: input.actionId }), 0);
    });
    test("identity inputs override model-supplied addresses and fail for unsigned visitors", () => {
        const action = { dataInputs: [{ name: "email", source: "IDENTITY", required: true }] };
        const resolved = actions.resolveDataInputs({ action, args: { email: "victim@example.com" }, context: { email: "owner@example.com", identityVerified: true } });
        assert.equal(resolved.resolved.email, "owner@example.com");
        const unsigned = actions.resolveDataInputs({ action, args: { email: "victim@example.com" }, context: { email: "owner@example.com", identityVerified: false } });
        assert.equal(unsigned.ready, false); assert.equal(unsigned.resolved.email, undefined);
        assert.equal(actions.resolveDataInputs({ action, args: {}, context: { email: "owner@example.com" } }).ready, false);
    });
});

describe("chat reliability", () => {
    test("the generator receives the newest 50 history messages in chronological order", async t => {
        const conversationId = `conv_${randomSuffix()}`;
        await Conversation.create({ orgId: org.orgId, conversationId });
        await Message.insertMany(Array.from({ length: 60 }, (_, i) => ({ orgId: org.orgId, conversationId,
            messageId: `msg_${randomSuffix()}`, role: "USER", content: `history-${i}`, createdAt: new Date(Date.now() - 100_000 + i * 1000) })));
        let history;
        t.mock.method(agent, "runTurn", async input => { history = input.history; return { reply: "fixture reply", outcome: "ANSWERED" }; });
        const result = await chat.sendMessage({ publicKey: org.publicKey, conversationId, content: "new question" });
        assert.equal(result.status, 200);
        assert.equal(history.length, 50);
        assert.equal(history[0].content, "history-10");
        assert.equal(history[49].content, "history-59");
    });
    test("a simultaneous message is refused while the generator is running", async t => {
        const conversationId = `conv_${randomSuffix()}`;
        await Conversation.create({ orgId: org.orgId, conversationId });
        let started, finish;
        const entered = new Promise(resolve => { started = resolve; });
        const released = new Promise(resolve => { finish = resolve; });
        t.mock.method(agent, "runTurn", async () => { started(); await released; return { reply: "fixture reply", outcome: "ANSWERED" }; });
        const first = chat.sendMessage({ publicKey: org.publicKey, conversationId, content: "first question" });
        await entered;
        try {
            assert.equal((await chat.sendMessage({ publicKey: org.publicKey, conversationId, content: "second question" })).status, 409);
        } finally { finish(); }
        assert.equal((await first).status, 200);
        assert.equal(await Message.countDocuments({ conversationId, role: "USER" }), 1);
    });
    test("a human taking over during generation suppresses the in-flight AI response", async t => {
        const conversationId = `conv_${randomSuffix()}`;
        await Conversation.create({ orgId: org.orgId, conversationId });
        t.mock.method(agent, "runTurn", async () => {
            assert.equal((await chat.replyAsHuman({ orgId: org.orgId, conversationId, content: "The team is here" })).status, 200);
            return { reply: "stale AI reply", outcome: "ANSWERED" };
        });
        const result = await chat.sendMessage({ publicKey: org.publicKey, conversationId, content: "help" });
        assert.equal(result.json.data.awaitingHuman, true);
        assert.equal(await Message.countDocuments({ conversationId, role: "ASSISTANT" }), 0);
        assert.equal(await Message.countDocuments({ conversationId, role: "HUMAN_AGENT" }), 1);
    });
    test("bootstrap returns the newest 100 messages in chronological order", async () => {
        const conversationId = `conv_${randomSuffix()}`;
        await Conversation.create({ orgId: org.orgId, conversationId });
        await Message.insertMany(Array.from({ length: 120 }, (_, i) => ({ orgId: org.orgId, conversationId,
            messageId: `msg_${randomSuffix()}`, role: "USER", content: `question-${i}`, createdAt: new Date(Date.now() - 200_000 + i * 1000) })));
        const result = await chat.bootstrap({ publicKey: org.publicKey, conversationId });
        assert.equal(result.json.data.messages.length, 100);
        assert.equal(result.json.data.messages[0].content, "question-20");
        assert.equal(result.json.data.messages[99].content, "question-119");
    });
    test("handoff stores the visitor's message without another AI reply or charge", async t => {
        const conversationId = `conv_${randomSuffix()}`;
        await Conversation.create({ orgId: org.orgId, conversationId, status: "ESCALATED", hasHumanReply: true });
        const mock = t.mock.method(agent, "runTurn", async () => { throw new Error("AI must not run during handoff"); });
        const result = await chat.sendMessage({ publicKey: org.publicKey, conversationId, content: "new information" });
        assert.equal(result.status, 200); assert.equal(result.json.data.awaitingHuman, true);
        assert.equal(mock.mock.callCount(), 0);
        assert.equal(await Message.countDocuments({ conversationId, role: "USER" }), 1);
        assert.equal(await Message.countDocuments({ conversationId, role: "ASSISTANT" }), 0);
        assert.equal((await Conversation.findOne({ conversationId })).turnLease?.id, undefined);
    });
    test("an active turn lease prevents another message and approval", async () => {
        const input = await proposal();
        await Conversation.updateOne({ conversationId: input.conversationId }, { turnLease: { id: "busy", expiresAt: new Date(Date.now() + 60_000) } });
        assert.equal((await chat.sendMessage({ ...input, content: "another message" })).status, 409);
        assert.equal((await chat.confirmAction({ ...input, confirmed: true })).status, 409);
        assert.equal(await Message.countDocuments({ conversationId: input.conversationId }), 0);
    });
});

describe("outbound destinations and bounded I/O", () => {
    test("origin enforcement checks frame ancestors while allowing its own API origin", async () => {
        const isolated = await createIsolatedOrg("frame-origins");
        await Org.updateOne({ orgId: isolated.orgId }, { $set: { "widget.enforceOriginAllowlist": true,
            "widget.allowedOrigins": ["https://customer.example", "https://*.customer.example"] } });
        const frame = await fetch(`${BASE_URL}/widget/frame/?pk=${encodeURIComponent(isolated.publicKey)}`);
        assert.equal(frame.status, 200);
        assert.match(frame.headers.get("content-security-policy"), /frame-ancestors https:\/\/customer\.example https:\/\/\*\.customer\.example/);
        assert.equal(frame.headers.get("cache-control"), "private, no-store");
        assert.equal((await post("/api/widget/bootstrap", { headers: { origin: new URL(BASE_URL).origin }, body: { publicKey: isolated.publicKey } })).status, 200);
        assert.equal((await post("/api/widget/bootstrap", { headers: { origin: "https://unlisted.example" }, body: { publicKey: isolated.publicKey } })).status, 403);
        const preview = await fetch(`${BASE_URL}/widget/frame/?pk=${encodeURIComponent(isolated.publicKey)}&preview=1`);
        assert.ok(preview.headers.get("content-security-policy").includes(config.CORS_DASHBOARD_ORIGINS[0]));
    });
    test("blocks private, metadata, mapped IPv6, reserved and credential-bearing URLs", () => {
        const original = config.ALLOW_TEST_LOOPBACK; config.ALLOW_TEST_LOOPBACK = false;
        try {
            for (const url of ["http://127.0.0.1", "http://2130706433", "http://0x7f000001", "http://10.0.0.1", "http://169.254.169.254", "http://100.64.0.1", "http://[::ffff:127.0.0.1]", "http://[fc00::1]", "http://[2002:7f00:1::]", "http://localhost", "http://test.local", "https://user:secret@example.com", "file:///etc/passwd"]) {
                assert.throws(() => outbound.parseDestination(url), undefined, url);
            }
            assert.equal(outbound.isPublicAddress("8.8.8.8"), true);
            assert.equal(outbound.isPublicAddress("2606:4700:4700::1111"), true);
        } finally { config.ALLOW_TEST_LOOPBACK = original; }
    });
    test("rejects public-looking DNS names with private or mixed address results", async () => {
        for (const records of [[{ address: "10.1.1.1", family: 4 }], [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]]) {
            await assert.rejects(() => outbound.resolveDestination("https://public-looking.example", { lookup: async () => records }), /private/);
        }
    });
    test("valid DNS is checked once and returns a pinned public address", async () => {
        let calls = 0;
        const result = await outbound.resolveDestination("https://example.com", { lookup: async () => { calls++; return [{ address: "93.184.216.34", family: 4 }]; } });
        assert.equal(calls, 1); assert.equal(result.address.address, "93.184.216.34");
    });
    test("each redirect is validated and authentication cannot follow an action redirect", async () => {
        const fetchImpl = async () => ({ status: 302, ok: false, headers: new Headers({ location: "https://169.254.169.254/" }), text: async () => "" });
        await assert.rejects(() => outbound.outboundRequest("https://example.com", { fetchImpl }), /private/);
        await assert.rejects(() => outbound.outboundRequest("https://example.com", { fetchImpl, redirect: "error" }), /redirect/);
    });
    test("native requests stop oversized, compressed, interrupted and hung responses", async () => {
        const server = http.createServer((req, res) => {
            if (req.url === "/hang") return;
            if (req.url === "/gzip") { res.setHeader("content-encoding", "gzip"); return res.end(zlib.gzipSync("x".repeat(100_000))); }
            if (req.url === "/cut") { res.setHeader("content-length", "10000"); res.write("partial"); setTimeout(() => res.destroy(), 5); return; }
            res.end("x".repeat(2000));
        });
        await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        try {
            await assert.rejects(() => outbound.outboundRequest(`${base}/big`, { maxBytes: 1024 }), /size/);
            await assert.rejects(() => outbound.outboundRequest(`${base}/gzip`, { maxBytes: 1024 }), /size/);
            await assert.rejects(() => outbound.outboundRequest(`${base}/cut`), /interrupted/);
            await assert.rejects(() => outbound.outboundRequest(`${base}/hang`, { timeoutMs: 30 }), /timed out/);
        } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    });
});

describe("shared infrastructure", () => {
    test("atomic shared rate limits allow only the configured number of concurrent requests", async () => {
        const key = `shared-test-${randomSuffix()}`;
        const results = await Promise.all(Array.from({ length: 30 }, () => consumeShared(key, 5)));
        assert.equal(results.filter(r => r.allowed).length, 5);
    });
    test("a socket receives events persisted by another API instance", async () => {
        const conversationId = `conv_${randomSuffix()}`;
        await Conversation.create({ orgId: org.orgId, conversationId });
        const ws = new WebSocket(`${BASE_URL.replace(/^http/, "ws")}/rtm?pk=${org.publicKey}`);
        try {
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error("Broker event timed out")), 5000);
                ws.on("error", reject);
                ws.on("message", async raw => {
                    const event = JSON.parse(String(raw));
                    if (event.type === "connected") ws.send(JSON.stringify({ type: "subscribe", conversationIds: [conversationId] }));
                    if (event.type === "subscribed") await RealtimeEvent.create({ emitter: "another-instance", orgId: org.orgId, conversationId,
                        payload: { type: "message", conversationId, message: { role: "HUMAN_AGENT", content: "from the other instance" } }, expiresAt: new Date(Date.now() + 60_000) });
                    if (event.type === "message") { clearTimeout(timer); assert.equal(event.message.content, "from the other instance"); resolve(); }
                });
            });
        } finally { ws.close(); }
    });
});
