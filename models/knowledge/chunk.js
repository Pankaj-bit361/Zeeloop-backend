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

module.exports = mongoose.model("Chunk", chunkSchema);
