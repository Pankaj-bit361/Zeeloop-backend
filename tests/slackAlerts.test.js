// Business alerts in #zealoop-alerts (functions/lifecycle/slack.js): an
// allow-listed moment posts exactly once with the right fields, anything else
// posts nothing, nothing posts without the webhook or with SLACK_ALERTS=off,
// and a Slack failure never reaches the caller. The Slack webhook and the
// Volanea /v1/events call are captured instead of sent.
"use strict";
const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");

const config = require("../config/config");
const Org = require("../models/org/org");
const Account = require("../models/user/account");
const Subscription = require("../models/billing/subscription");
const Conversation = require("../models/conversation/conversation");
const WebhookEvent = require("../models/billing/webhookEvent");
const { announce } = require("../functions/lifecycle/client");
const hooks = require("../functions/lifecycle/hooks");
const slack = require("../functions/lifecycle/slack");
const { announceFirstConversation } = require("../functions/productAnalytics/events");
const billingFunctions = require("../functions/billing/billingFunctions");
const { randomSuffix } = require("./helpers/client");

const SLACK_URL = "https://hooks.slack.test/services/T000/B000/fixture";
let posts = [];
let volanea = [];
let slackAnswer = () => new Response("ok", { status: 200 });
let volaneaOk = true;
const created = { orgIds: [], emails: [] };
const realFetch = globalThis.fetch;

async function until(check, ms = 3000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail("timed out waiting for a Slack post");
}
const quiet = () => new Promise((resolve) => setTimeout(resolve, 200));
// "Label" → value, from a post's two-column field grid.
const fieldsOf = (post) => Object.fromEntries(post.blocks[1].fields.map((f) => f.text.split("\n")).map(([label, value]) => [label.replace(/\*/g, ""), value]));

before(async () => {
    await mongoose.connect(process.env.TEST_MONGODB_URI);
    config.VOLANEA_LIFECYCLE_KEY = "sk_test_lifecycle";
    config.VOLANEA_API_URL = "https://volanea.test";
    globalThis.fetch = async (url, init) => {
        if (String(url) === SLACK_URL) {
            posts.push({ ...JSON.parse(init.body), signal: init.signal });
            return slackAnswer();
        }
        if (String(url).startsWith("https://volanea.test/v1/events")) {
            volanea.push(JSON.parse(init.body));
            return new Response("{}", { status: volaneaOk ? 200 : 503 });
        }
        return realFetch(url, init);
    };
});

after(async () => {
    globalThis.fetch = realFetch;
    config.VOLANEA_LIFECYCLE_KEY = "";
    config.ALERT_WEBHOOK_URL = "";
    await Promise.all([
        Org.deleteMany({ orgId: { $in: created.orgIds } }),
        Subscription.deleteMany({ orgId: { $in: created.orgIds } }),
        Conversation.deleteMany({ orgId: { $in: created.orgIds } }),
        WebhookEvent.deleteMany({ orgId: { $in: created.orgIds } }),
        Account.deleteMany({ email: { $in: created.emails } }),
    ]);
    await mongoose.disconnect();
});

beforeEach(() => {
    posts = [];
    volanea = [];
    volaneaOk = true;
    slackAnswer = () => new Response("ok", { status: 200 });
    config.ALERT_WEBHOOK_URL = SLACK_URL;
    config.SLACK_ALERTS = "on";
});

// A workspace with an owner account, on an address that isn't reserved for testing.
async function workspace({ providers = ["PASSWORD"] } = {}) {
    const id = randomSuffix();
    const orgId = `org_sa_${id}`;
    const email = `owner_${id}@customers.zealoop.com`;
    created.orgIds.push(orgId);
    created.emails.push(email);
    await Org.collection.insertOne({ orgId, name: `Alerts ${id}`, ownerEmail: email, publicKey: `pk_sa_${id}`, widgetSecret: "ws", createdAt: new Date(), updatedAt: new Date(), suspended: { at: null } });
    const account = await Account.create({ accountId: `acc_sa_${id}`, email, name: "Maya Rao", providers });
    return { orgId, email, account, name: `Alerts ${id}` };
}

