const mongoose = require("mongoose");

const chunkSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        chunkId: { type: String, required: true, unique: true },
        sourceId: { type: String, required: true, index: true },
        text: { type: String, required: true },
        // Never returned by default — 1024 floats per chunk would drown every response
        embedding: { type: [Number], select: false },
        headingPath: { type: [String], default: [] },
        tokenCount: { type: Number, default: 0 },
        position: { type: Number, default: 0 },
        // §1.4 — which document within the source this chunk came from: the URL
        // for a crawled page, the filename for a file. Change detection deletes
        // and re-embeds by this key, so a re-sync only touches the pages that
        // actually changed.
        documentKey: { type: String, default: null, index: true },
    },
    {
        timestamps: true,
        toJSON: {
            transform: (doc, ret) => {
                delete ret._id;
                delete ret.__v;
                delete ret.embedding;
                return ret;
            },
        },
    }
);

chunkSchema.index({ orgId: 1, sourceId: 1 });

// Extends the index above rather than sitting beside it: (orgId, sourceId) is a
// prefix of this one, so this serves both. Rendering an article reads every
// chunk of a source in order, and sorting 6,000 of them in memory measured
// 30ms of pure CPU on a request that should touch an index and stop.
chunkSchema.index({ orgId: 1, sourceId: 1, position: 1 });

module.exports = mongoose.model("Chunk", chunkSchema);
