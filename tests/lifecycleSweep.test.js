// The lifecycle sweep and hooks end to end, against the test database, with
// the outgoing Volanea /v1/events call captured instead of sent.
"use strict";
const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const config = require("../config/config");
const Org = require("../models/org/org");
const Member = require("../models/org/member");
const Account = require("../models/user/account");
const Subscription = require("../models/billing/subscription");
const UsageRecord = require("../models/billing/usageRecord");
const KnowledgeSource = require("../models/knowledge/knowledgeSource");
const Conversation = require("../models/conversation/conversation");
const Message = require("../models/conversation/message");
const { runLifecycleSweep } = require("../functions/lifecycle/sweep");
const memberFunctions = require("../functions/member/memberFunctions");
const billingFunctions = require("../functions/billing/billingFunctions");
const usageFunctions = require("../functions/billing/usageFunctions");
const subscriptionFunctions = require("../functions/billing/subscriptionFunctions");

const TEST_URI = process.env.TEST_MONGODB_URI || "mongodb://127.0.0.1:27017/zealoop_lifecycle_email_test";
const DAY = 86_400_000;

let posted = [];
let refuse = false;
const created = [];
const realFetch = globalThis.fetch;

const mine = (orgName) => posted.filter((p) => p.contact && p.contact.data && p.contact.data.workspace === orgName);
const posts = (email) => posted.filter((p) => p.email === email);
async function until(check, ms = 3000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail("timed out waiting for a lifecycle event");
}

async function workspace({ ageDays, plan = "GROWTH", status = "TRIALING", trialDaysLeft = 13 }) {
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const orgId = `org_lc_${id}`;
    const name = `Lifecycle ${id}`;
    const email = `owner_${id}@example.com`;
    const createdAt = new Date(Date.now() - ageDays * DAY);
    await Org.collection.insertOne({ orgId, name, ownerEmail: email, publicKey: `pk_${id}`, widgetSecret: "ws", createdAt, updatedAt: createdAt, suspended: { at: null } });
    await Account.create({ accountId: `acc_${id}`, email, name: "Maya Rao" });
    await Member.create({ orgId, memberId: `mem_${id}`, email, role: "OWNER", status: "ACTIVE", lastActiveAt: new Date() });
    const periodStart = new Date(Date.now() - DAY);
    await Subscription.create({ orgId, subscriptionId: `sub_${id}`, plan, status, currentPeriodStart: periodStart, currentPeriodEnd: new Date(Date.now() + 20 * DAY), trialEndsAt: status === "TRIALING" ? new Date(Date.now() + trialDaysLeft * DAY) : null });
    created.push({ orgId, email });
    return { orgId, name, email, periodStart };
}

before(async () => {
    await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 3000 });
    config.VOLANEA_LIFECYCLE_KEY = "sk_test_lifecycle";
    config.VOLANEA_API_URL = "https://volanea.test";
    globalThis.fetch = async (url, init) => {
        if (String(url).startsWith("https://volanea.test/v1/events")) {
            if (refuse) return new Response("{}", { status: 503 });
            posted.push(JSON.parse(init.body));
            return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        return realFetch(url, init);
    };
});

after(async () => {
    globalThis.fetch = realFetch;
    config.VOLANEA_LIFECYCLE_KEY = "";
    const orgIds = created.map((c) => c.orgId);
    await Promise.all([
        Org.deleteMany({ orgId: { $in: orgIds } }),
        Member.deleteMany({ orgId: { $in: orgIds } }),
        Subscription.deleteMany({ orgId: { $in: orgIds } }),
        UsageRecord.deleteMany({ orgId: { $in: orgIds } }),
        KnowledgeSource.deleteMany({ orgId: { $in: orgIds } }),
        Conversation.deleteMany({ orgId: { $in: orgIds } }),
        Message.deleteMany({ orgId: { $in: orgIds } }),
        Account.deleteMany({ email: { $in: created.map((c) => c.email) } }),
    ]);
    await mongoose.disconnect();
});

beforeEach(() => {
    posted = [];
    refuse = false;
});

