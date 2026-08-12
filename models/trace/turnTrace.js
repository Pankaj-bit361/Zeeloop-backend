const mongoose = require("mongoose");
const { TurnOutcome } = require("../../config/enums");

// One document per pipeline run, written on EVERY turn including blocked and
// failed ones. It is the eval set, the content-gap source and the cost
// attribution source. It cannot be reconstructed later.
const turnTraceSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        traceId: { type: String, required: true, unique: true },
        conversationId: { type: String, required: true, index: true },
        turn: { type: Number, required: true },

        rawQuery: { type: String, required: true },
        rewrittenQuery: { type: String, default: null },

        gateIntent: { type: String },
        gateLanguage: { type: String },
        gateSentiment: { type: String },
        gateSafe: { type: Boolean, default: true },
        gateFailedOpen: { type: Boolean, default: false },

        candidateCount: { type: Number, default: 0 },
        topChunks: {
            type: [
                {
                    _id: false,
                    chunkId: { type: String },
                    vectorScore: { type: Number },
                    textScore: { type: Number },
                    rerankScore: { type: Number },
                },
            ],
            default: [],
        },
        belowThreshold: { type: Boolean, default: false },
        procedureId: { type: String, default: null },

        model: { type: String },
        inputTokens: { type: Number, default: 0 },
        outputTokens: { type: Number, default: 0 },
        iterations: { type: Number, default: 0 },

        grounded: { type: Boolean, default: null },
        answersQuery: { type: Boolean, default: null },
        unsupportedClaims: { type: [String], default: [] },

        outcome: { type: String, enum: Object.values(TurnOutcome), required: true },
        latencyMs: {
            gate: { type: Number, default: 0 },
            rewrite: { type: Number, default: 0 },
            retrieve: { type: Number, default: 0 },
            rerank: { type: Number, default: 0 },
            generate: { type: Number, default: 0 },
            validate: { type: Number, default: 0 },
        },
        costUsd: { type: Number, default: 0 },
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

turnTraceSchema.index({ orgId: 1, belowThreshold: 1, createdAt: -1 });

module.exports = mongoose.model("TurnTrace", turnTraceSchema);
