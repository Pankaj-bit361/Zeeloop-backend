const mongoose = require("mongoose");

// §3.5 — content gaps, clustered and turned into something actionable.
//
// The existing analytics already detect `belowThreshold` traces and group them
// by exact query string. That grouping is close to useless in practice: "how do
// I cancel", "can I cancel my plan" and "cancellation process" are one gap and
// three groups. This model holds the clustered version, where membership is
// decided by embedding distance rather than string equality.
const recommendationSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        recommendationId: { type: String, required: true, unique: true },
        // The query chosen to represent the cluster — the one closest to the
        // centroid, so the label reads like something a customer actually asked.
        representativeQuery: { type: String, required: true },
        queries: { type: [String], default: [] },
        queryCount: { type: Number, default: 0 },
        suggestedTitle: { type: String, default: "" },
        // Markdown headings the article should cover. A draft outline is the
        // difference between a task someone starts and a task someone reads.
        outline: { type: [String], default: [] },
        // How many below-threshold turns this cluster accounts for. The whole
        // ranking, because it is the only honest measure of which gap to close
        // first.
        estimatedImpact: { type: Number, default: 0 },
        // Set when someone clicks through to create the snippet, so the same
        // gap does not keep reappearing after it has been dealt with.
        resolvedAt: { type: Date, default: null },
        createdSourceId: { type: String, default: null },
        dismissedAt: { type: Date, default: null },
        computedAt: { type: Date, default: Date.now },
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

recommendationSchema.index({ orgId: 1, estimatedImpact: -1 });

module.exports = mongoose.model("Recommendation", recommendationSchema);