describe("lifecycle events on the allow-list", () => {
    test("a new signup posts once, with name, email and method, and no admin link without a workspace", async () => {
        const w = await workspace({ providers: ["GOOGLE"] });
        hooks.onSignedUp(w.account);
        await until(() => posts.length === 1);
        await quiet();
        assert.equal(posts.length, 1);
        const [post] = posts;
        assert.equal(post.blocks[0].text.text, "🆕 New signup");
        assert.deepEqual(fieldsOf(post), { Name: "Maya Rao", Email: w.email, Method: "Google" });
        assert.equal(post.blocks.length, 2);
        assert.match(post.text, /^🆕 New signup: /);
        assert.ok(post.signal, "every post carries a timeout");
    });

    test("a workspace event links to the workspace in /admin and carries workspace and plan", async () => {
        const w = await workspace();
        await announce(w.email, "usage.quota_reached", { limit_label: "50 conversations", resets_on: "Nov 3" }, { firstName: "Maya", workspace: w.name, plan_name: "Free", plan_tier: "free" }, { orgId: w.orgId });
        await until(() => posts.length === 1);
        const [post] = posts;
        assert.equal(post.blocks[0].text.text, "⚠️ Conversation quota reached");
        assert.deepEqual(fieldsOf(post), { Name: "Maya Rao", Email: w.email, Workspace: w.name, Plan: "Free", Limit: "50 conversations", Resets: "Nov 3" });
        assert.equal(post.blocks[2].elements[0].text, `<${config.APP_URL.replace(/\/+$/, "")}/admin/workspaces/${w.orgId}|Open in admin>`);
        // The orgId is for the link only; Volanea never sees it.
        assert.doesNotMatch(JSON.stringify(volanea), new RegExp(w.orgId));
    });

    test("an event that isn't on the list posts nothing, though Volanea still gets it", async () => {
        const w = await workspace();
        await announce(w.email, "member.joined", { member_email: "teammate@customers.zealoop.com", role: "agent", workspace: w.name }, { workspace: w.name }, { orgId: w.orgId });
        await quiet();
        assert.equal(volanea.length, 1);
        assert.deepEqual(posts, []);
    });

    test("an event Volanea refused posts nothing, so the sweep's retry can't post it twice", async () => {
        const w = await workspace();
        volaneaOk = false;
        assert.equal(await announce(w.email, "widget.installed", { site: "acme.io" }, { workspace: w.name }, { orgId: w.orgId }), false);
        await quiet();
        assert.deepEqual(posts, []);
    });
});

describe("switches and failures", () => {
    test("nothing posts without the webhook, with SLACK_ALERTS=off, or for a reserved test domain", async () => {
        const w = await workspace();
        config.ALERT_WEBHOOK_URL = "";
        assert.equal(await slack.sendAlert(w.email, "workspace.created", {}, { workspace: w.name }), false);
        config.ALERT_WEBHOOK_URL = SLACK_URL;
        config.SLACK_ALERTS = "off";
        assert.equal(await slack.sendAlert(w.email, "workspace.created", {}, { workspace: w.name }), false);
        config.SLACK_ALERTS = "on";
        assert.equal(await slack.sendAlert("seed@example.com", "workspace.created", {}, { workspace: "Seed" }), false);
        assert.deepEqual(posts, []);
    });

    test("a Slack error, an unreachable Slack or a timeout never reaches the caller", async () => {
        const w = await workspace();
        const warn = console.log;
        console.log = () => undefined;
        try {
            slackAnswer = () => new Response("no_service", { status: 404 });
            assert.equal(await slack.sendAlert(w.email, "workspace.created", {}, { workspace: w.name }), false);
            slackAnswer = () => { throw new TypeError("fetch failed"); };
            assert.equal(await slack.sendAlert(w.email, "workspace.created", {}, { workspace: w.name }), false);
            slackAnswer = () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); };
            assert.equal(await slack.sendAlert(w.email, "workspace.created", {}, { workspace: w.name }), false);
            // And the lifecycle event still counts as told.
            assert.equal(await announce(w.email, "workspace.created", { workspace: w.name, trial_days: "14", trial_ends_on: "" }, { workspace: w.name }, { orgId: w.orgId }), true);
        } finally {
            console.log = warn;
        }
    });

    test("the webhook URL is never written to the log", async () => {
        const w = await workspace();
        const lines = [];
        const log = console.log;
        console.log = (...args) => lines.push(args.join(" "));
        try {
            slackAnswer = () => { throw new TypeError("fetch failed"); };
            await slack.sendAlert(w.email, "workspace.created", {}, { workspace: w.name });
            slackAnswer = () => new Response("invalid_token", { status: 403 });
            await slack.sendAlert(w.email, "workspace.created", {}, { workspace: w.name });
        } finally {
            console.log = log;
        }
        assert.ok(lines.length >= 2);
        assert.doesNotMatch(lines.join("\n"), /hooks\.slack/);
    });
});

