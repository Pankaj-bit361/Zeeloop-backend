const mongoose = require("mongoose");
const { MonitorTrigger, ReviewStatus } = require("../../config/enums");

// §3.6 — production monitors and the review queue they feed.
//
// Two collections in one file because they are two halves of one feature and
// neither is meaningful alone: a monitor with no queue produces nothing you can
// act on, and a queue with no monitor never fills.

const scorecardCriterionSchema = new mongoose.Schema(
    {
        _id: false,
        name: { type: String, required: true },
        description: { type: String, default: "" },
        weight: { type: Number, default: 1 },
    },
    { _id: false }
);

const monitorSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        monitorId: { type: String, required: true, unique: true },
        name: { type: String, required: true },
        trigger: { type: String, enum: Object.values(MonitorTrigger), required: true },
        // KEYWORD_MATCH only.
        keywords: { type: [String], default: [] },
        // RANDOM_SAMPLE only: 0.05 flags one conversation in twenty.
        samplePercent: { type: Number, default: 5 },
        // LOW_QUALITY_SCORE only.
        scoreBelow: { type: Number, default: 0.6 },
        // The rubric a reviewer — human or model — grades against. Empty means
        // flag for attention without scoring.
        scorecard: { type: [scorecardCriterionSchema], default: [] },
        // Who the queue items land on. Null means unassigned.
        assignTo: { type: String, default: null },
        enabled: { type: Boolean, default: true },
        flaggedCount: { type: Number, default: 0 },
        lastRunAt: { type: Date, default: null },
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

const reviewSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        reviewId: { type: String, required: true, unique: true },
        conversationId: { type: String, required: true },
        monitorId: { type: String, required: true },
        trigger: { type: String, enum: Object.values(MonitorTrigger), required: true },
        reason: { type: String, default: "" },
        status: { type: String, enum: Object.values(ReviewStatus), default: ReviewStatus.PENDING },
        assignedTo: { type: String, default: null },
        // Per-scorecard-criterion grades, filled in by the reviewer.
        scores: {
            type: [{ _id: false, name: String, score: Number, note: String }],
            default: [],
        },
        reviewerNote: { type: String, default: "" },
        reviewedBy: { type: String, default: null },
        reviewedAt: { type: Date, default: null },
        // §3.6 — "reviewed conversations become simulation candidates in one
        // click". Recording the link means the same conversation is not turned
        // into a second near-identical simulation next month.
        promotedSimulationId: { type: String, default: null },
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

// One conversation is flagged at most once per monitor. Without this a monitor
// re-run would enqueue the same conversation on every tick, and the queue would
// be unusable within a day.
reviewSchema.index({ orgId: 1, conversationId: 1, monitorId: 1 }, { unique: true });
reviewSchema.index({ orgId: 1, status: 1, createdAt: -1 });

module.exports = {
    Monitor: mongoose.model("Monitor", monitorSchema),
    ConversationReview: mongoose.model("ConversationReview", reviewSchema),
};
