// Integration tests for §0.1–0.3: billing reads, checkout guards, webhook
// signature verification and idempotency.
//
// The webhook suites need the server running with a billing provider
// configured:
//
//   BILLING_PROVIDER=LEMON_SQUEEZY \
//   LEMON_SQUEEZY_API_KEY=test_key \
//   LEMON_SQUEEZY_STORE_ID=1 \
//   LEMON_SQUEEZY_WEBHOOK_SECRET=test_webhook_secret \
//   node server.js
//
// Without them the server answers 503 and those suites skip rather than fail,
// so `npm test` stays green on a deployment with no provider.
"use strict";
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { get, post, devLogin, authHeader, createIsolatedOrg, SEED_ORG_ID, randomSuffix } = require("./helpers/client");

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:4000";
const WEBHOOK_SECRET = process.env.LEMON_SQUEEZY_WEBHOOK_SECRET || "test_webhook_secret";

let AUTH_A;
let billingConfigured = false;

// Posts a raw body so the signature is computed over the exact bytes the server
// will hash — which is the whole point of the rawBody capture.
async function postWebhook(bodyObject, { signature, omitSignature = false } = {}) {
    const raw = JSON.stringify(bodyObject);
    const headers = { "content-type": "application/json" };
    if (!omitSignature) {
        headers["x-signature"] =
            signature || crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
    }
    const res = await fetch(`${BASE_URL}/webhooks/billing`, { method: "POST", headers, body: raw });
    let json = null;
    try {
        json = await res.json();
    } catch (error) {
        json = null;
    }
    return { status: res.status, json };
}

function subscriptionEvent({ orgId, planId = "GROWTH", status = "active", eventId, subscriptionId }) {
    return {
        meta: {
            event_name: "subscription_created",
            webhook_id: eventId,
            custom_data: { org_id: orgId, plan_id: planId },
        },
        data: {
            id: subscriptionId,
            attributes: {
                status,
                customer_id: 99001,
                variant_id: 55001,
                renews_at: new Date(Date.now() + 30 * 86400000).toISOString(),
                urls: { update_payment_method: "https://example.test/update", customer_portal: "https://example.test/portal" },
            },
        },
    };
}

before(async () => {
    AUTH_A = authHeader(await devLogin(SEED_ORG_ID));
    const probe = await postWebhook({ meta: { event_name: "ping" } }, { omitSignature: true });
    // 503 means no provider configured; 401 means configured and it rejected an
    // unsigned body, which is exactly what it should do.
    billingConfigured = probe.status !== 503;
});

describe("GET /api/org/:orgId/billing", () => {
    test("returns the effective plan, period and usage", async () => {
        const result = await get(`/api/org/${SEED_ORG_ID}/billing`, { headers: AUTH_A });
        assert.equal(result.status, 200);
        assert.ok(result.json.data.plan.id);
        assert.ok(Array.isArray(result.json.data.plan.features));
        assert.ok(result.json.data.currentPeriodEnd);
        assert.ok(result.json.data.usage, "usage should be attached");
        assert.equal(typeof result.json.data.usage.conversations, "number");
    });

    test("creates the subscription lazily, so a pre-billing org needs no migration", async () => {
        const first = await get(`/api/org/${SEED_ORG_ID}/billing`, { headers: AUTH_A });
        const second = await get(`/api/org/${SEED_ORG_ID}/billing`, { headers: AUTH_A });
        assert.equal(first.status, 200);
        assert.equal(second.status, 200);
        // Same subscription both times — not a new row per read.
        assert.equal(first.json.data.currentPeriodEnd, second.json.data.currentPeriodEnd);
    });

    test("requires auth", async () => {
        const result = await get(`/api/org/${SEED_ORG_ID}/billing`);
        assert.equal(result.status, 401);
    });

    test("a token for one workspace cannot read another's billing", async () => {
        const result = await get(`/api/org/org_someone_else/billing`, { headers: AUTH_A });
        assert.equal(result.status, 403);
    });
});

describe("GET /api/org/:orgId/billing/usage", () => {
    test("returns period history", async () => {
        const result = await get(`/api/org/${SEED_ORG_ID}/billing/usage`, { headers: AUTH_A });
        assert.equal(result.status, 200);
        assert.ok(Array.isArray(result.json.data));
    });

    test("requires auth", async () => {
        const result = await get(`/api/org/${SEED_ORG_ID}/billing/usage`);
        assert.equal(result.status, 401);
    });
});

