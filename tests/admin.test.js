"use strict";
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { get, post, authHeader, createIsolatedOrg } = require("./helpers/client");

// The admin panel: staff only, every change needs a reason and is logged, and a
// suspension shuts every door into the workspace until it is lifted.
// runTests.js sets ADMIN_EMAILS=staff@zealoop.test.

const STAFF_EMAIL = "staff@zealoop.test";
const TEST_URI = process.env.TEST_MONGODB_URI || "mongodb://127.0.0.1:27017/zealoop_test";
let staff;
let customer;

async function signUp(email, { verify = true } = {}) {
    const signup = await post("/api/auth/signup", { body: { name: "Test Person", email, password: "password123-strong" } });
    assert.equal(signup.json.success, true, JSON.stringify(signup.json));
    const cookie = signup.setCookie.split(";")[0];
    if (verify) {
        const token = new URL(signup.json.data.verificationUrl).searchParams.get("token");
        const verified = await post("/api/auth/verify-email", { cookie, body: { token } });
        assert.equal(verified.json.success, true);
    }
    return cookie;
}

const admin = (path, body) => (body === undefined ? get(`/api/admin${path}`, { cookie: staff }) : post(`/api/admin${path}`, { cookie: staff, body }));

before(async () => {
    await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 3000 });
    staff = await signUp(STAFF_EMAIL);
    customer = await createIsolatedOrg("admin-panel");
});

after(async () => {
    await mongoose.disconnect();
});

describe("who may open the admin panel", () => {
    test("no session is 401, a customer's session is 403", async () => {
        assert.equal((await get("/api/admin/overview")).status, 401);
        assert.equal((await get("/api/admin/overview", { cookie: customer.cookie })).status, 403);
    });

    test("an unverified account with a staff email is refused", async () => {
        await mongoose.connection.collection("accounts").updateOne({ email: STAFF_EMAIL }, { $set: { emailVerifiedAt: null } });
        try {
            assert.equal((await admin("/overview")).status, 403);
        } finally {
            await mongoose.connection.collection("accounts").updateOne({ email: STAFF_EMAIL }, { $set: { emailVerifiedAt: new Date() } });
        }
    });

    test("/me tells staff and customers apart", async () => {
        assert.equal((await get("/api/auth/me", { cookie: staff })).json.data.isAdmin, true);
        assert.equal((await get("/api/auth/me", { cookie: customer.cookie })).json.data.isAdmin, false);
    });
});

describe("reading", () => {
    test("overview counts workspaces and plans", async () => {
        const result = await admin("/overview");
        assert.equal(result.status, 200);
        const data = result.json.data;
        assert.ok(data.workspaces >= 2);
        assert.equal(data.signups.length, 14);
        assert.deepEqual(Object.keys(data.plans).sort(), ["FREE", "GROWTH", "SCALE", "STARTER"]);
        assert.ok(Object.values(data.plans).every((n) => Number.isInteger(n) && n >= 0));
    });

    test("workspaces can be found by a member's email", async () => {
        const result = await admin(`/workspaces?search=${encodeURIComponent(customer.email)}`);
        assert.equal(result.status, 200);
        assert.deepEqual(result.json.data.workspaces.map((w) => w.orgId), [customer.orgId]);
        // A new workspace trials Growth: its limit is Growth's, before any usage row exists.
        const [row] = result.json.data.workspaces;
        assert.equal(row.effectivePlan, "GROWTH");
        assert.equal(row.conversationsLimit, 1200);
    });

    test("one workspace in full, with its members' accounts", async () => {
        const result = await admin(`/workspaces/${customer.orgId}`);
        assert.equal(result.status, 200);
        const data = result.json.data;
        assert.equal(data.workspace.orgId, customer.orgId);
        assert.equal(data.members[0].email, customer.email);
        assert.match(data.members[0].account.accountId, /^acc_/);
        assert.equal("widgetSecret" in data.workspace, false);
        assert.equal((await admin("/workspaces/org_nope")).status, 404);
    });
});

