const mongoose = require("mongoose");
const { PlanId, SubscriptionStatus, BillingProvider } = require("../../config/enums");

// One row per workspace. Kept separate from Org rather than nested because
// billing state changes on a completely different clock from workspace config —
// a webhook writing here must never race a settings save writing there.
const subscriptionSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, unique: true, index: true },
        subscriptionId: { type: String, required: true, unique: true },

        plan: { type: String, enum: Object.values(PlanId), default: PlanId.FREE },
        status: { type: String, enum: Object.values(SubscriptionStatus), default: SubscriptionStatus.TRIALING },

        provider: { type: String, enum: Object.values(BillingProvider), default: BillingProvider.NONE },
        // Opaque provider-side ids. Nullable because a FREE workspace never
        // reaches the provider at all.
        providerCustomerId: { type: String, default: null },
        providerSubscriptionId: { type: String, default: null, index: true },
        providerVariantId: { type: String, default: null },

        // The billing period drives usage windows. currentPeriodEnd is what the
        // usage reset compares against, so it must always be set — a trial gets
        // one too, ending at trialEndsAt.
        currentPeriodStart: { type: Date, default: Date.now },
        currentPeriodEnd: { type: Date, required: true },

        trialEndsAt: { type: Date, default: null },
        // Set when a payment fails. Features keep working until it passes, which
        // is what separates "card expired on holiday" from "stopped paying".
        gracePeriodEndsAt: { type: Date, default: null },
        // A cancellation that has not taken effect yet. The plan stays live
        // until currentPeriodEnd — they paid for it.
        cancelAtPeriodEnd: { type: Boolean, default: false },
        cancelledAt: { type: Date, default: null },

        // Provider-hosted URLs, refreshed from webhooks. Cheaper than round
        // tripping to the provider every time the billing page loads.
        updatePaymentMethodUrl: { type: String, default: null },
        customerPortalUrl: { type: String, default: null },
    },
    {
        timestamps: true,
        toJSON: {
            transform: (doc, ret) => {
                delete ret._id;
                delete ret.__v;
                return ret;
            },
        },
    }
);

/* Two lifecycle crons sweep every tenant on the cluster: one expiring trials,
   one ending grace periods. Both were collection scans whose cost grows with
   the customer count — precisely the number nobody wants to be punished for. */
subscriptionSchema.index({ status: 1, trialEndsAt: 1 });
subscriptionSchema.index({ status: 1, gracePeriodEndsAt: 1 });

module.exports = mongoose.model("Subscription", subscriptionSchema);