describe("moments outside lifecycle", () => {
    test("the first real visitor conversation posts once, whatever the owner chose about analytics", async () => {
        const w = await workspace();
        await Account.updateOne({ email: w.email }, { $set: { analyticsConsent: "denied" } });
        const first = `conv_${randomSuffix()}`;
        await Conversation.create({ orgId: w.orgId, conversationId: first, status: "OPEN" });
        announceFirstConversation({ orgId: w.orgId, conversationId: first, channel: "CHAT" });
        await until(() => posts.length === 1);
        assert.equal(posts[0].blocks[0].text.text, "⭐ First visitor conversation");
        assert.equal(fieldsOf(posts[0]).Channel, "Widget");
        assert.equal(fieldsOf(posts[0]).Workspace, w.name);

        const second = `conv_${randomSuffix()}`;
        await Conversation.create({ orgId: w.orgId, conversationId: second, status: "OPEN" });
        announceFirstConversation({ orgId: w.orgId, conversationId: second, channel: "CHAT" });
        await quiet();
        assert.equal(posts.length, 1);
    });

    // A signed Lemon Squeezy delivery, as the test runner's billing provider expects.
    async function deliver(orgId, eventName, { webhookId = randomSuffix(), total = 9900, status = "active" } = {}) {
        const body = {
            meta: { event_name: eventName, webhook_id: webhookId, custom_data: { org_id: orgId, plan_id: "GROWTH" } },
            data: { id: `sub_${orgId}`, attributes: { status, total, currency: "USD", customer_id: 1, variant_id: 1, renews_at: new Date(Date.now() + 30 * 86_400_000).toISOString() } },
        };
        const rawBody = JSON.stringify(body);
        const signature = crypto.createHmac("sha256", config.LEMON_SQUEEZY_WEBHOOK_SECRET).update(rawBody).digest("hex");
        return billingFunctions.processWebhook({ rawBody, signature, body, headers: {} });
    }

    test("a payment posts once per delivery with the amount, and a provider's retry posts nothing more", async () => {
        const w = await workspace();
        const result = await deliver(w.orgId, "subscription_payment_success", { webhookId: `wh_${w.orgId}` });
        assert.equal(result.status, 200);
        await until(() => posts.length === 1);
        assert.equal(posts[0].blocks[0].text.text, "💰 Payment received");
        assert.equal(fieldsOf(posts[0]).Amount, "$99.00");
        assert.equal(fieldsOf(posts[0]).Plan, "Growth");
        assert.match(posts[0].blocks[2].elements[0].text, new RegExp(`/admin/workspaces/${w.orgId}\\|`));

        assert.equal((await deliver(w.orgId, "subscription_payment_success", { webhookId: `wh_${w.orgId}` })).json.data.duplicate, true);
        await quiet();
        assert.equal(posts.length, 1);
    });

    test("a failed payment posts once, and the lifecycle payment notice doesn't add a second", async () => {
        const w = await workspace();
        await deliver(w.orgId, "subscription_updated");
        await quiet();
        posts = [];
        await deliver(w.orgId, "subscription_payment_failed", { status: "past_due" });
        await until(() => posts.length === 1);
        await quiet();
        assert.equal(posts.length, 1);
        assert.equal(posts[0].blocks[0].text.text, "❌ Payment failed");
        assert.ok(volanea.some((event) => event.name === "billing.payment_failed"), "the customer's email still goes");
    });

    test("an event that moves no money posts nothing", async () => {
        const w = await workspace();
        await deliver(w.orgId, "subscription_updated");
        await quiet();
        assert.deepEqual(posts, []);
    });
});
