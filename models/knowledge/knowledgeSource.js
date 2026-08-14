const mongoose = require("mongoose");
const { SourceType, SourceStatus } = require("../../config/enums");

const knowledgeSourceSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        sourceId: { type: String, required: true, unique: true },
        type: { type: String, enum: Object.values(SourceType), required: true },
        name: { type: String, required: true },
        url: { type: String },
        content: { type: String }, // SNIPPET only
        status: { type: String, enum: Object.values(SourceStatus), default: SourceStatus.PENDING },
        // SITEMAP only: URLs the customer re-included in the review step after
        // the heuristics excluded them. Empty means "trust the heuristics".
        includedUrls: { type: [String], default: [] },
        // Per-source override for main-content extraction, for sites where
        // auto-detection picks the wrong container (§1.5).
        contentSelector: { type: String, default: "" },
        chunkCount: { type: Number, default: 0 },
        lastSyncedAt: { type: Date },
        lastError: { type: String },
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

module.exports = mongoose.model("KnowledgeSource", knowledgeSourceSchema);
