const mongoose = require("mongoose");
const schema = new mongoose.Schema({
    orgId: { type: String, required: true },
    kind: { type: String, required: true },
    resourceId: { type: String, required: true },
    parentId: String,
    name: String,
    createdBy: { type: String, required: true },
}, { timestamps: true });
schema.index({ orgId: 1, kind: 1, resourceId: 1 }, { unique: true });
module.exports = mongoose.model("McpArtifact", schema);
