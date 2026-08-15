const mongoose = require("mongoose");
const { EmailKind } = require("../../config/enums");

// One row per transactional send. This exists for the same reason the webhook
// event log does: "send the day-7 trial notice" runs on a cron, and a cron that
// runs twice — a retry, an overlapping deploy, two instances — must not send
// two emails.
//
// The unique index IS the idempotency mechanism. Insert first and let the
// duplicate-key error tell you it was already sent; a find-then-insert has a
// window between the two where a second worker sees nothing and also sends.
const emailLogSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        emailLogId: { type: String, required: true, unique: true },
        kind: { type: String, enum: Object.values(EmailKind), required: true },
        to: { type: String, required: true },
        subject: { type: String, default: "" },
        // What makes this send unique. For a trial notice it is the org and the
        // kind; for an escalation notice it is the conversation, because a
        // second escalation on a different thread is a different email.
        dedupeKey: { type: String, required: true },
        // false when no provider is configured — the body is still logged, so a
        // workspace without sending credentials can see what WOULD have gone
        // out rather than silently losing it.
        delivered: { type: Boolean, default: false },
        providerMessageId: { type: String, default: null },
        error: { type: String, default: null },
        body: { type: String, default: "" },
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

emailLogSchema.index({ dedupeKey: 1 }, { unique: true });
emailLogSchema.index({ orgId: 1, createdAt: -1 });

module.exports = mongoose.model("EmailLog", emailLogSchema);
