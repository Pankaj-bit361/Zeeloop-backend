const config = require("../../config/config");
const {
    IdPrefix,
    PlanId,
    SubscriptionStatus,
    BillingProvider,
} = require("../../config/enums");
const { getPlan, TRIAL_DAYS, GRACE_PERIOD_DAYS } = require("../../config/plans");
const Subscription = require("../../models/billing/subscription");
const WebhookEvent = require("../../models/billing/webhookEvent");
const Org = require("../../models/org/org");
const generalFunctions = require("../utilFunctions/generalFunctions");
const usageFunctions = require("./usageFunctions");
const { getProvider } = require("./providers");

const DAY_MS = 24 * 60 * 60 * 1000;

class BillingFunctions {
    // ── Public Functions ─────────────────────────────────────────────

    async getBilling({ orgId }) {
        console.log("BillingFunctions:getBilling: orgId:", orgId);
        try {
            if (!orgId) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId" } };
            }

            const ensured = await this._ensureSubscription({ orgId });
            if (!ensured.success) {
                return { status: 500, json: { success: false, error: "Could not resolve subscription" } };
            }

            const subscription = ensured.subscription;
            const effective = this._resolveEffectivePlanId({ subscription });
            const plan = getPlan(effective.planId);
            const usage = await usageFunctions.getCurrentUsage({ orgId, subscription });

            return {
                status: 200,
                json: {
                    success: true,
                    data: {
                        plan: {
                            id: plan.id,
                            name: plan.name,
                            priceUsd: plan.priceUsd,
                            features: plan.features,
                            limits: plan.limits,
                        },
                        // The plan they are paying for, which can differ from the
                        // effective one while past due or after cancelling.
                        subscribedPlan: subscription.plan,
                        status: subscription.status,
                        downgradeReason: effective.reason,
                        currentPeriodStart: subscription.currentPeriodStart,
                        currentPeriodEnd: subscription.currentPeriodEnd,
                        trialEndsAt: subscription.trialEndsAt,
                        gracePeriodEndsAt: subscription.gracePeriodEndsAt,
                        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
                        updatePaymentMethodUrl: subscription.updatePaymentMethodUrl,
                        customerPortalUrl: subscription.customerPortalUrl,
                        usage: usage.success ? usage.usage : null,
                    },
                },
            };
        } catch (error) {
            console.error("BillingFunctions:getBilling: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async createCheckout({ orgId, planId, email, name }) {
        console.log("BillingFunctions:createCheckout: orgId:", orgId, "planId:", planId);
        try {
            if (!orgId || !planId) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId and planId" } };
            }
            if (planId === PlanId.FREE || !getPlan(planId) || getPlan(planId).id !== planId) {
                return { status: 400, json: { success: false, error: "Not a purchasable plan" } };
            }

            const provider = getProvider();
            if (!provider.isConfigured()) {
                // 503 rather than 500: this is a deployment gap, not a bug, and
                // the dashboard should say "billing is not set up yet".
                return { status: 503, json: { success: false, error: "Billing is not configured on this deployment" } };
            }

            const variantId = config.BILLING_VARIANT_IDS[planId];
            if (!variantId) {
                return { status: 503, json: { success: false, error: `No provider variant configured for ${planId}` } };
            }

            const org = await Org.findOne({ orgId });
            if (!org) {
                return { status: 404, json: { success: false, error: "Org not found" } };
            }

            const result = await provider.createCheckout({
                orgId,
                planId,
                variantId,
                email: email || org.ownerEmail,
                name: name || org.name,
                redirectUrl: `${config.APP_URL}/billing?checkout=success`,
            });

            if (!result.success) {
                console.error("BillingFunctions:createCheckout: provider rejected", result.error, result.detail || "");
                return { status: 502, json: { success: false, error: result.error } };
            }

            /* `url` is always present and is the fallback every client can
               take. `embed` is set only by providers that can open a payment
               sheet in the page, and is null otherwise — a client that ignores
               it still works, and a provider that cannot do it needs no
               special case here. */
            return { status: 200, json: { success: true, data: { url: result.url, embed: result.embed || null } } };
        } catch (error) {
            console.error("BillingFunctions:createCheckout: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async cancelSubscription({ orgId }) {
        console.log("BillingFunctions:cancelSubscription: orgId:", orgId);
        try {
            if (!orgId) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId" } };
            }

            const subscription = await Subscription.findOne({ orgId });
            if (!subscription || !subscription.providerSubscriptionId) {
                return { status: 404, json: { success: false, error: "No active subscription to cancel" } };
            }

            const provider = getProvider();
            const result = await provider.cancelSubscription({
                providerSubscriptionId: subscription.providerSubscriptionId,
            });
            if (!result.success) {
                return { status: 502, json: { success: false, error: result.error } };
            }

            // Mark intent locally, but do not drop the plan — they paid through
            // the end of the period. The webhook confirms the rest.
            subscription.cancelAtPeriodEnd = true;
            subscription.cancelledAt = new Date();
            await subscription.save();

            return {
                status: 200,
                json: {
                    success: true,
                    data: { cancelAtPeriodEnd: true, activeUntil: subscription.currentPeriodEnd },
                },
            };
        } catch (error) {
            console.error("BillingFunctions:cancelSubscription: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // Webhook entry point. Verification happens here rather than in the route so
    // the route stays thin (Rule 1) and so tests can drive it directly.
    async processWebhook({ rawBody, signature, body, headers }) {
        console.log("BillingFunctions:processWebhook");
        try {
            const provider = getProvider();
            if (!provider.isConfigured()) {
                return { status: 503, json: { success: false, error: "Billing is not configured on this deployment" } };
            }

            if (!provider.verifySignature({ rawBody, signature, headers })) {
                // 401, and deliberately no detail — a caller who cannot sign has
                // no business learning why the signature failed.
                return { status: 401, json: { success: false, error: "Invalid signature" } };
            }

            const event = provider.parseEvent(body, headers);
            if (!event || !event.providerEventId) {
                // Unmodelled event. 200 so the provider stops retrying it.
                return { status: 200, json: { success: true, data: { ignored: true } } };
            }

            // Idempotency: insert first and let the unique index reject the
            // duplicate. find-then-insert has a race that two concurrent
            // deliveries of the same event will eventually find.
            let ledgerEntry;
            try {
                ledgerEntry = await WebhookEvent.create({
                    webhookEventId: generalFunctions.generateId(IdPrefix.WEBHOOK_EVENT),
                    provider: provider.id,
                    providerEventId: event.providerEventId,
                    eventType: event.eventType,
                    orgId: event.orgId,
                    payload: body,
                    attempts: 1,
                });
            } catch (error) {
                if (error && error.code === 11000) {
                    console.log("BillingFunctions:processWebhook: duplicate event, already applied:", event.providerEventId);
                    return { status: 200, json: { success: true, data: { duplicate: true } } };
                }
                throw error;
            }

            const applied = await this._applyEvent({ event });
            if (!applied.success) {
                ledgerEntry.failedAt = new Date();
                ledgerEntry.error = applied.error || "unknown";
                await ledgerEntry.save();
                // 500 so the provider retries — the event was real, we failed to
                // apply it, and dropping it silently would leave a paying
                // customer on the free plan.
                return { status: 500, json: { success: false, error: "Could not apply event" } };
            }

            ledgerEntry.processedAt = new Date();
            await ledgerEntry.save();
            return { status: 200, json: { success: true, data: { applied: true } } };
        } catch (error) {
            console.error("BillingFunctions:processWebhook: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // Used by the plan middleware on every authenticated request, so it stays
    // cheap: one indexed read, no provider round trip.
    async getEffectivePlan({ orgId }) {
        try {
            const ensured = await this._ensureSubscription({ orgId });
            if (!ensured.success) return { success: false };

            const subscription = ensured.subscription;
            const effective = this._resolveEffectivePlanId({ subscription });
            return {
                success: true,
                plan: getPlan(effective.planId),
                subscription,
                downgradeReason: effective.reason,
            };
        } catch (error) {
            console.error("BillingFunctions:getEffectivePlan: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { success: false };
        }
    }

    // ── Private Helper Functions ─────────────────────────────────────

    // Every workspace has a subscription row, including free ones. Creating it
    // lazily on first read means existing orgs do not need a migration.
    async _ensureSubscription({ orgId }) {
        const existing = await Subscription.findOne({ orgId });
        if (existing) return { success: true, subscription: existing };

        const now = new Date();
        const trialEndsAt = new Date(now.getTime() + TRIAL_DAYS * DAY_MS);
        const created = await Subscription.create({
            orgId,
            subscriptionId: generalFunctions.generateId(IdPrefix.SUBSCRIPTION),
            // A new workspace starts on a no-card trial of the entry paid plan
            // (§0.5); expiry drops it to FREE rather than suspending it.
            plan: PlanId.STARTER,
            status: SubscriptionStatus.TRIALING,
            provider: BillingProvider.NONE,
            currentPeriodStart: now,
            currentPeriodEnd: trialEndsAt,
            trialEndsAt,
        });
        return { success: true, subscription: created };
    }

    // The one place that decides what a workspace may actually do right now.
    // Deliberately pure and synchronous so it is trivially testable.
    _resolveEffectivePlanId({ subscription }) {
        const now = Date.now();

        if (subscription.status === SubscriptionStatus.ACTIVE) {
            return { planId: subscription.plan, reason: null };
        }

        if (subscription.status === SubscriptionStatus.TRIALING) {
            const trialEnd = subscription.trialEndsAt ? subscription.trialEndsAt.getTime() : 0;
            if (trialEnd > now) return { planId: subscription.plan, reason: null };
            return { planId: PlanId.FREE, reason: "TRIAL_ENDED" };
        }

        // A failed payment is usually an expired card, not a decision to leave.
        // Keep them working through the grace window.
        if (subscription.status === SubscriptionStatus.PAST_DUE) {
            const graceEnd = subscription.gracePeriodEndsAt ? subscription.gracePeriodEndsAt.getTime() : 0;
            if (graceEnd > now) return { planId: subscription.plan, reason: "PAYMENT_FAILED_IN_GRACE" };
            return { planId: PlanId.FREE, reason: "PAYMENT_FAILED" };
        }

        // Cancelled but paid through the period — they keep what they bought.
        if (subscription.status === SubscriptionStatus.CANCELLED) {
            const periodEnd = subscription.currentPeriodEnd ? subscription.currentPeriodEnd.getTime() : 0;
            if (periodEnd > now) return { planId: subscription.plan, reason: "CANCELLED_ACTIVE_UNTIL_PERIOD_END" };
            return { planId: PlanId.FREE, reason: "CANCELLED" };
        }

        return { planId: PlanId.FREE, reason: "EXPIRED" };
    }

    async _applyEvent({ event }) {
        if (!event.orgId) {
            // Without custom_data there is no workspace to attribute this to.
            // Recorded in the ledger, not applied — silently guessing which org
            // just paid would be worse than leaving it for a human.
            console.error("BillingFunctions:_applyEvent: event has no orgId, skipping:", event.eventType);
            return { success: false, error: "event carries no orgId" };
        }

        const ensured = await this._ensureSubscription({ orgId: event.orgId });
        if (!ensured.success) return { success: false, error: "no subscription" };
        const subscription = ensured.subscription;

        if (event.status) subscription.status = event.status;
        if (event.planId && getPlan(event.planId).id === event.planId) subscription.plan = event.planId;
        if (event.providerSubscriptionId) subscription.providerSubscriptionId = event.providerSubscriptionId;
        if (event.providerCustomerId) subscription.providerCustomerId = event.providerCustomerId;
        if (event.providerVariantId) subscription.providerVariantId = event.providerVariantId;
        if (event.updatePaymentMethodUrl) subscription.updatePaymentMethodUrl = event.updatePaymentMethodUrl;
        if (event.customerPortalUrl) subscription.customerPortalUrl = event.customerPortalUrl;
        if (event.trialEndsAt) subscription.trialEndsAt = event.trialEndsAt;
        subscription.cancelAtPeriodEnd = Boolean(event.cancelAtPeriodEnd);
        subscription.provider = getProvider().id;

        // A new period means a fresh usage window. Rolling it here rather than
        // on a timer means the reset is driven by the provider's own idea of
        // when the period turned over, which is the one that gets billed.
        const previousPeriodEnd = subscription.currentPeriodEnd ? subscription.currentPeriodEnd.getTime() : 0;
        if (event.currentPeriodEnd && event.currentPeriodEnd.getTime() !== previousPeriodEnd) {
            subscription.currentPeriodStart = new Date();
            subscription.currentPeriodEnd = event.currentPeriodEnd;
        }

        if (event.status === SubscriptionStatus.PAST_DUE && !subscription.gracePeriodEndsAt) {
            subscription.gracePeriodEndsAt = new Date(Date.now() + GRACE_PERIOD_DAYS * DAY_MS);
        }
        if (event.status === SubscriptionStatus.ACTIVE) {
            subscription.gracePeriodEndsAt = null;
        }

        await subscription.save();
        return { success: true };
    }
}

module.exports = new BillingFunctions();
