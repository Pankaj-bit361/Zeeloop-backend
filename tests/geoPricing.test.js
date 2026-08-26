"use strict";
// Country → currency → price list. Razorpay told us an Indian card will not
// clear a USD plan on this account, so a workspace that signs up from India
// must see rupee prices and be sent to the INR plan — and must keep seeing
// them when the owner opens the dashboard from somewhere else.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { get, post, patch, devLogin, authHeader, createIsolatedOrg, SEED_ORG_ID } = require("./helpers/client");
const geoFunctions = require("../functions/utilFunctions/geoFunctions");
const { PLANS, getPrice } = require("../config/plans");

let AUTH_A;
before(async () => {
    AUTH_A = authHeader(await devLogin(SEED_ORG_ID));
});

describe("geoFunctions — reading the country the edge stamped on the request", () => {
    test("reads each CDN's header, first present wins", () => {
        assert.equal(geoFunctions.countryFromRequest({ headers: { "cf-ipcountry": "IN" } }), "IN");
        assert.equal(geoFunctions.countryFromRequest({ headers: { "x-vercel-ip-country": "de" } }), "DE");
        assert.equal(geoFunctions.countryFromRequest({ headers: { "cloudfront-viewer-country": "US" } }), "US");
        // The explicit override beats the CDN — it is what a proxy an
        // operator controls sets, and what these tests set.
        assert.equal(
            geoFunctions.countryFromRequest({ headers: { "x-zealoop-country": "IN", "cf-ipcountry": "US" } }),
            "IN"
        );
    });

    test("Cloudflare's 'could not place' values are not countries", () => {
        assert.equal(geoFunctions.countryFromRequest({ headers: { "cf-ipcountry": "XX" } }), null);
        assert.equal(geoFunctions.countryFromRequest({ headers: { "cf-ipcountry": "T1" } }), null);
        assert.equal(geoFunctions.countryFromRequest({ headers: {} }), null);
        assert.equal(geoFunctions.countryFromRequest({ headers: { "cf-ipcountry": "<script>" } }), null);
    });

    test("India is INR; everyone else, including unknown, is USD", () => {
        assert.equal(geoFunctions.currencyForCountry("IN"), "INR");
        assert.equal(geoFunctions.currencyForCountry("US"), "USD");
        assert.equal(geoFunctions.currencyForCountry("GB"), "USD");
        // Unknown falls to USD because that is the plan most cards can pay.
        assert.equal(geoFunctions.currencyForCountry(null), "USD");
    });
});

describe("plans — the INR price list", () => {
    test("every paid plan has a rupee price, and they rank like the dollar ones", () => {
        assert.equal(PLANS.FREE.priceInr, 0);
        assert.ok(PLANS.STARTER.priceInr > 0);
        assert.ok(PLANS.GROWTH.priceInr > PLANS.STARTER.priceInr);
        assert.ok(PLANS.SCALE.priceInr > PLANS.GROWTH.priceInr);
    });

    test("getPrice answers in the currency asked, and USD when asked nonsense", () => {
        assert.equal(getPrice("GROWTH", "USD"), 99);
        assert.equal(getPrice("GROWTH", "INR"), PLANS.GROWTH.priceInr);
        assert.equal(getPrice("GROWTH", "YEN"), 99);
    });

    test("rupee prices are round numbers, not conversions", () => {
        // ₹8,316.44 drifting with the exchange rate is what this guards against.
        for (const plan of Object.values(PLANS)) {
            assert.equal(plan.priceInr % 1, 0, `${plan.id} INR price has paise`);
            if (plan.priceInr) assert.equal(plan.priceInr % 100, 99, `${plan.id} INR price ${plan.priceInr} does not end in 99`);
        }
    });
});

