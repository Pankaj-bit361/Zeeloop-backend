const crypto = require("crypto");
const config = require("../../../config/config");
const { SubscriptionStatus, BillingProvider } = require("../../../config/enums");

// Lemon Squeezy adapter. Everything provider-specific lives behind this
// interface — createCheckout, verifySignature, parseEvent — so swapping to
// Paddle or Stripe means writing a sibling file, not touching billingFunctions.
//
// Merchant of record, which is the reason it was chosen: they handle Indian GST
// and global VAT registration, which a two-person company cannot.

const API_BASE = "https://api.lemonsqueezy.com/v1";

// Their status vocabulary → ours. Anything unrecognised maps to null and the
// caller leaves the existing status alone rather than guessing, because
// guessing wrong here either cuts off a paying customer or serves a free one.
const STATUS_MAP = {
    on_trial: SubscriptionStatus.TRIALING,
    active: SubscriptionStatus.ACTIVE,
    past_due: SubscriptionStatus.PAST_DUE,
    unpaid: SubscriptionStatus.PAST_DUE,
    paused: SubscriptionStatus.PAST_DUE,
    cancelled: SubscriptionStatus.CANCELLED,
    expired: SubscriptionStatus.EXPIRED,
};

class LemonSqueezyProvider {
    constructor() {
        this.id = BillingProvider.LEMON_SQUEEZY;
    }

    // A provider with no key configured must not pretend to work. Callers check
    // this and return a clear 503 rather than failing deep inside an HTTP call.
    isConfigured() {
        return Boolean(config.LEMON_SQUEEZY_API_KEY && config.LEMON_SQUEEZY_STORE_ID);
    }

    // Signature verification runs on the RAW body. Re-serialising the parsed
    // JSON produces different bytes (key order, whitespace) and the HMAC will
    // never match — this is the single most common way webhook verification is
    // broken.
    verifySignature({ rawBody, signature }) {
        if (!config.LEMON_SQUEEZY_WEBHOOK_SECRET) return false;
        if (!rawBody || !signature) return false;

        const expected = crypto
            .createHmac("sha256", config.LEMON_SQUEEZY_WEBHOOK_SECRET)
            .update(rawBody)
            .digest("hex");

        const expectedBuf = Buffer.from(expected, "hex");
        let providedBuf;
        try {
            providedBuf = Buffer.from(String(signature), "hex");
        } catch (error) {
            return false;
        }
        if (providedBuf.length !== expectedBuf.length) return false;
        return crypto.timingSafeEqual(expectedBuf, providedBuf);
    }

    // Normalises one webhook body into the shape billingFunctions understands.
    // Returns null for events we do not model, which the route treats as a 200
    // — an unrecognised event is not an error, and answering 4xx would make the
    // provider retry it forever.
    parseEvent(body) {
        const eventName = body && body.meta && body.meta.event_name;
        if (!eventName) return null;

        const data = body.data || {};
        const attributes = data.attributes || {};
        const custom = (body.meta && body.meta.custom_data) || {};

        return {
            providerEventId: String((body.meta && body.meta.webhook_id) || data.id || ""),
            eventType: eventName,
            // orgId is round-tripped through checkout custom_data — it is the
            // only link back to the workspace, since the provider knows nothing
            // about our tenancy.
            orgId: custom.org_id || custom.orgId || null,
            planId: custom.plan_id || custom.planId || null,
            providerSubscriptionId: data.id ? String(data.id) : null,
            providerCustomerId: attributes.customer_id ? String(attributes.customer_id) : null,
            providerVariantId: attributes.variant_id ? String(attributes.variant_id) : null,
            status: STATUS_MAP[attributes.status] || null,
            currentPeriodEnd: attributes.renews_at ? new Date(attributes.renews_at) : null,
            trialEndsAt: attributes.trial_ends_at ? new Date(attributes.trial_ends_at) : null,
            cancelAtPeriodEnd: Boolean(attributes.cancelled),
            updatePaymentMethodUrl: (attributes.urls && attributes.urls.update_payment_method) || null,
            customerPortalUrl: (attributes.urls && attributes.urls.customer_portal) || null,
        };
    }

    async createCheckout({ orgId, planId, variantId, email, name, redirectUrl }) {
        const response = await fetch(`${API_BASE}/checkouts`, {
            method: "POST",
            headers: {
                Accept: "application/vnd.api+json",
                "Content-Type": "application/vnd.api+json",
                Authorization: `Bearer ${config.LEMON_SQUEEZY_API_KEY}`,
            },
            body: JSON.stringify({
                data: {
                    type: "checkouts",
                    attributes: {
                        checkout_data: {
                            email,
                            name,
                            // Comes back on every webhook for this subscription.
                            // Without it there is no way to know which workspace
                            // a payment belongs to.
                            custom: { org_id: orgId, plan_id: planId },
                        },
                        product_options: { redirect_url: redirectUrl },
                    },
                    relationships: {
                        store: { data: { type: "stores", id: String(config.LEMON_SQUEEZY_STORE_ID) } },
                        variant: { data: { type: "variants", id: String(variantId) } },
                    },
                },
            }),
        });

        if (!response.ok) {
            const detail = await response.text().catch(() => "");
            return { success: false, error: `Lemon Squeezy checkout failed (${response.status})`, detail };
        }

        const json = await response.json();
        const url = json && json.data && json.data.attributes && json.data.attributes.url;
        if (!url) return { success: false, error: "Lemon Squeezy returned no checkout url" };
        return { success: true, url };
    }

    async cancelSubscription({ providerSubscriptionId }) {
        const response = await fetch(`${API_BASE}/subscriptions/${providerSubscriptionId}`, {
            method: "DELETE",
            headers: {
                Accept: "application/vnd.api+json",
                Authorization: `Bearer ${config.LEMON_SQUEEZY_API_KEY}`,
            },
        });
        if (!response.ok) {
            return { success: false, error: `Lemon Squeezy cancel failed (${response.status})` };
        }
        return { success: true };
    }
}

module.exports = new LemonSqueezyProvider();
