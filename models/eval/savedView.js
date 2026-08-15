const mongoose = require("mongoose");

// §3.7 — a named set of inbox filters. Small feature, disproportionate effect:
// the filters that matter to a workspace are the same three every day, and
// re-selecting them each morning is the reason people stop using filters.
const savedViewSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        savedViewId: { type: String, required: true, unique: true },
        name: { type: String, required: true },
        // The query object as conversationSearchFunctions accepts it. Mixed
        // because the filter set grows, and a schema here would mean a migration
        // every time a new filter is added.
        filters: { type: mongoose.Schema.Types.Mixed, default: {} },
        // Views are per workspace, not per person: "escalated and unresolved" is
        // the team's view of the queue, and a private-by-default version means
        // three people each build it separately.
        createdBy: { type: String, default: null },
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

savedViewSchema.index({ orgId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model("SavedView", savedViewSchema);
