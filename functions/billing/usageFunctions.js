const { IdPrefix, PlanId, QuotaState, LimitReason } = require("../../config/enums");
const { getPlan, SOFT_LIMIT_RATIO, isWithinLimit, UNLIMITED } = require("../../config/plans");
const Subscription = require("../../models/billing/subscription");
const UsageRecord = require("../../models/billing/usageRecord");
const generalFunctions = require("../utilFunctions/generalFunctions");

// Reads the Subscription model directly rather than going through
// billingFunctions, which requires this file — importing back would be a cycle.

class UsageFunctions {
    // ── Public Functions ─────────────────────────────────────────────

    async getCurrentUsage({ orgId, subscription = null }) {
        try {
            const record = await this._getOrCreateCurrentRecord({ orgId, subscription });
            if (!record.success) return { success: false };

            const usage = record.record;
            const plan = getPlan(usage.plan);

            return {
                success: true,
                usage: {
                    periodStart: usage.periodStart,
                    periodEnd: usage.periodEnd,
                    conversations: usage.conversations,
                    conversationsLimit: plan.limits.conversations,
                    turns: usage.turns,
                    costUsd: Number(usage.costUsd.toFixed(4)),
                    costUsdLimit: plan.limits.costUsd,
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                    // Pre-computed so the dashboard progress bar does not have to
                    // reimplement the unlimited-is-null rule.
                    conversationsPercent: this._percentOf(usage.conversations, plan.limits.conversations),
                    costPercent: this._percentOf(usage.costUsd, plan.limits.costUsd),
                },
            };
        } catch (error) {
            console.error("UsageFunctions:getCurrentUsage: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { success: false };
        }
    }

    // Called on the widget hot path before the pipeline runs, so it does one
    // indexed read and no writes.
    async checkQuota({ orgId }) {
        try {
            const record = await this._getOrCreateCurrentRecord({ orgId });
            if (!record.success) {
                // Fail open. A metering outage must not take support down for a
                // paying customer — the same posture as the Gate stage.
                return { success: true, state: QuotaState.OK, reason: null };
            }

            const usage = record.record;
            const plan = getPlan(usage.plan);

            if (!isWithinLimit(usage.costUsd, plan.limits.costUsd)) {
                return { success: true, state: QuotaState.EXCEEDED, reason: LimitReason.COST_CEILING };
            }
            if (!isWithinLimit(usage.conversations, plan.limits.conversations)) {
                return { success: true, state: QuotaState.EXCEEDED, reason: LimitReason.QUOTA_EXCEEDED };
            }

            const conversationsRatio = this._ratioOf(usage.conversations, plan.limits.conversations);
            const costRatio = this._ratioOf(usage.costUsd, plan.limits.costUsd);
            if (Math.max(conversationsRatio, costRatio) >= SOFT_LIMIT_RATIO) {
                return { success: true, state: QuotaState.WARNING, reason: null };
            }

            return { success: true, state: QuotaState.OK, reason: null };
        } catch (error) {
            console.error("UsageFunctions:checkQuota: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { success: true, state: QuotaState.OK, reason: null };
        }
    }

    // Recorded after a turn completes, never before — a turn that threw should
    // not be billed. Uses $inc so concurrent turns on the same workspace cannot
    // lose an increment to a read-modify-write race.
    async recordTurn({ orgId, costUsd = 0, inputTokens = 0, outputTokens = 0, isNewConversation = false }) {
        try {
            const record = await this._getOrCreateCurrentRecord({ orgId });
            if (!record.success) return { success: false };

            const increments = {
                turns: 1,
                costUsd: Number(costUsd) || 0,
                inputTokens: Number(inputTokens) || 0,
                outputTokens: Number(outputTokens) || 0,
                ...(isNewConversation && { conversations: 1 }),
            };

            const updated = await UsageRecord.findOneAndUpdate(
                { usageRecordId: record.record.usageRecordId },
                { $inc: increments },
                { new: true }
            );

            if (updated) await this._stampThresholds({ record: updated });
            return { success: true };
        } catch (error) {
            console.error("UsageFunctions:recordTurn: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { success: false };
        }
    }

    async listHistory({ orgId, limit = 12 }) {
        console.log("UsageFunctions:listHistory: orgId:", orgId);
        try {
            if (!orgId) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId" } };
            }
            const records = await UsageRecord.find({ orgId }).sort({ periodStart: -1 }).limit(Number(limit) || 12);
            return { status: 200, json: { success: true, data: records } };
        } catch (error) {
            console.error("UsageFunctions:listHistory: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // ── Private Helper Functions ─────────────────────────────────────

    // One record per workspace per billing period. The period comes from the
    // subscription so usage and invoicing share a clock; without a subscription
    // it falls back to a calendar month.
    async _getOrCreateCurrentRecord({ orgId, subscription = null }) {
        if (!orgId) return { success: false };

        const sub = subscription || (await Subscription.findOne({ orgId }));
        const now = new Date();

        let periodStart;
        let periodEnd;
        let planId;

        if (sub && sub.currentPeriodStart && sub.currentPeriodEnd && sub.currentPeriodEnd > now) {
            periodStart = sub.currentPeriodStart;
            periodEnd = sub.currentPeriodEnd;
            planId = sub.plan;
        } else {
            periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
            periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
            planId = sub ? sub.plan : PlanId.FREE;
        }

        const existing = await UsageRecord.findOne({ orgId, periodStart });
        if (existing) return { success: true, record: existing };

        const plan = getPlan(planId);
        try {
            const created = await UsageRecord.create({
                orgId,
                usageRecordId: generalFunctions.generateId(IdPrefix.USAGE_RECORD),
                periodStart,
                periodEnd,
                plan: planId,
                conversationsLimit: plan.limits.conversations,
                costUsdLimit: plan.limits.costUsd,
            });
            return { success: true, record: created };
        } catch (error) {
            // Two concurrent first-turns can both miss the findOne. Re-read
            // rather than failing the turn.
            if (error && error.code === 11000) {
                const raced = await UsageRecord.findOne({ orgId, periodStart });
                if (raced) return { success: true, record: raced };
            }
            throw error;
        }
    }

    // Stamped once per period so notifications fire exactly once, whichever
    // turn happens to cross the line.
    async _stampThresholds({ record }) {
        const plan = getPlan(record.plan);
        const updates = {};

        const ratio = Math.max(
            this._ratioOf(record.conversations, plan.limits.conversations),
            this._ratioOf(record.costUsd, plan.limits.costUsd)
        );

        if (ratio >= SOFT_LIMIT_RATIO && !record.softLimitNotifiedAt) {
            updates.softLimitNotifiedAt = new Date();
        }
        if (!isWithinLimit(record.conversations, plan.limits.conversations) && !record.hardLimitReachedAt) {
            updates.hardLimitReachedAt = new Date();
        }
        if (!isWithinLimit(record.costUsd, plan.limits.costUsd) && !record.costCeilingReachedAt) {
            updates.costCeilingReachedAt = new Date();
        }

        if (Object.keys(updates).length === 0) return { success: true };
        await UsageRecord.updateOne({ usageRecordId: record.usageRecordId }, { $set: updates });
        return { success: true };
    }

    _ratioOf(used, limit) {
        if (limit === UNLIMITED || !limit) return 0;
        return used / limit;
    }

    _percentOf(used, limit) {
        if (limit === UNLIMITED || !limit) return null;
        return Math.min(100, Math.round((used / limit) * 100));
    }
}

module.exports = new UsageFunctions();