describe("GET /billing — currency follows the workspace, not the request", () => {
    test("a workspace created from India is INR for good, even when opened from elsewhere", async () => {
        // Same steps as createIsolatedOrg, with the country stamped on the
        // request that creates the workspace — the one that decides.
        const email = `in-${Date.now()}@example.com`;
        const signup = await post("/api/auth/signup", { body: { name: "Priya", email, password: "password123-strong" } });
        const cookie = signup.setCookie.split(";")[0];
        const created = await post("/api/auth/orgs", {
            body: { name: "Bharat Co", website: "https://example.in" },
            cookie,
            headers: { "x-zealoop-country": "IN" },
        });
        assert.equal(created.status, 201, JSON.stringify(created.json));
        const orgId = created.json.data.orgId;
        const token = (await post("/api/auth/token", { body: { orgId }, cookie })).json.data.token;

        // Opened later from the US: still rupees.
        const billing = await get(`/api/org/${orgId}/billing`, {
            headers: { ...authHeader(token), "x-zealoop-country": "US" },
        });
        assert.equal(billing.status, 200);
        assert.equal(billing.json.data.currency, "INR");
        assert.equal(billing.json.data.country, "IN");
        assert.equal(billing.json.data.taxIncluded, true, "INR list prices include GST");
        assert.equal(billing.json.data.currencyLocked, false, "no subscription yet, so still changeable");
        assert.equal(billing.json.data.prices.GROWTH, PLANS.GROWTH.priceInr);
        assert.equal(billing.json.data.prices.FREE, 0);
    });

    test("a workspace with no country is USD, and the first request that knows settles it", async () => {
        const orgB = await createIsolatedOrg("nocountry");
        const first = await get(`/api/org/${orgB.orgId}/billing`, {
            headers: { ...authHeader(orgB.token), "x-zealoop-country": "IN" },
        });
        // Created without a country → USD was decided at birth and sticks.
        // The India header on a later read must NOT flip it: a price list
        // that changes with the wifi is one nobody trusts.
        assert.equal(first.json.data.currency, "USD");
        assert.equal(first.json.data.taxIncluded, false);
        assert.equal(first.json.data.prices.GROWTH, 99);
    });

    test("the seed workspace reports a full price list in its currency", async () => {
        const billing = await get(`/api/org/${SEED_ORG_ID}/billing`, { headers: AUTH_A });
        assert.equal(billing.status, 200);
        assert.deepEqual(Object.keys(billing.json.data.prices).sort(), ["FREE", "GROWTH", "SCALE", "STARTER"]);
        assert.equal(typeof billing.json.data.plan.price, "number");
    });
});

describe("PATCH /billing/currency — the person overrides the default", () => {
    test("switches while nothing is subscribed, and the price list follows", async () => {
        const orgB = await createIsolatedOrg("switcher");
        const auth = authHeader(orgB.token);

        const switched = await patch(`/api/org/${orgB.orgId}/billing/currency`, { headers: auth, body: { currency: "INR" } });
        assert.equal(switched.status, 200, JSON.stringify(switched.json));

        const billing = await get(`/api/org/${orgB.orgId}/billing`, { headers: auth });
        assert.equal(billing.json.data.currency, "INR");
        assert.equal(billing.json.data.prices.STARTER, PLANS.STARTER.priceInr);
    });

    test("rejects a currency we do not bill in", async () => {
        const orgB = await createIsolatedOrg("badcurrency");
        const result = await patch(`/api/org/${orgB.orgId}/billing/currency`, {
            headers: authHeader(orgB.token),
            body: { currency: "EUR" },
        });
        assert.equal(result.status, 400);
        assert.match(result.json.error, /USD, INR/);
    });

    test("requires auth", async () => {
        const result = await patch(`/api/org/${SEED_ORG_ID}/billing/currency`, { body: { currency: "INR" } });
        assert.equal(result.status, 401);
    });
});

