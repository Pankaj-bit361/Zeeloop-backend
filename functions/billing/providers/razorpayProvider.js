const crypto = require("crypto");
const config = require("../../../config/config");
const { SubscriptionStatus, BillingProvider } = require("../../../config/enums");

/* Razorpay adapter.

   Same interface as the Lemon Squeezy one — isConfigured, verifySignature,
   parseEvent, createCheckout, cancelSubscription — so billingFunctions does not
   know or care which is active.

   Three things differ from Lemon Squeezy in ways that matter:

   1. Razorpay is NOT a merchant of record. Lemon Squeezy was chosen partly
      because they handle GST and global VAT registration; Razorpay does not, so
      tax compliance becomes your responsibility. That is a business decision
      rather than a code one, but it should not be discovered later.

   2. Razorpay subscriptions are created server-side and return a hosted
      `short_url`. There is no "checkout session" object — the subscription
      exists in `created` state from the moment we ask for it, and only becomes
      `authenticated` once the customer approves the mandate. So an abandoned
      checkout leaves a real subscription row on their side.

   3. It is INR-native. The plan defines the amount and currency, so the ids in
      BILLING_VARIANT_IDS are Razorpay plan ids and the price lives there, not
      here. Charging in USD requires international payments to be enabled on the
      account; if that is not done, a USD plan simply fails at checkout. */

const API_BASE = "https://api.razorpay.com/v1";

/* Razorpay's subscription vocabulary → ours. Anything unrecognised maps to null
   and the caller leaves the existing status alone, because guessing wrong here
   either cuts off a paying customer or serves a free one.

   `created` is deliberately absent. It means "we asked for a subscription and
   the customer has not approved the mandate yet" — mapping it to anything would
   grant or revoke access on the strength of an intention. */
const STATUS_MAP = {
    // Mandate approved, first charge imminent. Access starts here: the customer
    // has done everything asked of them, and waiting for the charge to settle
    // would lock them out of the product they just paid for.
    authenticated: SubscriptionStatus.TRIALING,
    active: SubscriptionStatus.ACTIVE,
    // A charge failed and Razorpay is retrying. Our grace period handles it.
    pending: SubscriptionStatus.PAST_DUE,
    // Retries exhausted. Still PAST_DUE rather than CANCELLED — the customer
    // has not left, their card failed, and those deserve different emails.
    halted: SubscriptionStatus.PAST_DUE,
    cancelled: SubscriptionStatus.CANCELLED,
    // Ran its full billing cycle count without being renewed.
    completed: SubscriptionStatus.EXPIRED,
    expired: SubscriptionStatus.EXPIRED,
};

// Razorpay requires a cycle count up front; there is no "until cancelled".
// 120 monthly cycles is ten years, which is past the point anyone is reasoning
// about, and it is renewed rather than terminal.
const TOTAL_CYCLES = 120;

class RazorpayProvider {
    constructor() {
        this.id = BillingProvider.RAZORPAY;
    }

    isConfigured() {
        return Boolean(config.RAZORPAY_KEY_ID && config.RAZORPAY_KEY_SECRET);
    }

    _authHeader() {
        const pair = `${config.RAZORPAY_KEY_ID}:${config.RAZORPAY_KEY_SECRET}`;
        return `Basic ${Buffer.from(pair).toString("base64")}`;
    }

    /* Verification runs on the RAW body. Re-serialising the parsed JSON gives
       different bytes and the HMAC never matches — the single most common way
       webhook verification is silently broken.

       Razorpay signs with the WEBHOOK secret, which is a different value from
       the API key secret. Using the wrong one fails every request in a way that
       looks like an attack rather than a misconfiguration, so it is worth
       stating: RAZORPAY_WEBHOOK_SECRET is set in the webhook settings page, not
       the API keys page. */
    verifySignature({ rawBody, signature, headers }) {
        if (!config.RAZORPAY_WEBHOOK_SECRET) return false;

        const provided = signature || (headers && (headers["x-razorpay-signature"] || headers["X-Razorpay-Signature"]));
        if (!rawBody || !provided) return false;

        const expected = crypto
            .createHmac("sha256", config.RAZORPAY_WEBHOOK_SECRET)
            .update(rawBody)
            .digest("hex");

        const expectedBuf = Buffer.from(expected, "hex");
        let providedBuf;
        try {
            providedBuf = Buffer.from(String(provided), "hex");
        } catch (error) {
            return false;
        }
        // Length check first: timingSafeEqual throws on a mismatch rather than
        // returning false, which would turn a malformed signature into a 500.
        if (providedBuf.length !== expectedBuf.length) return false;
        return crypto.timingSafeEqual(expectedBuf, providedBuf);
    }

