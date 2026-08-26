"use strict";
/* Razorpay adapter — pure unit tests, no server and no network.
   These are the parts that fail silently rather than loudly:

     A signature check that always returns false looks exactly like an attack.
     A status map that guesses wrong either cuts off a paying customer or
     serves a free one.
     A timestamp read in the wrong unit dates every renewal to 1970, and the
     grace-period sweep then suspends the entire customer base at once.
     An idempotency key that is constant per subscription rather than per
     delivery silently discards every event after the first. */
const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const config = require("../config/config");
const razorpay = require("../functions/billing/providers/razorpayProvider");
const { getProvider, nullProvider } = require("../functions/billing/providers");
const { SubscriptionStatus, BillingProvider, PlanId } = require("../config/enums");

const WEBHOOK_SECRET = "test_webhook_secret_not_a_real_one";

const sign = (body, secret = WEBHOOK_SECRET) =>
    crypto.createHmac("sha256", secret).update(body).digest("hex");

let saved;
beforeEach(() => {
    saved = {
        secret: config.RAZORPAY_WEBHOOK_SECRET,
        keyId: config.RAZORPAY_KEY_ID,
        keySecret: config.RAZORPAY_KEY_SECRET,
    };
    config.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
    config.RAZORPAY_KEY_ID = "rzp_test_key";
    config.RAZORPAY_KEY_SECRET = "rzp_test_secret";
});
afterEach(() => {
    config.RAZORPAY_WEBHOOK_SECRET = saved.secret;
    config.RAZORPAY_KEY_ID = saved.keyId;
    config.RAZORPAY_KEY_SECRET = saved.keySecret;
});

const subscriptionEvent = (over = {}) => ({
    event: over.event || "subscription.activated",
    payload: {
        subscription: {
            entity: {
                id: "sub_ABC123",
                plan_id: "plan_XYZ",
                status: over.status || "active",
                current_end: over.current_end,
                customer_id: "cust_1",
                notes: over.notes !== undefined ? over.notes : { org_id: "org_1", plan_id: "STARTER" },
                ...(over.entity || {}),
            },
        },
    },
});

const headers = (id = "evt_delivery_1") => ({ "x-razorpay-event-id": id });

describe("signature verification", () => {
    test("accepts a correctly signed body", () => {
        const raw = Buffer.from(JSON.stringify(subscriptionEvent()));
        assert.equal(razorpay.verifySignature({ rawBody: raw, headers: { "x-razorpay-signature": sign(raw) } }), true);
    });

    test("rejects a signature over different bytes", () => {
        const raw = Buffer.from(JSON.stringify(subscriptionEvent()));
        const other = Buffer.from(JSON.stringify(subscriptionEvent({ status: "cancelled" })));
        assert.equal(razorpay.verifySignature({ rawBody: raw, headers: { "x-razorpay-signature": sign(other) } }), false);
    });

    test("rejects a signature made with the wrong secret", () => {
        // The API key secret and the webhook secret are different values and
        // are easy to confuse.
        const raw = Buffer.from(JSON.stringify(subscriptionEvent()));
        assert.equal(
            razorpay.verifySignature({ rawBody: raw, headers: { "x-razorpay-signature": sign(raw, "wrong") } }),
            false
        );
    });

    test("rejects a malformed signature instead of throwing", () => {
        // timingSafeEqual throws on a length mismatch; that must not become a
        // 500, which would tell an attacker their guess was interesting.
        const raw = Buffer.from(JSON.stringify(subscriptionEvent()));
        assert.equal(razorpay.verifySignature({ rawBody: raw, headers: { "x-razorpay-signature": "nothex!!" } }), false);
        assert.equal(razorpay.verifySignature({ rawBody: raw, headers: { "x-razorpay-signature": "ab" } }), false);
    });

    test("refuses everything when no webhook secret is configured", () => {
        config.RAZORPAY_WEBHOOK_SECRET = "";
        const raw = Buffer.from(JSON.stringify(subscriptionEvent()));
        assert.equal(razorpay.verifySignature({ rawBody: raw, headers: { "x-razorpay-signature": sign(raw) } }), false);
    });

    test("refuses when the raw body is missing", () => {
        // Re-serialising the parsed body produces different bytes and would
        // never match; the guard makes that a refusal rather than a mystery.
        assert.equal(razorpay.verifySignature({ rawBody: null, headers: { "x-razorpay-signature": "aa" } }), false);
    });
});