describe("checkout routes by currency — in-process, provider stubbed", () => {
    /* NOT over HTTP, and with fetch replaced. The first version of this test
       went through the running server and asserted a 503 — true only while no
       INR plan ids existed. The day they were committed, the same test created
       a real subscription on the live Razorpay account (sub_TUVIBrTpS2Esvh,
       abandoned, nothing charged). A test suite must never be able to reach a
       payment provider; this one asserts the request that WOULD be sent. */
    const mongoose = require("mongoose");
    const config = require("../config/config");
    const Org = require("../models/org/org");
    const Subscription = require("../models/billing/subscription");
    const billingFunctions = require("../functions/billing/billingFunctions");

    const TEST_URI = process.env.TEST_MONGODB_URI || "mongodb://127.0.0.1:27017/zealoop_test";
    const created = [];
    const saved = {};
    let sent = [];

    async function makeOrg(currency) {
        const orgId = `org_geo_${currency}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await Org.create({
            orgId,
            name: `Geo ${currency}`,
            ownerEmail: `${orgId}@example.com`,
            publicKey: `pk_${orgId}`,
            widgetSecret: "ws_test",
            billing: { country: currency === "INR" ? "IN" : "US", currency },
        });
        created.push(orgId);
        return orgId;
    }

    before(async () => {
        await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 3000 });
        // A configured provider, with keys that can authorise nothing, and a
        // fetch that never leaves the process.
        for (const key of ["BILLING_PROVIDER", "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET"]) saved[key] = config[key];
        config.BILLING_PROVIDER = "RAZORPAY";
        config.RAZORPAY_KEY_ID = "rzp_test_stub";
        config.RAZORPAY_KEY_SECRET = "stub";
        saved.fetch = global.fetch;
        global.fetch = async (url, init) => {
            sent.push({ url: String(url), body: JSON.parse(init.body) });
            return { ok: true, json: async () => ({ id: "sub_stub", short_url: "https://rzp.io/stub" }) };
        };
    });

    after(async () => {
        Object.assign(config, { BILLING_PROVIDER: saved.BILLING_PROVIDER, RAZORPAY_KEY_ID: saved.RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET: saved.RAZORPAY_KEY_SECRET });
        global.fetch = saved.fetch;
        await Org.deleteMany({ orgId: { $in: created } });
        await Subscription.deleteMany({ orgId: { $in: created } });
        await mongoose.disconnect();
    });

    test("an INR workspace is sent to the INR plan, and the currency rides in the notes", async () => {
        sent = [];
        const orgId = await makeOrg("INR");
        const result = await billingFunctions.createCheckout({ orgId, planId: "GROWTH" });
        assert.equal(result.status, 200, JSON.stringify(result.json));
        assert.equal(sent.length, 1, "exactly one provider call");
        assert.equal(sent[0].body.plan_id, config.BILLING_VARIANT_IDS.INR.GROWTH);
        assert.notEqual(sent[0].body.plan_id, config.BILLING_VARIANT_IDS.USD.GROWTH, "never the USD plan");
        assert.equal(sent[0].body.notes.currency, "INR");
    });

    test("a USD workspace is sent to the USD plan", async () => {
        sent = [];
        const orgId = await makeOrg("USD");
        const result = await billingFunctions.createCheckout({ orgId, planId: "STARTER" });
        assert.equal(result.status, 200, JSON.stringify(result.json));
        assert.equal(sent[0].body.plan_id, config.BILLING_VARIANT_IDS.USD.STARTER);
        assert.equal(sent[0].body.notes.currency, "USD");
    });

    test("a missing INR plan id is a 503 that names the gap — and the provider is never called", async () => {
        sent = [];
        const orgId = await makeOrg("INR");
        const real = config.BILLING_VARIANT_IDS.INR.SCALE;
        config.BILLING_VARIANT_IDS.INR.SCALE = null;
        try {
            const result = await billingFunctions.createCheckout({ orgId, planId: "SCALE" });
            assert.equal(result.status, 503);
            assert.match(result.json.error, /INR/);
            assert.match(result.json.error, /Scale/);
            assert.equal(sent.length, 0, "no USD substitution, no network");
        } finally {
            config.BILLING_VARIANT_IDS.INR.SCALE = real;
        }
    });
});
