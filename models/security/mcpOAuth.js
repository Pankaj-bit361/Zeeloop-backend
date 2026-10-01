const mongoose = require("mongoose");
const client = new mongoose.Schema({
    clientId: { type: String, required: true, unique: true },
    name: { type: String, required: true }, redirectUris: { type: [String], required: true },
    secretHash: { type: String, select: false },
    orgId: { type: String, default: null, index: true },
    activeSlot: { type: Number, select: false },
    revokedAt: { type: Date, default: null },
    cleanupAt: { type: Date },
}, { timestamps: true });
client.index({ orgId: 1, activeSlot: 1 }, { unique: true, partialFilterExpression: { activeSlot: { $type: "number" } } });
client.index({ cleanupAt: 1 }, { expireAfterSeconds: 0 });
const request = new mongoose.Schema({
    requestId: { type: String, required: true, unique: true },
    clientId: { type: String, required: true }, clientName: { type: String, required: true },
    redirectUri: { type: String, required: true }, codeChallenge: { type: String, required: true },
    resource: { type: String, required: true }, state: String,
    accountId: { type: String, default: null }, sessionVersion: Number,
    expiresAt: { type: Date, required: true }, consumedAt: { type: Date, default: null },
}, { timestamps: true });
request.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// One connection owns its code and rotating access/refresh pair. Rotation and
// revocation mutate this one document atomically, so a revoked connection cannot
// be resurrected by an in-flight refresh on another API instance.
const grant = new mongoose.Schema({
    grantId: { type: String, required: true, unique: true },
    clientId: { type: String, required: true }, clientName: { type: String, required: true },
    orgId: { type: String, required: true, index: true }, accountId: { type: String, required: true },
    sessionVersion: { type: Number, required: true }, resource: { type: String, required: true },
    activeSlot: { type: Number, select: false },
    codeHash: { type: String, required: true, unique: true, select: false },
    codeChallenge: { type: String, required: true, select: false }, redirectUri: { type: String, required: true },
    codeExpiresAt: { type: Date, required: true }, codeUsedAt: { type: Date, default: null },
    accessHash: { type: String, select: false }, refreshHash: { type: String, select: false },
    usedRefreshHashes: { type: [String], default: [], select: false },
    accessExpiresAt: Date, refreshExpiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null }, lastUsedAt: { type: Date, default: null },
}, { timestamps: true });
for (const field of ["accessHash", "refreshHash"]) grant.index({ [field]: 1 }, { unique: true, partialFilterExpression: { [field]: { $type: "string" } } });
grant.index({ orgId: 1, activeSlot: 1 }, { unique: true, partialFilterExpression: { activeSlot: { $type: "number" } } });
grant.index({ refreshExpiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports = {
    McpClient: mongoose.model("McpClient", client),
    McpRequest: mongoose.model("McpRequest", request),
    McpGrant: mongoose.model("McpGrant", grant),
};
