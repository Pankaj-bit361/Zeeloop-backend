const mongoose = require("mongoose");

// Every change Zealoop staff make from the admin panel: who, to which
// workspace or account, why, and what it was before. Kept apart from AuditLog,
// which is the customer's own log of their own team's changes.
const adminAuditSchema = new mongoose.Schema(
    {
        adminEmail: { type: String, required: true },
        action: { type: String, required: true },
        orgId: { type: String, default: null, index: true },
        accountId: { type: String, default: null, index: true },
        // What the row is about, for reading the log without a join.
        targetLabel: { type: String, default: "" },
        reason: { type: String, required: true },
        detail: { type: mongoose.Schema.Types.Mixed, default: {} },
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

adminAuditSchema.index({ createdAt: -1 });

module.exports = mongoose.model("AdminAudit", adminAuditSchema);
