"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const Conversation = require("../models/conversation/conversation");
const EndUser = require("../models/user/endUser");
const { post, authHeader, createIsolatedOrg } = require("./helpers/client");

let workspace, other, secret;
const email = "history-owner@example.com";
const userId = "eu_history_owner", strangerId = "eu_history_stranger";
const ownId = "conv_history_owner", strangerConv = "conv_history_stranger";
const signed = () => ({ email, signature: crypto.createHmac("sha256", secret).update(email).digest("hex") });
const list = (identity, conversationIds = []) => post("/api/widget/conversations", {
    body: { publicKey: workspace.publicKey, conversationIds, ...(identity ? { identity } : {}) },
});

before(async () => {
    await mongoose.connect(process.env.TEST_MONGODB_URI);
    workspace = await createIsolatedOrg("widget-history");
    other = await createIsolatedOrg("widget-history-other");
    secret = (await post(`/api/org/${workspace.orgId}/widget-secret/reveal`, { headers: authHeader(workspace.token) })).json.data.widgetSecret;
    await EndUser.create([
        { orgId: workspace.orgId, endUserId: userId, email, verified: false },
        { orgId: workspace.orgId, endUserId: strangerId, email: "another@example.com", verified: true },
        { orgId: other.orgId, endUserId: "eu_history_other_workspace", email, verified: true },
    ]);
    await Conversation.create([
        { orgId: workspace.orgId, conversationId: ownId, endUserId: userId, lastMessageAt: new Date(), lastMessagePreview: "My saved chat" },
        { orgId: workspace.orgId, conversationId: strangerConv, endUserId: strangerId, lastMessageAt: new Date(), lastMessagePreview: "Private stranger chat" },
        { orgId: workspace.orgId, conversationId: "conv_history_email", endUserId: userId, channel: "EMAIL", lastMessageAt: new Date() },
        { orgId: other.orgId, conversationId: "conv_history_other_workspace", endUserId: "eu_history_other_workspace", lastMessageAt: new Date() },
    ]);
});
after(async () => { await mongoose.disconnect(); });

test("a valid signed identity recovers its chat history without any saved IDs", async () => {
    const result = await list(signed());
    assert.equal(result.status, 200);
    assert.deepEqual(result.json.data.map(c => c.conversationId), [ownId]);
    assert.equal(result.json.data[0].preview, "My saved chat");
    assert.equal((await EndUser.findOne({ endUserId: userId })).verified, false, "history reads do not alter the profile");
});

test("anonymous, unsigned, malformed and forged identities cannot discover history", async () => {
    for (const identity of [null, { email }, { email, signature: "00".repeat(32) }, { email, signature: { $ne: null } }, { email: { $ne: null }, signature: signed().signature }, { email: "another@example.com", signature: signed().signature }]) {
        const result = await list(identity);
        if (typeof identity?.email === "object" || typeof identity?.signature === "object") {
            assert.equal(result.status, 400, "input middleware rejects structured identity values");
            assert.equal(result.json.success, false);
        } else {
            assert.equal(result.status, 200);
            assert.deepEqual(result.json.data, []);
        }
    }
});

test("an anonymous visitor can still hydrate the exact IDs they already possess", async () => {
    const result = await list(null, [ownId, "conv_history_other_workspace"]);
    assert.equal(result.status, 200);
    assert.deepEqual(result.json.data.map(c => c.conversationId), [ownId]);
});

test("signed discovery combines known IDs without duplicates and keeps tenant isolation", async () => {
    const result = await list(signed(), [ownId, strangerConv, "conv_history_other_workspace"]);
    assert.equal(result.status, 200);
    assert.deepEqual(result.json.data.map(c => c.conversationId).sort(), [ownId, strangerConv].sort());
});

test("a signature from another workspace cannot discover this workspace's history", async () => {
    const otherSecret = (await post(`/api/org/${other.orgId}/widget-secret/reveal`, { headers: authHeader(other.token) })).json.data.widgetSecret;
    const result = await list({ email, signature: crypto.createHmac("sha256", otherSecret).update(email).digest("hex") });
    assert.deepEqual(result.json.data, []);
});

test("recovered history is bounded to the newest 20 conversations", async () => {
    await Conversation.insertMany(Array.from({ length: 25 }, (_, i) => ({ orgId: workspace.orgId, endUserId: userId,
        conversationId: `conv_history_many_${i}`, lastMessageAt: new Date(Date.now() + (i + 1) * 1000) })));
    const result = await list(signed());
    assert.equal(result.json.data.length, 20);
    assert.equal(result.json.data[0].conversationId, "conv_history_many_24");
    assert.equal(result.json.data.at(-1).conversationId, "conv_history_many_5");
});
