const mongoose = require("mongoose");
const { TokenPurpose } = require("../../config/enums");

// One-time links: password reset today, email verification when there is a mail
// provider to send it with. Consumption is a findOneAndUpdate filtered on
// `usedAt: null`, so two clicks on the same link race at the database and only
// one of them wins.
const authTokenSchema = new mongoose.Schema(
    {
        tokenId: { type: String, required: true, unique: true },
        accountId: { type: String, required: true, index: true },
        token: { type: String, required: true, unique: true },
        purpose: { type: String, enum: Object.values(TokenPurpose), required: true },
        expiresAt: { type: Date, required: true },
        usedAt: { type: Date, default: null },
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

// Mongo sweeps expired tokens itself — a spent reset link is worthless, and
// keeping them forever only grows a table nobody reads.
authTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("AuthToken", authTokenSchema);
