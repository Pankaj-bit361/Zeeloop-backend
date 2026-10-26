// Mixpanel product analytics (functions/productAnalytics): nothing is sent
// without the person's consent, only their account id identifies them, a
// sign-up and a workspace's first real conversation are each sent exactly
// once, and a failing analytics call never breaks the thing being tracked.
// The outgoing Mixpanel /track call is captured instead of sent.
"use strict";
const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const config = require("../config/config");
const Org = require("../models/org/org");
const Member = require("../models/org/member");
const Account = require("../models/user/account");
const Conversation = require("../models/conversation/conversation");
const auth = require("../functions/auth/authFunctions");
const chat = require("../functions/chat/chatFunctions");
const agent = require("../functions/agent/agentFunctions");
const mixpanel = require("../functions/productAnalytics/mixpanel");
const { announceFirstConversation } = require("../functions/productAnalytics/events");
const { get, post, createIsolatedOrg, randomSuffix } = require("./helpers/client");

const DAY = 86_400_000;
let sent = [];
let failing = false;
const created = { orgIds: [], emails: [] };
const realFetch = globalThis.fetch;

async function until(check, ms = 3000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail("timed out waiting for a Mixpanel event");
}
const quiet = () => new Promise((resolve) => setTimeout(resolve, 200));

before(async () => {
    await mongoose.connect(process.env.TEST_MONGODB_URI);
    config.MIXPANEL_TOKEN = "tok_test_not_real";
    config.MIXPANEL_HOST = "api.mixpanel.test";
    globalThis.fetch = async (url, init) => {
        if (String(url).startsWith("https://api.mixpanel.test/track")) {
            if (failing) throw new Error("mixpanel unreachable");
            const ip = new URL(url).searchParams.get("ip");
            for (const entry of JSON.parse(init.body)) sent.push({ ...entry, ip });
            return new Response("1", { status: 200 });
        }
        return realFetch(url, init);
    };
});

after(async () => {
    globalThis.fetch = realFetch;
    config.MIXPANEL_TOKEN = "";
    await Promise.all([
        Org.deleteMany({ orgId: { $in: created.orgIds } }),
        Member.deleteMany({ orgId: { $in: created.orgIds } }),
        Conversation.deleteMany({ orgId: { $in: created.orgIds } }),
        Account.deleteMany({ email: { $in: created.emails } }),
    ]);
    await mongoose.disconnect();
});

beforeEach(() => {
    sent = [];
    failing = false;
    config.MIXPANEL_ENABLED = "on";
});

const email = (label) => {
    const address = `analytics-${label}-${randomSuffix()}@example.com`;
    created.emails.push(address);
    return address;
};

/* ── the sender ──────────────────────────────────────────────────── */