describe("POST /api/org/:orgId/billing/checkout", () => {
    test("rejects a missing planId", async () => {
        const result = await post(`/api/org/${SEED_ORG_ID}/billing/checkout`, { headers: AUTH_A, body: {} });
        assert.equal(result.status, 400);
    });

    test("refuses to sell the free plan", async () => {
        const result = await post(`/api/org/${SEED_ORG_ID}/billing/checkout`, {
            headers: AUTH_A,
            body: { planId: "FREE" },
        });
        assert.equal(result.status, 400);
    });

    test("rejects an unknown plan", async () => {
        const result = await post(`/api/org/${SEED_ORG_ID}/billing/checkout`, {
            headers: AUTH_A,
            body: { planId: "PLATINUM_ELITE" },
        });
        assert.equal(result.status, 400);
    });

    test("requires auth", async () => {
        const result = await post(`/api/org/${SEED_ORG_ID}/billing/checkout`, { body: { planId: "STARTER" } });
        assert.equal(result.status, 401);
    });
});

describe("POST /webhooks/billing — signature verification", () => {
    test("rejects a body with no signature", async (t) => {
        if (!billingConfigured) return t.skip("no billing provider configured");
        const result = await postWebhook(subscriptionEvent({ orgId: "org_x", eventId: randomSuffix() }), {
            omitSignature: true,
        });
        assert.equal(result.status, 401);
    });

    test("rejects a wrong signature", async (t) => {
        if (!billingConfigured) return t.skip("no billing provider configured");
        const result = await postWebhook(subscriptionEvent({ orgId: "org_x", eventId: randomSuffix() }), {
            signature: crypto.randomBytes(32).toString("hex"),
        });
        assert.equal(result.status, 401);
    });

    test("rejects a signature over different bytes than were sent", async (t) => {
        if (!billingConfigured) return t.skip("no billing provider configured");
        const sent = subscriptionEvent({ orgId: "org_x", eventId: randomSuffix() });
        const tampered = crypto
            .createHmac("sha256", WEBHOOK_SECRET)
            .update(JSON.stringify({ ...sent, meta: { ...sent.meta, event_name: "different" } }))
            .digest("hex");
        const result = await postWebhook(sent, { signature: tampered });
        assert.equal(result.status, 401);
    });

    test("accepts a correctly signed event", async (t) => {
        if (!billingConfigured) return t.skip("no billing provider configured");
        const orgId = `org_test_${randomSuffix()}`;
        const result = await postWebhook(
            subscriptionEvent({ orgId, eventId: randomSuffix(), subscriptionId: randomSuffix() })
        );
        assert.equal(result.status, 200);
        assert.equal(result.json.data.applied, true);
    });
});

describe("POST /webhooks/billing — idempotency", () => {
    test("the same event id is applied exactly once", async (t) => {
        if (!billingConfigured) return t.skip("no billing provider configured");
        const orgId = `org_test_${randomSuffix()}`;
        const event = subscriptionEvent({ orgId, eventId: randomSuffix(), subscriptionId: randomSuffix() });

        const first = await postWebhook(event);
        assert.equal(first.status, 200);
        assert.equal(first.json.data.applied, true);

        const second = await postWebhook(event);
        assert.equal(second.status, 200, "a replay must not error — the provider would retry forever");
        assert.equal(second.json.data.duplicate, true);
    });

    test("concurrent deliveries of one event still apply it once", async (t) => {
        if (!billingConfigured) return t.skip("no billing provider configured");
        const orgId = `org_test_${randomSuffix()}`;
        const event = subscriptionEvent({ orgId, eventId: randomSuffix(), subscriptionId: randomSuffix() });

        const results = await Promise.all([postWebhook(event), postWebhook(event), postWebhook(event)]);
        const applied = results.filter((r) => r.json && r.json.data && r.json.data.applied);
        const duplicates = results.filter((r) => r.json && r.json.data && r.json.data.duplicate);

        assert.equal(applied.length, 1, "exactly one delivery should apply");
        assert.equal(duplicates.length, 2, "the other two should be recognised as replays");
    });

    test("an event with no orgId is not applied — guessing which workspace paid is worse than failing", async (t) => {
        if (!billingConfigured) return t.skip("no billing provider configured");
        const event = subscriptionEvent({ orgId: null, eventId: randomSuffix(), subscriptionId: randomSuffix() });
        delete event.meta.custom_data;
        const result = await postWebhook(event);
        assert.equal(result.status, 500, "should fail loudly so the provider retries and a human notices");
    });

    test("an unmodelled event type is acknowledged, not retried forever", async (t) => {
        if (!billingConfigured) return t.skip("no billing provider configured");
        const result = await postWebhook({ meta: {}, data: {} });
        assert.equal(result.status, 200);
        assert.equal(result.json.data.ignored, true);
    });
});

