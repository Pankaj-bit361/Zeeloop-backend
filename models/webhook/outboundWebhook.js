const mongoose = require("mongoose");
const { OutboundWebhookEvent } = require("../../config/enums");

// §5.6 — customer-facing webhooks. The mirror image of models/billing/webhookEvent:
// there we RECEIVE signed posts, here we SEND them, and the signing scheme is
// the same on purpose so the docs can describe one mechanism.
const outboundWebhookSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        outboundWebhookId: { type: String, required: true, unique: true },
        url: { type: String, required: true },
        events: {
            type: [{ type: String, enum: Object.values(OutboundWebhookEvent) }],
            default: [],
        },
        // Encrypted at rest. The customer sees it once at creation; after that
        // it can be rotated but never re-read, same as the widget secret.
        secret: { type: String, required: true },
        enabled: { type: Boolean, default: true },
        // Consecutive failures. A dead endpoint disables itself rather than
        // being retried forever — an integration someone deleted six months ago
        // should not still be generating traffic and error logs.
        failureCount: { type: Number, default: 0 },
        lastDeliveryAt: { type: Date, default: null },
        lastStatus: { type: Number, default: null },
        disabledReason: { type: String, default: null },
    },
    {
        timestamps: true,
        toJSON: {
            transform: (doc, ret) => {
                delete ret._id;
                delete ret.__v;
                delete ret.secret;
                return ret;
            },
        },
    }
);

module.exports = mongoose.model("OutboundWebhook", outboundWebhookSchema);