describe("productAnalytics/mixpanel", () => {
    const input = { accountId: "acc_1", event: "sign_up_completed", insertId: "sign_up_completed:acc_1", properties: { platform: "web" } };

    test("sends an event only for someone who accepted, by account id, deduplicated by insert id, with no IP", async () => {
        assert.equal(mixpanel.trackEvent({ ...input, consent: "granted" }), true);
        await until(() => sent.length === 1);
        const [{ event, properties, ip }] = sent;
        assert.equal(event, "sign_up_completed");
        assert.equal(ip, "0");
        assert.equal(properties.token, "tok_test_not_real");
        assert.equal(properties.distinct_id, "acc_1");
        assert.equal(properties.$insert_id, "sign_up_completed:acc_1");
        assert.equal(properties.platform, "web");
    });

    test("sends nothing when consent was declined, is unknown, or was never asked", async () => {
        for (const consent of ["denied", null, undefined]) assert.equal(mixpanel.trackEvent({ ...input, consent }), false);
        await quiet();
        assert.deepEqual(sent, []);
    });

    test("is silent outside production unless a token is set on purpose; production uses Zealoop's own project", () => {
        const path = require.resolve("../config/config");
        const cached = require.cache[path];
        const saved = { NODE_ENV: process.env.NODE_ENV, MIXPANEL_TOKEN: process.env.MIXPANEL_TOKEN };
        const load = (env) => {
            for (const [key, value] of Object.entries(env)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
            delete require.cache[path];
            return require("../config/config");
        };
        try {
            assert.equal(load({ NODE_ENV: "test", MIXPANEL_TOKEN: undefined }).MIXPANEL_TOKEN, "");
            assert.equal(load({ NODE_ENV: "test", MIXPANEL_TOKEN: "tok_on_purpose" }).MIXPANEL_TOKEN, "tok_on_purpose");
            assert.equal(load({ NODE_ENV: "production", MIXPANEL_TOKEN: undefined }).MIXPANEL_TOKEN, "1cd1e6e91dab886f2276efcaa90ef578"); // gitleaks:allow (the public Mixpanel project token)
        } finally {
            load(saved);
            require.cache[path] = cached;
        }
        config.MIXPANEL_ENABLED = "off";
        assert.equal(mixpanel.analyticsEnabled(), false);
        assert.equal(mixpanel.trackEvent({ ...input, consent: "granted" }), false);
    });

    test("never throws, even when the request does", async () => {
        failing = true;
        assert.equal(mixpanel.trackEvent({ ...input, consent: "granted" }), true);
        await quiet();
        assert.deepEqual(sent, []);
    });

    test("reads the choice from the consent cookie, and only its two valid values", () => {
        assert.equal(mixpanel.consentFromCookies({ zealoop_consent: "granted" }), "granted");
        assert.equal(mixpanel.consentFromCookies({ zealoop_consent: "denied" }), "denied");
        assert.equal(mixpanel.consentFromCookies({ zealoop_consent: "yes" }), null);
        assert.equal(mixpanel.consentFromCookies({}), null);
        assert.equal(mixpanel.consentFromCookies(undefined), null);
    });
});

/* ── sign-up ─────────────────────────────────────────────────────── */

describe("sign_up_completed", () => {
    test("is sent once for an email sign-up that accepted analytics, with no personal data", async () => {
        const address = email("signup");
        const result = await auth.signup({ name: "Private Person", email: address, password: "correct-horse-battery", consent: "granted" });
        assert.equal(result.status, 201);
        const { accountId } = result.json.data;
        await until(() => sent.length === 1);
        await quiet();
        assert.equal(sent.length, 1);
        assert.equal(sent[0].event, "sign_up_completed");
        const { token, time, ...properties } = sent[0].properties;
        assert.ok(token && time);
        assert.deepEqual(properties, { sign_up_method: "email", platform: "web", is_invited: false, distinct_id: accountId, $insert_id: `sign_up_completed:${accountId}` });
        // The whole payload, not just the keys above: no email, no name.
        assert.doesNotMatch(JSON.stringify(sent), new RegExp(`${address}|Private Person`));
        assert.equal((await Account.findOne({ accountId }).lean()).analyticsConsent, "granted");
    });

    test("is sent for the Google or GitHub sign-in that creates the account, and not for later sign-ins", async () => {
        const address = email("oauth");
        const first = await auth._findOrCreateAccount({ email: address, name: "Private Person", provider: "GITHUB", consent: "granted" });
        await until(() => sent.length === 1);
        assert.equal(sent[0].properties.sign_up_method, "github");
        assert.equal(sent[0].properties.distinct_id, first.account.accountId);
        await auth._findOrCreateAccount({ email: address, name: "Private Person", provider: "GOOGLE", consent: "granted" });
        await quiet();
        assert.equal(sent.length, 1);
    });

    test("tells an invited teammate's sign-up apart from a new workspace's", async () => {
        const address = email("invited");
        const orgId = `org_an_${randomSuffix()}`;
        created.orgIds.push(orgId);
        await Member.create({ orgId, memberId: `mem_${randomSuffix()}`, email: address, role: "AGENT", status: "INVITED" });
        await auth.signup({ name: "Teammate", email: address, password: "correct-horse-battery", consent: "granted" });
        await until(() => sent.length === 1);
        assert.equal(sent[0].properties.is_invited, true);
    });

    test("is not sent when they declined or haven't chosen, and the choice is stored either way", async () => {
        const declined = await auth.signup({ name: "No", email: email("declined"), password: "correct-horse-battery", consent: "denied" });
        const undecided = await auth.signup({ name: "Maybe", email: email("undecided"), password: "correct-horse-battery", consent: null });
        await quiet();
        assert.deepEqual(sent, []);
        assert.equal((await Account.findOne({ accountId: declined.json.data.accountId }).lean()).analyticsConsent, "denied");
        assert.equal((await Account.findOne({ accountId: undecided.json.data.accountId }).lean()).analyticsConsent, null);
    });

    test("does not fail the sign-up when Mixpanel is down", async () => {
        failing = true;
        const result = await auth.signup({ name: "Down", email: email("down"), password: "correct-horse-battery", consent: "granted" });
        assert.equal(result.status, 201);
    });
});

describe("the choice comes from the consent cookie", () => {
    test("the sign-up route stores the cookie's choice on the new account", async () => {
        const address = email("route");
        const result = await post("/api/auth/signup", { body: { name: "Route", email: address, password: "correct-horse-battery" }, cookie: "zealoop_consent=granted" });
        assert.equal(result.status, 201);
        assert.equal((await Account.findOne({ email: address }).lean()).analyticsConsent, "granted");
    });

    test("/me stores a later accept or withdrawal, and leaves it alone when no choice is visible", async () => {
        const address = email("me");
        const signup = await post("/api/auth/signup", { body: { name: "Me", email: address, password: "correct-horse-battery" } });
        const session = signup.setCookie.split(";")[0];
        const choice = async () => (await Account.findOne({ email: address }).lean()).analyticsConsent;
        const visit = async (consent) => assert.equal((await get("/api/auth/me", { cookie: consent ? `${session}; zealoop_consent=${consent}` : session })).status, 200);

        assert.equal(await choice(), null);
        await visit("granted");
        assert.equal(await choice(), "granted");
        await visit(); // the cookie isn't there: not having chosen is not withdrawing
        assert.equal(await choice(), "granted");
        await visit("denied");
        assert.equal(await choice(), "denied");
        await visit("maybe"); // not a valid value
        assert.equal(await choice(), "denied");
    });
});

/* ── first_conversation_received ─────────────────────────────────── */

async function workspace(consent, { signedUpDaysAgo = 0 } = {}) {
    const id = randomSuffix();
    const orgId = `org_an_${id}`;
    const ownerEmail = email("owner");
    created.orgIds.push(orgId);
    const at = new Date(Date.now() - signedUpDaysAgo * DAY);
    await Org.collection.insertOne({ orgId, name: `Analytics ${id}`, ownerEmail, publicKey: `pk_an_${id}`, widgetSecret: "ws", createdAt: at, updatedAt: at });
    await Account.collection.insertOne({ accountId: `acc_an_${id}`, email: ownerEmail, name: "Maya Rao", analyticsConsent: consent, createdAt: at, updatedAt: at });
    return { orgId, accountId: `acc_an_${id}`, ownerEmail };
}

const conversation = async (orgId, { eval: isEval = false, channel = "CHAT", agoMs = 0 } = {}) => {
    const conversationId = isEval ? `conv_eval_${randomSuffix()}` : `conv_${randomSuffix()}`;
    await Conversation.create({ orgId, conversationId, channel, status: "OPEN", createdAt: new Date(Date.now() - agoMs) });
    return conversationId;
};

describe("first_conversation_received", () => {
    test("is the workspace's first real conversation only, attributed to the owner, with no personal data", async () => {
        const w = await workspace("granted", { signedUpDaysAgo: 3 });
        const first = await conversation(w.orgId);
        announceFirstConversation({ orgId: w.orgId, conversationId: first, channel: "CHAT" });
        await until(() => sent.length === 1);
        const { token, time, ...properties } = sent[0].properties;
        assert.equal(sent[0].event, "first_conversation_received");
        assert.deepEqual(properties, { org_id: w.orgId, channel: "chat", days_since_signup: 3, distinct_id: w.accountId, $insert_id: `first_conversation_received:${w.orgId}` });
        assert.doesNotMatch(JSON.stringify(sent), new RegExp(`${w.ownerEmail}|Maya`));

        const second = await conversation(w.orgId);
        announceFirstConversation({ orgId: w.orgId, conversationId: second, channel: "CHAT" });
        await quiet();
        assert.equal(sent.length, 1);
    });

    test("an evaluation run is not a visitor: the first real conversation after one still counts", async () => {
        const w = await workspace("granted");
        await conversation(w.orgId, { eval: true, agoMs: 60_000 });
        const real = await conversation(w.orgId, { channel: "EMAIL" });
        announceFirstConversation({ orgId: w.orgId, conversationId: real, channel: "EMAIL" });
        await until(() => sent.length === 1);
        assert.equal(sent[0].properties.channel, "email");
    });

    test("is never sent for a workspace whose first conversation came before", async () => {
        const w = await workspace("granted", { signedUpDaysAgo: 90 });
        await conversation(w.orgId, { agoMs: 30 * DAY });
        announceFirstConversation({ orgId: w.orgId, conversationId: await conversation(w.orgId), channel: "CHAT" });
        await quiet();
        assert.deepEqual(sent, []);
    });

    test("is not sent for an owner who declined or never chose", async () => {
        for (const consent of ["denied", null]) {
            const w = await workspace(consent);
            announceFirstConversation({ orgId: w.orgId, conversationId: await conversation(w.orgId), channel: "CHAT" });
        }
        await quiet();
        assert.deepEqual(sent, []);
    });

    // A real workspace from sign-up and onboarding, whose owner accepted analytics.
    async function onboarded(t) {
        const w = await createIsolatedOrg("analytics");
        created.orgIds.push(w.orgId);
        created.emails.push(w.email);
        await Account.updateOne({ email: w.email }, { $set: { analyticsConsent: "granted" } });
        t.mock.method(agent, "runTurn", async () => ({ reply: "fixture reply", outcome: "ANSWERED" }));
        return { ...w, accountId: (await Account.findOne({ email: w.email }).lean()).accountId };
    }

    test("fires from a visitor's first widget message, and from nothing after it", async (t) => {
        const w = await onboarded(t);
        const opened = await chat.sendMessage({ publicKey: w.publicKey, content: "Do you ship to Canada?" });
        assert.equal(opened.status, 200);
        await until(() => sent.length === 1);
        assert.equal(sent[0].event, "first_conversation_received");
        assert.equal(sent[0].properties.distinct_id, w.accountId);
        assert.doesNotMatch(JSON.stringify(sent), /Canada/);

        // The same thread again, and a second visitor: neither is a first.
        assert.equal((await chat.sendMessage({ publicKey: w.publicKey, conversationId: opened.json.data.conversationId, content: "And Mexico?" })).status, 200);
        assert.equal((await chat.sendMessage({ publicKey: w.publicKey, content: "Hello" })).status, 200);
        await quiet();
        assert.equal(sent.length, 1);
    });

    test("the visitor still gets their reply when Mixpanel is down", async (t) => {
        const w = await onboarded(t);
        failing = true;
        const result = await chat.sendMessage({ publicKey: w.publicKey, content: "Hello" });
        assert.equal(result.status, 200);
        assert.equal(result.json.data.message.content, "fixture reply");
    });
});
