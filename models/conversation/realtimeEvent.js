const mongoose = require("mongoose");
const schema = new mongoose.Schema({
    emitter: { type: String, required: true },
    orgId: { type: String, required: true },
    conversationId: { type: String, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    expiresAt: { type: Date, required: true },
}, { timestamps: true });
schema.index({ orgId: 1, conversationId: 1, createdAt: 1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports = mongoose.model("RealtimeEvent", schema);