describe("event parsing", () => {
    test("uses the per-delivery header as the idempotency key", () => {
        // NOT the subscription id: that is identical across every event for a
        // subscription, so the second event onwards would collide with the
        // unique index and be discarded as a duplicate. Cancellations and
        // payment failures would never apply.
        const event = razorpay.parseEvent(subscriptionEvent(), headers("evt_9"));
        assert.equal(event.providerEventId, "evt_9");
        assert.notEqual(event.providerEventId, "sub_ABC123");
    });

    test("two different events on one subscription get different keys", () => {
        const first = razorpay.parseEvent(subscriptionEvent(), headers("evt_1"));
        const second = razorpay.parseEvent(subscriptionEvent({ event: "subscription.cancelled", status: "cancelled" }), headers("evt_2"));
        assert.notEqual(first.providerEventId, second.providerEventId);
    });

    test("declines an event with no delivery id rather than inventing one", () => {
        // Applying a billing event twice is worse than dropping it.
        assert.equal(razorpay.parseEvent(subscriptionEvent(), {}), null);
    });

    test("recovers orgId from notes", () => {
        const event = razorpay.parseEvent(subscriptionEvent(), headers());
        assert.equal(event.orgId, "org_1");
        assert.equal(event.planId, "STARTER");
    });

    test("an event with no notes has no orgId, and says so", () => {
        // Guessing which workspace paid is worse than failing.
        const event = razorpay.parseEvent(subscriptionEvent({ notes: {} }), headers());
        assert.equal(event.orgId, null);
    });

    test("current_end is read as unix SECONDS", () => {
        const seconds = 1893456000; // 2030-01-01
        const event = razorpay.parseEvent(subscriptionEvent({ current_end: seconds }), headers());
        assert.equal(event.currentPeriodEnd.getUTCFullYear(), 2030);
        // The bug this guards: treating seconds as milliseconds dates every
        // renewal to 1970 and the grace sweep suspends everyone at once.
        assert.ok(event.currentPeriodEnd.getTime() > Date.now());
    });

    test("returns null for an event shape we do not model", () => {
        assert.equal(razorpay.parseEvent({ event: "ping" }, headers()), null);
        assert.equal(razorpay.parseEvent({}, headers()), null);
        assert.equal(razorpay.parseEvent(null, headers()), null);
    });
});

describe("status mapping", () => {
    const statusFor = (status) => razorpay.parseEvent(subscriptionEvent({ status }), headers()).status;

    test("active is ACTIVE", () => {
        assert.equal(statusFor("active"), SubscriptionStatus.ACTIVE);
    });

    test("authenticated grants access", () => {
        // The mandate is approved and the charge is imminent. Locking the
        // customer out until it settles is the wrong side to err on.
        assert.equal(statusFor("authenticated"), SubscriptionStatus.TRIALING);
    });

    test("a failed charge is PAST_DUE, not CANCELLED", () => {
        // A card that failed and a customer who left need different emails.
        assert.equal(statusFor("pending"), SubscriptionStatus.PAST_DUE);
        assert.equal(statusFor("halted"), SubscriptionStatus.PAST_DUE);
    });

    test("cancelled and completed are distinguished", () => {
        assert.equal(statusFor("cancelled"), SubscriptionStatus.CANCELLED);
        assert.equal(statusFor("completed"), SubscriptionStatus.EXPIRED);
        assert.equal(statusFor("expired"), SubscriptionStatus.EXPIRED);
    });

    test("created maps to nothing, so an unpaid intent changes no access", () => {
        assert.equal(statusFor("created"), null);
    });

    test("an unknown status maps to null rather than a guess", () => {
        assert.equal(statusFor("some_new_state_razorpay_added"), null);
    });
});