describe("lifecycle sweep", () => {
    test("tells a new workspace about its first indexed source and first conversation — once", async () => {
        const w = await workspace({ ageDays: 0.5 });
        await KnowledgeSource.create({ orgId: w.orgId, sourceId: `src_${w.orgId}`, type: "SITEMAP", name: "acme.com", status: "READY", chunkCount: 80 });
        await Conversation.create({ orgId: w.orgId, conversationId: `conv_${w.orgId}`, status: "OPEN" });
        await Message.create({ orgId: w.orgId, messageId: `msg_${w.orgId}`, conversationId: `conv_${w.orgId}`, role: "USER", content: "Do you ship to Canada?" });
        // An evaluation run is not a visitor.
        await Conversation.create({ orgId: w.orgId, conversationId: `conv_eval_${w.orgId}`, status: "OPEN" });

        await runLifecycleSweep({});
        const first = mine(w.name);
        // One tip per sweep: the source first.
        assert.deepEqual(first.map((p) => p.name), ["knowledge.first_ready"]);
        assert.equal(first[0].email, w.email);
        assert.equal(first[0].data.chunks_label, "80 passages");
        assert.equal(first[0].contact.firstName, "Maya");
        assert.equal(first[0].contact.data.plan_tier, "trial");

        posted = [];
        await runLifecycleSweep({});
        assert.deepEqual(mine(w.name), [], "tips are spaced, nothing repeats");

        // A conversation means the widget is live: that is told next, then the
        // conversation itself, with the visitor's question — a day apart each.
        const nextDay = async () => {
            await Org.updateOne({ orgId: w.orgId }, { $set: { "lifecycle.lastTipAt": new Date(Date.now() - 21 * 3_600_000).toISOString() } });
            await runLifecycleSweep({});
        };
        await nextDay();
        await nextDay();
        assert.deepEqual(mine(w.name).map((p) => p.name), ["widget.installed", "conversation.first"]);
        assert.equal(mine(w.name)[1].data.preview, "Do you ship to Canada?");
    });

    test("baselines an older workspace silently", async () => {
        const w = await workspace({ ageDays: 40, plan: "STARTER", status: "ACTIVE" });
        await KnowledgeSource.create({ orgId: w.orgId, sourceId: `src_${w.orgId}`, type: "SITEMAP", name: "old.com", status: "READY", chunkCount: 5 });
        await runLifecycleSweep({});
        assert.deepEqual(mine(w.name), []);
        const org = await Org.findOne({ orgId: w.orgId }).lean();
        assert.ok(org.lifecycle.baselinedAt);
        assert.ok(org.lifecycle.flags["knowledge.first_ready"]);
    });

    test("a refused event isn't marked told, so the next sweep retries it", async () => {
        const w = await workspace({ ageDays: 0.2, trialDaysLeft: 2 });
        refuse = true;
        await runLifecycleSweep({});
        let org = await Org.findOne({ orgId: w.orgId }).lean();
        assert.ok(!Object.keys(org.lifecycle.flags).some((k) => k.startsWith("trial.ending_2")));
        refuse = false;
        await runLifecycleSweep({});
        assert.ok(mine(w.name).some((p) => p.name === "trial.ending_2"));
        org = await Org.findOne({ orgId: w.orgId }).lean();
        assert.ok(Object.keys(org.lifecycle.flags).some((k) => k.startsWith("trial.ending_2")));
    });
});

describe("lifecycle hooks", () => {
    test("an invitation finally reaches the person invited", async () => {
        const w = await workspace({ ageDays: 3 });
        const invitee = `new_${w.orgId}@example.com`;
        created.push({ orgId: w.orgId, email: invitee });
        const result = await memberFunctions.inviteMember({ orgId: w.orgId, email: invitee, role: "AGENT", inviterEmail: w.email });
        assert.equal(result.status, 201);
        await until(() => posts(invitee).length > 0);
        const invite = posts(invitee)[0];
        assert.equal(invite.name, "member.invited");
        assert.equal(invite.data.inviter_name, "Maya Rao");
        assert.equal(invite.data.role, "agent");
        assert.match(invite.data.action_url, /\/signup\?email=/);
    });

    test("crossing 80% of the conversations announces it once, even when two turns race", async () => {
        const w = await workspace({ ageDays: 5, plan: "STARTER", status: "ACTIVE" });
        await UsageRecord.create({ orgId: w.orgId, usageRecordId: `use_${w.orgId}`, periodStart: w.periodStart, periodEnd: new Date(Date.now() + 20 * DAY), plan: "STARTER", conversations: 239 });
        await Promise.all([
            usageFunctions.recordTurn({ orgId: w.orgId, isNewConversation: true }),
            usageFunctions.recordTurn({ orgId: w.orgId, isNewConversation: true }),
        ]);
        await until(() => posts(w.email).some((p) => p.name === "usage.quota_near"));
        await new Promise((resolve) => setTimeout(resolve, 200));
        const near = posts(w.email).filter((p) => p.name === "usage.quota_near");
        assert.equal(near.length, 1);
        assert.equal(near[0].data.limit_label, "300 conversations");
    });

    test("a renewal that fails, then recovers, is told as both", async () => {
        const w = await workspace({ ageDays: 60, plan: "GROWTH", status: "ACTIVE" });
        await billingFunctions._applyEvent({ event: { orgId: w.orgId, status: "PAST_DUE", planId: "GROWTH" } });
        await until(() => posts(w.email).some((p) => p.name === "billing.payment_failed"));
        assert.equal(posts(w.email).find((p) => p.name === "billing.payment_failed").data.plan_name, "Growth");
        await billingFunctions._applyEvent({ event: { orgId: w.orgId, status: "ACTIVE", planId: "GROWTH" } });
        await until(() => posts(w.email).some((p) => p.name === "billing.recovered"));
    });

    test("an expired trial is announced instead of the plain email", async () => {
        const w = await workspace({ ageDays: 15, trialDaysLeft: -0.1 });
        await subscriptionFunctions.runLifecycleSweep({});
        await until(() => posts(w.email).some((p) => p.name === "trial.ended"));
        assert.equal(posts(w.email).find((p) => p.name === "trial.ended").data.conversations, "0");
    });
});
