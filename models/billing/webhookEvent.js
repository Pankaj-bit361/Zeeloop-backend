const mongoose = require("mongoose");

// The idempotency ledger (§0.1). Every provider retries, and several deliver at
// least once by design, so the same event id will arrive more than once. The
// unique index is the entire mechanism: the handler inserts first and treats a
// duplicate-key error as "already processed", which is atomic in a way that
// find-then-insert is not.
const webhookEventSchema = new mongoose.Schema(
    {
        webhookEventId: { type: String, required: true, unique: true },
        provider: { type: String, required: true },
        // The provider's own event id. Unique per provider, hence the compound
        // index rather than a bare unique on this field.
        providerEventId: { type: String, required: true },
        eventType: { type: String, required: true },
        orgId: { type: String, default: null, index: true },

        // Kept for replay and for answering "what did they actually send us"
        // when a subscription ends up in a state nobody expected.
        payload: { type: mongoose.Schema.Types.Mixed, default: null },

        processedAt: { type: Date, default: null },
        failedAt: { type: Date, default: null },
        error: { type: String, default: null },
        attempts: { type: Number, default: 0 },
    },
    {
        timestamps: true,
        toJSON: {
            transform: (doc, ret) => {
                delete ret._id;
                delete ret.__v;
                delete ret.payload;
                return ret;
            },
        },
    }
);

webhookEventSchema.index({ provider: 1, providerEventId: 1 }, { unique: true });

module.exports = mongoose.model("WebhookEvent", webhookEventSchema);