    /* Normalises one webhook into the shape billingFunctions understands.
       Returns null for events we do not model — the route answers 200, because
       a 4xx makes Razorpay retry an event we will never want. */
    parseEvent(body, headers) {
        const eventType = body && body.event;
        if (!eventType) return null;

        const subscription = body?.payload?.subscription?.entity || null;
        const payment = body?.payload?.payment?.entity || null;
        const entity = subscription || payment;
        if (!entity) return null;

        /* The idempotency key is the per-DELIVERY event id from the header.

           Razorpay sends `x-razorpay-event-id`, which is unique per webhook
           delivery. That is the only correct choice, and it is worth spelling
           out because the sibling adapter got this wrong: it fell back to the
           subscription id, which is identical across every event for that
           subscription — so after the first event, every later one collided
           with the unique index and was discarded as a duplicate. Cancellations
           and payment failures would never have applied.

           No header means no idempotency guarantee, and applying a billing
           event twice is worse than dropping it, so we decline instead. */
        const providerEventId = headers
            ? headers["x-razorpay-event-id"] || headers["X-Razorpay-Event-Id"]
            : null;
        if (!providerEventId) return null;

        // orgId round-trips through `notes`, which Razorpay echoes on every
        // event for the subscription. It is the only link back to the
        // workspace — the provider knows nothing about our tenancy.
        const notes = (subscription && subscription.notes) || (payment && payment.notes) || {};

        return {
            providerEventId: String(providerEventId),
            eventType,
            orgId: notes.org_id || notes.orgId || null,
            planId: notes.plan_id || notes.planId || null,
            currency: notes.currency || null,
            providerSubscriptionId: subscription?.id ? String(subscription.id) : null,
            providerCustomerId: entity.customer_id ? String(entity.customer_id) : null,
            // Razorpay's plan id is what our BILLING_VARIANT_IDS map holds.
            providerVariantId: subscription?.plan_id ? String(subscription.plan_id) : null,
            status: subscription ? STATUS_MAP[subscription.status] || null : null,
            // Razorpay sends unix SECONDS; Date expects milliseconds. Getting
            // this wrong dates every renewal to January 1970 and the grace
            // -period sweep then suspends every paying customer at once.
            currentPeriodEnd: subscription?.current_end ? new Date(subscription.current_end * 1000) : null,
            trialEndsAt: null,
            cancelAtPeriodEnd: Boolean(subscription?.end_at && subscription.status === "cancelled"),
            updatePaymentMethodUrl: subscription?.short_url || null,
            customerPortalUrl: null,
        };
    }

    /* Creates the subscription and hands back its hosted page.

       `variantId` is a Razorpay plan id — the plan carries the amount and
       currency, so nothing about price is sent from here. */
    async createCheckout({ orgId, planId, variantId, currency, email, name, redirectUrl }) {
        const response = await fetch(`${API_BASE}/subscriptions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: this._authHeader(),
            },
            body: JSON.stringify({
                plan_id: String(variantId),
                total_count: TOTAL_CYCLES,
                // Razorpay emails the customer about the mandate and each
                // charge. Ours are separate and cover different ground.
                customer_notify: 1,
                // Echoed on every webhook for this subscription. Without it
                // there is no way to know which workspace a payment belongs to.
                notes: {
                    org_id: orgId,
                    plan_id: planId,
                    // The plan carries the real currency; this is so the
                    // webhook can stamp it on our row without a second call.
                    currency: currency || "",
                    // Razorpay has no redirect_url on subscriptions the way a
                    // checkout session would; kept here so support can see
                    // where the customer was sent back to.
                    return_url: redirectUrl || "",
                },
                notify_info: email ? { notify_email: email } : undefined,
            }),
        });

        if (!response.ok) {
            const detail = await response.text().catch(() => "");
            return { success: false, error: `Razorpay checkout failed (${response.status})`, detail };
        }

        const json = await response.json().catch(() => null);
        const url = json && json.short_url;
        if (!url) {
            // A subscription without a short_url cannot be paid for. Report it
            // rather than returning success with nowhere to send anyone.
            return { success: false, error: "Razorpay returned no checkout url" };
        }

        /* `embed` is what lets the dashboard open the payment sheet in-page
           instead of redirecting to short_url.

           short_url is not the payment page — it is a hosted summary card with
           a "Start Subscription" button that opens the payment sheet. So the
           redirect costs the customer an extra click, a full page navigation
           off our origin, and a page that carries the Razorpay account's
           business name rather than ours.

           Checkout.js takes this subscription id and opens the same sheet
           directly. Nothing about the subscription differs — it is the one
           created above, notes and all — so the webhook path is identical
           either way.

           publicKey is the rzp_live_/rzp_test_ KEY ID, which is designed to sit
           in a browser; it identifies the account and cannot authorise
           anything. RAZORPAY_KEY_SECRET must never appear in this object. */
        return {
            success: true,
            url,
            providerSubscriptionId: json.id ? String(json.id) : null,
            embed: json.id
                ? { provider: this.id, subscriptionId: String(json.id), publicKey: config.RAZORPAY_KEY_ID }
                : null,
        };
    }

    async cancelSubscription({ providerSubscriptionId }) {
        const response = await fetch(`${API_BASE}/subscriptions/${providerSubscriptionId}/cancel`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: this._authHeader(),
            },
            // Cancel at the end of the paid period rather than immediately.
            // They paid for the month; taking it away the moment they click
            // cancel is the kind of thing people remember.
            body: JSON.stringify({ cancel_at_cycle_end: 1 }),
        });

        if (!response.ok) {
            const detail = await response.text().catch(() => "");
            return { success: false, error: `Razorpay cancel failed (${response.status})`, detail };
        }
        return { success: true };
    }
}

module.exports = new RazorpayProvider();
