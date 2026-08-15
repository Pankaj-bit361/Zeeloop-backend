const config = require("../../config/config");
const {
    PlanId,
    SubscriptionStatus,
    BillingProvider,
    EmailKind,
    IdPrefix,
} = require("../../config/enums");
const { TRIAL_DAYS, GRACE_PERIOD_DAYS, getPlan } = require("../../config/plans");
const Subscription = require("../../models/billing/subscription");
const Org = require("../../models/org/org");
const generalFunctions = require("../utilFunctions/generalFunctions");
const emailFunctions = require("../email/emailFunctions");

// §0.5 — trial and lifecycle. The part of billing that runs on a clock rather
// than on a webhook.
//
// Everything here is idempotent, because it runs on cron and cron runs twice:
// a retry, an overlapping deploy, two instances. The state transitions are
// guarded by their own preconditions, and the emails are guarded by EmailLog's
// unique index — so running the whole sweep five times in a row produces the
// same result as running it once.
//
// The trial takes no card, so it cannot fail to convert. It simply ends and the
// workspace drops to FREE with everything intact. A trial that suspended a
// working agent would punish the exact customer who was still evaluating.

const DAY_MS = 24 * 60 * 60 * 1000;

// Notice days, counted from the trial end. Day 14 in the PRD is the "it ended"
// email, which fires from the expiry sweep rather than as a countdown.
const TRIAL_NOTICE_DAYS = [
    { daysBefore: 7, kind: EmailKind.TRIAL_ENDING_7 },
    { daysBefore: 2, kind: EmailKind.TRIAL_ENDING_2 },
];

// Sent while past due, counted from the grace period's end.
const DUNNING_NOTICE_DAYS = [5, 2];

class SubscriptionFunctions {
    // ── Public Functions ─────────────────────────────────────────────

    // Called once, at workspace creation. Idempotent: an org that already has a
    // subscription keeps it, so re-running a backfill cannot restart someone's
    // trial.
    async startTrial({ orgId }) {
        console.log("SubscriptionFunctions:startTrial: orgId:", orgId);
        try {
            const existing = await Subscription.findOne({ orgId });
            if (existing) return { success: true, created: false };

            const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * DAY_MS);
            await Subscription.create({
                orgId,
                subscriptionId: generalFunctions.generateId(IdPrefix.SUBSCRIPTION),
                // Trialling ON the paid tier, not on FREE. A trial of the free
                // plan is not a trial — the point is to let someone build the
                // thing they would actually pay for, tables and actions
                // included, and discover what they lose if they stop.
                plan: PlanId.GROWTH,
                status: SubscriptionStatus.TRIALING,
                provider: BillingProvider.NONE,
                currentPeriodStart: new Date(),
                currentPeriodEnd: trialEndsAt,
                trialEndsAt,
            });

            return { success: true, created: true, trialEndsAt };
        } catch (error) {
            console.error("SubscriptionFunctions:startTrial: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            // Never fails workspace creation. A missing subscription row is
            // repaired by billingFunctions._ensureSubscription on first read;
            // a workspace that failed to be created is not repaired by anything.
            return { success: false, created: false };
        }
    }

