const mongoose = require("mongoose");
const { AuditAction } = require("../../config/enums");

// §8.4 — who changed what, when. Append-only: there is no update path and no
// delete path in auditFunctions, because an audit log an admin can edit answers
// no question worth asking.
//
// Retention purge does not touch this collection either. A conversation from
// eleven months ago is data; "who removed the owner's access last March" is
// evidence.
const auditLogSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        auditLogId: { type: String, required: true, unique: true },
        action: { type: String, enum: Object.values(AuditAction), required: true },
        // The signed-in human, by email. Null for system-initiated changes such
        // as a provider webhook downgrading a plan.
        actorEmail: { type: String, default: null },
        targetType: { type: String, default: null },
        targetId: { type: String, default: null },
        // Small, structured, and never the whole document — an audit row that
        // carries a full snapshot becomes its own PII problem.
        detail: { type: mongoose.Schema.Types.Mixed, default: {} },
        ip: { type: String, default: null },
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

auditLogSchema.index({ orgId: 1, createdAt: -1 });
auditLogSchema.index({ orgId: 1, action: 1, createdAt: -1 });

module.exports = mongoose.model("AuditLog", auditLogSchema);
