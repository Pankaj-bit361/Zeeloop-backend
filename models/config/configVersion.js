const mongoose = require("mongoose");
const { ConfigObjectType } = require("../../config/enums");
const { configToJson } = require("./shared");

// §2.5 — version history and restore, one collection for every config type.
//
// Written on every save, holding the state BEFORE the edit. Storing the prior
// body rather than the new one means restoring version N is a single write of
// `snapshot`, with no need to replay a chain of diffs — and it means the very
// first save produces a row you can get back to, which a store-the-new-value
// design does not.
const configVersionSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        versionId: { type: String, required: true, unique: true },
        objectType: { type: String, enum: Object.values(ConfigObjectType), required: true },
        // The prefixed id of the versioned object, whatever collection it is in.
        objectId: { type: String, required: true },
        version: { type: Number, required: true },
        // Full document as it was, minus mongo internals. Mixed because it spans
        // ten different shapes and validating each here would duplicate every
        // schema in the project.
        snapshot: { type: mongoose.Schema.Types.Mixed, required: true },
        changedBy: { type: String, default: null },
        // "restored from v3", "published", "renamed" — a one-line reason so the
        // history list reads as a story rather than a stack of timestamps.
        note: { type: String, default: "" },
    },
    { timestamps: true, toJSON: configToJson }
);

// The history panel's exact query.
configVersionSchema.index({ orgId: 1, objectType: 1, objectId: 1, version: -1 });

module.exports = mongoose.model("ConfigVersion", configVersionSchema);