describe("in-page checkout config", () => {
    /* `embed` is handed to the browser so Checkout.js can open the payment
       sheet without redirecting to the hosted summary page. Everything in it is
       public by design — but it is assembled next to RAZORPAY_KEY_SECRET, and
       one wrong property name there hands an attacker the ability to create
       subscriptions, issue refunds and read every customer on the account. */
    const stubFetch = (body) => {
        const original = global.fetch;
        global.fetch = async () => ({ ok: true, json: async () => body, text: async () => "" });
        return () => {
            global.fetch = original;
        };
    };

    const checkout = () =>
        razorpay.createCheckout({
            orgId: "org_1",
            planId: PlanId.STARTER,
            variantId: "plan_XYZ",
            email: "a@b.test",
        });

    test("carries the subscription id and the PUBLIC key, and nothing else", async () => {
        const restore = stubFetch({ id: "sub_9", short_url: "https://rzp.io/i/abc" });
        try {
            const result = await checkout();
            assert.equal(result.embed.subscriptionId, "sub_9");
            assert.equal(result.embed.publicKey, "rzp_test_key");
            assert.deepEqual(Object.keys(result.embed).sort(), ["provider", "publicKey", "subscriptionId"]);
        } finally {
            restore();
        }
    });

    test("the API key secret appears nowhere in what the browser receives", async () => {
        const restore = stubFetch({ id: "sub_9", short_url: "https://rzp.io/i/abc" });
        try {
            const result = await checkout();
            // Serialised, because a secret nested at any depth is still a
            // secret and a key-by-key check would miss it.
            const wire = JSON.stringify({ url: result.url, embed: result.embed });
            assert.equal(wire.includes(config.RAZORPAY_KEY_SECRET), false, "the key secret is being sent to the client");
        } finally {
            restore();
        }
    });

    test("no subscription id means no embed, so the client redirects instead", async () => {
        // A sheet cannot be opened without an id. Returning a half-built embed
        // would fail in the browser rather than here.
        const restore = stubFetch({ short_url: "https://rzp.io/i/abc" });
        try {
            const result = await checkout();
            assert.equal(result.success, true);
            assert.equal(result.url, "https://rzp.io/i/abc");
            assert.equal(result.embed, null);
        } finally {
            restore();
        }
    });
});

describe("configuration", () => {
    test("isConfigured needs both key id and secret", () => {
        assert.equal(razorpay.isConfigured(), true);
        config.RAZORPAY_KEY_SECRET = "";
        assert.equal(razorpay.isConfigured(), false);
    });

    test("every paid plan has a USD provider plan id, and no two share one", () => {
        /* The ids are three near-identical opaque strings pasted from a console.
           Duplicate one and the customer who clicked Growth is charged Starter's
           $29 — the subscription activates, the webhook applies whatever the
           notes said, and every screen agrees with itself. `npm run verify:plans`
           catches it against the live API; this catches it without a network. */
        const ids = [PlanId.STARTER, PlanId.GROWTH, PlanId.SCALE].map((id) => {
            const variantId = config.BILLING_VARIANT_IDS.USD[id];
            assert.ok(variantId, `${id} has no USD provider plan id configured`);
            return variantId;
        });
        assert.equal(new Set(ids).size, ids.length, `duplicate plan id among ${ids.join(", ")}`);
    });

    test("INR plan ids, where configured, are distinct from every USD one", () => {
        /* A Razorpay plan is created in one currency. Pasting a USD id into an
           INR slot would send an Indian workspace to the exact plan Razorpay
           says their card cannot pay — the failure this whole split exists to
           prevent, reintroduced by a copy-paste. */
        const usd = new Set(Object.values(config.BILLING_VARIANT_IDS.USD));
        for (const [planId, variantId] of Object.entries(config.BILLING_VARIANT_IDS.INR)) {
            if (!variantId) continue;
            assert.ok(!usd.has(variantId), `${planId} INR id ${variantId} is also a USD id`);
        }
        const inr = Object.values(config.BILLING_VARIANT_IDS.INR).filter(Boolean);
        assert.equal(new Set(inr).size, inr.length, "duplicate INR plan id");
    });

    test("checkout passes the currency through to the provider notes", () => {
        /* The webhook stamps subscription.currency from these notes. Drop the
           field and every subscription is currency-less, and the lock that
           stops someone flipping price lists under a live charge never engages. */
        let sent = null;
        const originalFetch = global.fetch;
        global.fetch = async (url, init) => {
            sent = JSON.parse(init.body);
            return { ok: true, json: async () => ({ id: "sub_x", short_url: "https://rzp.io/x" }) };
        };
        return razorpay
            .createCheckout({ orgId: "org_1", planId: PlanId.GROWTH, variantId: "plan_inr", currency: "INR" })
            .then((result) => {
                assert.equal(result.success, true);
                assert.equal(sent.notes.currency, "INR");
                assert.equal(sent.plan_id, "plan_inr");
            })
            .finally(() => {
                global.fetch = originalFetch;
            });
    });

    test("the registry resolves RAZORPAY to this adapter", () => {
        const saved = config.BILLING_PROVIDER;
        config.BILLING_PROVIDER = BillingProvider.RAZORPAY;
        // getProvider resolves through the same registry the app uses.
        assert.equal(getProvider().id, BillingProvider.RAZORPAY);
        config.BILLING_PROVIDER = "SOMETHING_ELSE";
        assert.equal(getProvider().id, nullProvider.id);
        config.BILLING_PROVIDER = saved;
    });
});