// Each of these owns a freshly created workspace. They must never touch the
// seeded org: `node --test` runs files concurrently, so downgrading the shared
// org's plan mid-run would fail whichever other suite happened to be creating
// an action or a table at that moment.
describe("webhook → effective plan", () => {
    test("an active subscription event upgrades the workspace's effective plan", async (t) => {
        if (!billingConfigured) return t.skip("no billing provider configured");
        const org = await createIsolatedOrg("billing-upgrade");

        await postWebhook(
            subscriptionEvent({
                orgId: org.orgId,
                planId: "GROWTH",
                status: "active",
                eventId: randomSuffix(),
                subscriptionId: randomSuffix(),
            })
        );

        const result = await get(`/api/org/${org.orgId}/billing`, { headers: authHeader(org.token) });
        assert.equal(result.status, 200);
        assert.equal(result.json.data.plan.id, "GROWTH");
        assert.equal(result.json.data.status, "ACTIVE");
    });

    test("a payment failure keeps the plan alive inside the grace window", async (t) => {
        if (!billingConfigured) return t.skip("no billing provider configured");
        const org = await createIsolatedOrg("billing-pastdue");
        const subscriptionId = randomSuffix();

        await postWebhook(
            subscriptionEvent({
                orgId: org.orgId,
                planId: "GROWTH",
                status: "active",
                eventId: randomSuffix(),
                subscriptionId,
            })
        );
        const failure = subscriptionEvent({
            orgId: org.orgId,
            planId: "GROWTH",
            status: "past_due",
            eventId: randomSuffix(),
            subscriptionId,
        });
        failure.meta.event_name = "subscription_payment_failed";
        await postWebhook(failure);

        const result = await get(`/api/org/${org.orgId}/billing`, { headers: authHeader(org.token) });
        assert.equal(result.status, 200);
        assert.equal(result.json.data.status, "PAST_DUE");
        assert.equal(result.json.data.plan.id, "GROWTH", "an expired card is not a decision to leave");
        assert.equal(result.json.data.downgradeReason, "PAYMENT_FAILED_IN_GRACE");
        assert.ok(result.json.data.gracePeriodEndsAt);
    });

    test("an expired subscription drops the workspace to FREE, losing tables and actions", async (t) => {
        if (!billingConfigured) return t.skip("no billing provider configured");
        const org = await createIsolatedOrg("billing-expired");

        const expiry = subscriptionEvent({
            orgId: org.orgId,
            planId: "GROWTH",
            status: "expired",
            eventId: randomSuffix(),
            subscriptionId: randomSuffix(),
        });
        expiry.meta.event_name = "subscription_expired";
        await postWebhook(expiry);

        const result = await get(`/api/org/${org.orgId}/billing`, { headers: authHeader(org.token) });
        assert.equal(result.status, 200);
        assert.equal(result.json.data.plan.id, "FREE");
        assert.equal(result.json.data.plan.features.includes("TABLES"), false);
    });
});

// The gates are unit tested in planGates.test.js; this proves they are actually
// mounted on the create routes, which is the part a unit test cannot see.
describe("plan gates are mounted on create routes", () => {
    test("a FREE workspace cannot create a table", async () => {
        const org = await createIsolatedOrg("gate-tables");
        if (billingConfigured) {
            const expiry = subscriptionEvent({
                orgId: org.orgId,
                planId: "FREE",
                status: "expired",
                eventId: randomSuffix(),
                subscriptionId: randomSuffix(),
            });
            expiry.meta.event_name = "subscription_expired";
            await postWebhook(expiry);
        }

        const result = await post(`/api/org/${org.orgId}/tables`, {
            headers: authHeader(org.token),
            body: { name: "Orders", columns: [{ name: "id", type: "string", isIdentityKey: true }] },
        });

        // A brand-new org is on a STARTER trial, which includes tables. Only
        // once expired does the gate bite — so this asserts the gate exists
        // rather than asserting a particular trial policy.
        if (billingConfigured) {
            assert.equal(result.status, 402);
            assert.equal(result.json.reason, "PLAN_FEATURE");
        } else {
            assert.ok([200, 201].includes(result.status));
        }
    });
});