    // The daily sweep. Called by cron and by the tests, which is why it returns
    // counts rather than logging them: an idempotency claim you cannot assert on
    // is a hope.
    async runLifecycleSweep({ now }) {
        console.log("SubscriptionFunctions:runLifecycleSweep");
        try {
            const at = now ? new Date(now) : new Date();
            const [notices, expired, dunning, suspended] = await Promise.all([
                this._sendTrialNotices({ at }),
                this._expireTrials({ at }),
                this._sendDunningNotices({ at }),
                this._suspendPastDue({ at }),
            ]);

            return {
                success: true,
                trialNoticesSent: notices.sent,
                trialsExpired: expired.count,
                dunningNoticesSent: dunning.sent,
                subscriptionsSuspended: suspended.count,
            };
        } catch (error) {
            console.error("SubscriptionFunctions:runLifecycleSweep: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { success: false };
        }
    }

    // Called from the webhook path when a payment fails (§0.5). Starts the
    // grace clock exactly once — a provider that retries the charge three times
    // sends three failure webhooks, and restarting the clock on each would give
    // a non-paying workspace an indefinite grace period.
    async beginGracePeriod({ orgId }) {
        console.log("SubscriptionFunctions:beginGracePeriod: orgId:", orgId);
        try {
            const subscription = await Subscription.findOne({ orgId });
            if (!subscription) return { success: false };

            if (subscription.gracePeriodEndsAt && subscription.gracePeriodEndsAt > new Date()) {
                console.log("SubscriptionFunctions:beginGracePeriod: already in grace, not restarting");
                return { success: true, restarted: false };
            }

            subscription.status = SubscriptionStatus.PAST_DUE;
            subscription.gracePeriodEndsAt = new Date(Date.now() + GRACE_PERIOD_DAYS * DAY_MS);
            await subscription.save();

            const org = await Org.findOne({ orgId }).lean();
            if (org) {
                await emailFunctions.send({
                    orgId,
                    kind: EmailKind.PAYMENT_FAILED,
                    to: org.ownerEmail,
                    // Keyed on the grace window, not just the org: a second
                    // failure months later is a different event and should send.
                    dedupeKey: `${orgId}:PAYMENT_FAILED:${subscription.gracePeriodEndsAt.toISOString().slice(0, 10)}`,
                    data: { orgName: org.name, graceDays: GRACE_PERIOD_DAYS, appUrl: config.APP_URL },
                });
            }

            return { success: true, restarted: true, gracePeriodEndsAt: subscription.gracePeriodEndsAt };
        } catch (error) {
            console.error("SubscriptionFunctions:beginGracePeriod: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { success: false };
        }
    }

    // ── Private Helper Functions ─────────────────────────────────────

    async _sendTrialNotices({ at }) {
        let sent = 0;
        try {
            const subscriptions = await Subscription.find({
                status: SubscriptionStatus.TRIALING,
                trialEndsAt: { $gt: at },
            }).lean();

            for (const subscription of subscriptions) {
                const daysLeft = Math.ceil((new Date(subscription.trialEndsAt) - at) / DAY_MS);
                const notice = TRIAL_NOTICE_DAYS.find((entry) => entry.daysBefore === daysLeft);
                if (!notice) continue;

                const org = await Org.findOne({ orgId: subscription.orgId }).lean();
                if (!org) continue;

                const result = await emailFunctions.send({
                    orgId: subscription.orgId,
                    kind: notice.kind,
                    to: org.ownerEmail,
                    dedupeKey: `${subscription.orgId}:${notice.kind}:${subscription.subscriptionId}`,
                    data: { orgName: org.name, daysLeft, appUrl: config.APP_URL },
                });
                if (result.success && !result.skipped) sent += 1;
            }
        } catch (error) {
            console.error("SubscriptionFunctions:_sendTrialNotices: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
        }
        return { sent };
    }

    async _expireTrials({ at }) {
        let count = 0;
        try {
            const expired = await Subscription.find({
                status: SubscriptionStatus.TRIALING,
                trialEndsAt: { $lte: at },
            });

            for (const subscription of expired) {
                // No card was taken, so there is nothing to charge and nothing
                // to suspend. Drop to FREE and say so.
                subscription.status = SubscriptionStatus.EXPIRED;
                subscription.plan = PlanId.FREE;
                // The billing period has to keep moving or usage never resets
                // and the workspace looks permanently over its limit.
                subscription.currentPeriodStart = at;
                subscription.currentPeriodEnd = new Date(at.getTime() + 30 * DAY_MS);
                await subscription.save();

                await Org.updateOne(
                    { orgId: subscription.orgId },
                    { $set: { "credits.plan": PlanId.FREE, "credits.conversationsLimit": getPlan(PlanId.FREE).limits.conversations } }
                );

                const org = await Org.findOne({ orgId: subscription.orgId }).lean();
                if (org) {
                    await emailFunctions.send({
                        orgId: subscription.orgId,
                        kind: EmailKind.TRIAL_ENDED,
                        to: org.ownerEmail,
                        dedupeKey: `${subscription.orgId}:TRIAL_ENDED:${subscription.subscriptionId}`,
                        data: { orgName: org.name, appUrl: config.APP_URL },
                    });
                }
                count += 1;
            }
        } catch (error) {
            console.error("SubscriptionFunctions:_expireTrials: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
        }
        return { count };
    }

    async _sendDunningNotices({ at }) {
        let sent = 0;
        try {
            const pastDue = await Subscription.find({
                status: SubscriptionStatus.PAST_DUE,
                gracePeriodEndsAt: { $gt: at },
            }).lean();

            for (const subscription of pastDue) {
                const daysLeft = Math.ceil((new Date(subscription.gracePeriodEndsAt) - at) / DAY_MS);
                if (!DUNNING_NOTICE_DAYS.includes(daysLeft)) continue;

                const org = await Org.findOne({ orgId: subscription.orgId }).lean();
                if (!org) continue;

                const result = await emailFunctions.send({
                    orgId: subscription.orgId,
                    kind: EmailKind.DUNNING_REMINDER,
                    to: org.ownerEmail,
                    // Day-specific, so the two reminders in one grace window are
                    // two different emails rather than one deduped away.
                    dedupeKey: `${subscription.orgId}:DUNNING:${subscription.subscriptionId}:${daysLeft}`,
                    data: { orgName: org.name, daysLeft, appUrl: config.APP_URL },
                });
                if (result.success && !result.skipped) sent += 1;
            }
        } catch (error) {
            console.error("SubscriptionFunctions:_sendDunningNotices: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
        }
        return { sent };
    }

    async _suspendPastDue({ at }) {
        let count = 0;
        try {
            const lapsed = await Subscription.find({
                status: SubscriptionStatus.PAST_DUE,
                gracePeriodEndsAt: { $lte: at },
            });

            for (const subscription of lapsed) {
                subscription.status = SubscriptionStatus.EXPIRED;
                subscription.plan = PlanId.FREE;
                subscription.currentPeriodStart = at;
                subscription.currentPeriodEnd = new Date(at.getTime() + 30 * DAY_MS);
                await subscription.save();

                await Org.updateOne(
                    { orgId: subscription.orgId },
                    { $set: { "credits.plan": PlanId.FREE, "credits.conversationsLimit": getPlan(PlanId.FREE).limits.conversations } }
                );

                const org = await Org.findOne({ orgId: subscription.orgId }).lean();
                if (org) {
                    await emailFunctions.send({
                        orgId: subscription.orgId,
                        kind: EmailKind.SUBSCRIPTION_SUSPENDED,
                        to: org.ownerEmail,
                        dedupeKey: `${subscription.orgId}:SUSPENDED:${subscription.subscriptionId}:${at.toISOString().slice(0, 10)}`,
                        data: { orgName: org.name, appUrl: config.APP_URL },
                    });
                }
                count += 1;
            }
        } catch (error) {
            console.error("SubscriptionFunctions:_suspendPastDue: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
        }
        return { count };
    }
}

module.exports = new SubscriptionFunctions();
module.exports.TRIAL_NOTICE_DAYS = TRIAL_NOTICE_DAYS;
module.exports.DUNNING_NOTICE_DAYS = DUNNING_NOTICE_DAYS;
