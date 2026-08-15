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

        // §1.2 — FILE sources. The extracted text is stored so a re-sync does
        // not need the original upload, and so a per-file re-upload REPLACES
        // rather than appending a second copy of the same manual.
        file: {
            filename: { type: String, default: null },
            mimeType: { type: String, default: null },
            bytes: { type: Number, default: 0 },
            // "full" or "partial" — see fileFunctions. Surfaced in the UI so a
            // badly-extracted PDF is visible rather than merely retrieving
            // poorly.
            extractionQuality: { type: String, default: null },
        },

        // §1.4 — content hash per document, keyed by URL. A page whose hash is
        // unchanged skips embedding entirely, which is the difference between a
        // daily re-sync costing one embedding call and costing four hundred.
        documentHashes: { type: mongoose.Schema.Types.Mixed, default: {} },

        // §1.4 — how often to re-sync. MANUAL is the default: a schedule nobody
        // asked for is a bill nobody expected.
        syncSchedule: { type: String, enum: ["MANUAL", "DAILY", "WEEKLY"], default: "MANUAL" },
        nextSyncAt: { type: Date, default: null },

        // §1.4 — the diff from the last sync, so "what changed" is answerable
        // without comparing two crawls by hand.
        lastDiff: {
            added: { type: Number, default: 0 },
            updated: { type: Number, default: 0 },
            removed: { type: Number, default: 0 },
            unchanged: { type: Number, default: 0 },
        },
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

// The sources list, newest first — the first thing Knowledge renders.
knowledgeSourceSchema.index({ orgId: 1, createdAt: -1 });

/* The re-sync cron sweeps every tenant looking for sources that are due.
   Compound rather than partial: the cron matches `syncSchedule: {$in: [DAILY,
   WEEKLY]}`, and a partialFilterExpression cannot express `$in` — Mongo allows
   only $eq/$exists/$gt/$gte/$lt/$lte/$type/$and there. Leading on syncSchedule
   means the scan visits only the two scheduled values, and nextSyncAt supplies
   the range within each. */
knowledgeSourceSchema.index({ syncSchedule: 1, nextSyncAt: 1 });

module.exports = mongoose.model("KnowledgeSource", knowledgeSourceSchema);
