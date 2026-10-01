const mongoose = require("mongoose");

// Legacy credentials remain installation-only. Plaintext is never persisted.
const schema = new mongoose.Schema({
    tokenId: { type: String, required: true, unique: true },
    orgId: { type: String, required: true, index: true },
    accountId: { type: String, required: true },
    sessionVersion: { type: Number, required: true },
    activeSlot: { type: Number, min: 0, max: 19, select: false },
    tokenHash: { type: String, required: true, unique: true, select: false },
    preview: { type: String, required: true },
    name: { type: String, required: true },
    scope: { type: String, default: "zealoop:install" },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    lastUsedAt: { type: Date, default: null },
}, { timestamps: true });
// A count-then-insert check races across API instances. Twenty unique slots
// enforce workspace capacity in MongoDB; revoked/expired rows release theirs.
schema.index({ orgId: 1, activeSlot: 1 }, { unique: true, partialFilterExpression: { activeSlot: { $type: "number" } } });
module.exports = mongoose.model("InstallToken", schema);