describe("changing a workspace", () => {
    test("every change needs a reason", async () => {
        const result = await admin(`/workspaces/${customer.orgId}/plan`, { plan: "SCALE", reason: "" });
        assert.equal(result.status, 400);
        assert.match(result.json.error, /audit log/);
    });

    test("set a plan: it takes effect now, for quota and for the API gate", async () => {
        const result = await admin(`/workspaces/${customer.orgId}/plan`, { plan: "SCALE", reason: "Design partner, comped" });
        assert.equal(result.status, 200);
        assert.equal(result.json.data.effectivePlan, "SCALE");
        const org = await mongoose.connection.collection("orgs").findOne({ orgId: customer.orgId });
        assert.equal(org.credits.plan, "SCALE");
        const billing = await get(`/api/org/${customer.orgId}/billing`, { headers: authHeader(customer.token) });
        assert.equal(billing.json.data.plan.id, "SCALE");
    });

    test("extend a trial on a paid plan", async () => {
        const result = await admin(`/workspaces/${customer.orgId}/trial`, { days: 10, plan: "GROWTH", reason: "Needs more time to evaluate" });
        assert.equal(result.status, 200);
        assert.equal(result.json.data.status, "TRIALING");
        assert.equal(result.json.data.effectivePlan, "GROWTH");
        const days = (new Date(result.json.data.trialEndsAt) - Date.now()) / 86400000;
        assert.ok(days > 9.9 && days <= 10.01, `trial ends in ${days} days`);
        assert.equal((await admin(`/workspaces/${customer.orgId}/trial`, { days: 500, reason: "Way too long" })).status, 400);
    });

    test("a workspace a provider is billing is not changed here", async () => {
        const subs = mongoose.connection.collection("subscriptions");
        const before = await subs.findOne({ orgId: customer.orgId });
        await subs.updateOne({ orgId: customer.orgId }, { $set: { provider: "RAZORPAY", providerSubscriptionId: "sub_test", status: "ACTIVE", plan: "STARTER" } });
        try {
            const result = await admin(`/workspaces/${customer.orgId}/plan`, { plan: "SCALE", reason: "Should be refused" });
            assert.equal(result.status, 409);
            assert.match(result.json.error, /RAZORPAY/);
        } finally {
            await subs.replaceOne({ orgId: customer.orgId }, before);
        }
    });

    test("suspension shuts the widget, the dashboard and token minting, and lifting it opens them again", async () => {
        assert.equal((await post("/api/widget/bootstrap", { body: { publicKey: customer.publicKey } })).status, 200);

        const suspended = await admin(`/workspaces/${customer.orgId}/suspend`, { suspended: true, reason: "Spam through the widget" });
        assert.equal(suspended.status, 200);

        const widget = await post("/api/widget/bootstrap", { body: { publicKey: customer.publicKey } });
        assert.equal(widget.status, 403);
        assert.equal(widget.json.reason, "WORKSPACE_SUSPENDED");
        const dashboard = await get(`/api/org/${customer.orgId}/settings`, { headers: authHeader(customer.token) });
        assert.equal(dashboard.status, 403);
        assert.equal(dashboard.json.reason, "WORKSPACE_SUSPENDED");
        const mint = await post("/api/auth/token", { cookie: customer.cookie, body: { orgId: customer.orgId } });
        assert.equal(mint.status, 403);
        assert.equal(mint.json.reason, "WORKSPACE_SUSPENDED");
        assert.equal((await admin("/workspaces?status=SUSPENDED")).json.data.workspaces.some((w) => w.orgId === customer.orgId), true);

        assert.equal((await admin(`/workspaces/${customer.orgId}/suspend`, { suspended: false, reason: "Cleaned up, talked to the owner" })).status, 200);
        assert.equal((await post("/api/widget/bootstrap", { body: { publicKey: customer.publicKey } })).status, 200);
        assert.equal((await get(`/api/org/${customer.orgId}/settings`, { headers: authHeader(customer.token) })).status, 200);
    });

    test("every change is in the audit log, newest first, with who and why", async () => {
        const result = await admin(`/audit?orgId=${customer.orgId}`);
        assert.equal(result.status, 200);
        const actions = result.json.data.entries.map((e) => e.action);
        assert.deepEqual(actions, ["unsuspend", "suspend", "extend_trial", "set_plan"]);
        assert.equal(result.json.data.entries[0].adminEmail, STAFF_EMAIL);
        assert.equal(result.json.data.entries[3].reason, "Design partner, comped");
    });
});

describe("changing an account", () => {
    test("verify an email that never arrived", async () => {
        const email = `stuck-${Date.now()}@example.com`;
        const cookie = await signUp(email, { verify: false });
        const account = await mongoose.connection.collection("accounts").findOne({ email });
        const result = await admin(`/accounts/${account.accountId}/verify-email`, { reason: "Their mail server drops our email" });
        assert.equal(result.status, 200);
        assert.equal((await get("/api/auth/me", { cookie })).json.data.user.emailVerified, true);
        assert.equal((await admin(`/accounts/${account.accountId}/verify-email`, { reason: "Again, should refuse" })).status, 400);
    });

    test("sign an account out everywhere", async () => {
        const account = await mongoose.connection.collection("accounts").findOne({ email: customer.email });
        assert.equal((await get("/api/auth/me", { cookie: customer.cookie })).status, 200);
        const result = await admin(`/accounts/${account.accountId}/sign-out`, { reason: "Laptop was stolen" });
        assert.equal(result.status, 200);
        assert.equal((await get("/api/auth/me", { cookie: customer.cookie })).status, 401);
        assert.equal((await get(`/api/org/${customer.orgId}/settings`, { headers: authHeader(customer.token) })).status, 401);
    });
});
