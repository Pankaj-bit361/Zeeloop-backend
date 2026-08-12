const mongoose = require("mongoose");
const { AuthProvider } = require("../../config/enums");

// A person who signs in to the dashboard.
//
// Deliberately the one model with no orgId: a human can hold seats in several
// orgs, and Member is the join that carries the role. Membership is resolved by
// this account's verified email, which is why the email is the unique key and
// why OAuth addresses are only trusted once the provider says they are verified.
//
// Distinct from EndUser (the customer talking to the widget) and from Member
// (the seat inside one org). Three different things that all look like "a user".
const accountSchema = new mongoose.Schema(
    {
        accountId: { type: String, required: true, unique: true },
        email: { type: String, required: true, unique: true, lowercase: true, trim: true },
        name: { type: String, default: "" },
        // scrypt$salt$hash. Null on accounts that have only ever used OAuth.
        passwordHash: { type: String, default: null },
        // Null means "never chose a password", which is what lets an
        // OAuth-provisioned account be claimed later by a password signup for
        // the same address instead of bouncing with "already exists".
        passwordSetAt: { type: Date, default: null },
        emailVerifiedAt: { type: Date, default: null },
        providers: { type: [String], enum: Object.values(AuthProvider), default: [] },
        lastLoginAt: { type: Date, default: null },
    },
    {
        timestamps: true,
        toJSON: {
            transform: (doc, ret) => {
                delete ret._id;
                delete ret.__v;
                // Never leaves the process, even by accident.
                delete ret.passwordHash;
                return ret;
            },
        },
    }
);

module.exports = mongoose.model("Account", accountSchema);
