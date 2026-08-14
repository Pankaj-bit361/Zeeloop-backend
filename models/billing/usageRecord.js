const mongoose = require("mongoose");

// One row per workspace per billing period (§0.3). Kept as history rather than
// a counter on Org so an invoicing dispute can be answered with the actual
// period rows, and so a period rollover is a new document rather than a
// destructive reset that loses what came before.
const usageRecordSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        usageRecordId: { type: String, required: true, unique: true },

        periodStart: { type: Date, required: true },
        periodEnd: { type: Date, required: true },
        // Snapshotted at period open. The plan can change mid-period; the limits
        // that were in force when usage accrued are the ones a dispute needs.
        plan: { type: String, required: true },
        conversationsLimit: { type: mongoose.Schema.Types.Mixed, default: null },
        costUsdLimit: { type: mongoose.Schema.Types.Mixed, default: null },

        conversations: { type: Number, default: 0 },
        turns: { type: Number, default: 0 },
        costUsd: { type: Number, default: 0 },
        inputTokens: { type: Number, default: 0 },
        outputTokens: { type: Number, default: 0 },

        // Set the first time each threshold is crossed, so the warning email
        // and the owner notification fire exactly once per period.
        softLimitNotifiedAt: { type: Date, default: null },
        hardLimitReachedAt: { type: Date, default: null },
        costCeilingReachedAt: { type: Date, default: null },
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

// The hot path is "current period for this org", hit on every widget turn.
usageRecordSchema.index({ orgId: 1, periodStart: -1 });

module.exports = mongoose.model("UsageRecord", usageRecordSchema);
