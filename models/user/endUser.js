const mongoose = require("mongoose");

const endUserSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        endUserId: { type: String, required: true, unique: true },
        externalId: { type: String },
        email: { type: String },
        name: { type: String },
        // true only when the identify() payload carried a valid HMAC signature
        verified: { type: Boolean, default: false },
        lastSeenAt: { type: Date },
        // Segment conditions read these (§2.6). Denormalised counters rather
        // than a countDocuments per segment per turn, which is the difference
        // between one query and one query per rule.
        firstSeenAt: { type: Date, default: Date.now },
        conversationCount: { type: Number, default: 0 },
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

endUserSchema.index({ orgId: 1, email: 1 });

module.exports = mongoose.model("EndUser", endUserSchema);
