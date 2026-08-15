const mongoose = require("mongoose");
const { conditionSchema, configToJson } = require("./shared");

// §2.6 — build once, reference everywhere. Guidance, escalation, attributes,
// actions and widget config all point at a segment rather than each carrying
// their own copy of "logged-in customers on a paid plan".
//
// This one is worth building before it is obviously needed: retrofitting
// audiences later means a migration across every config collection at once.
//
// Segments are not publishable. A segment is a definition, not behaviour — the
// draft/live decision belongs to the object that references it, and having both
// means asking "is this a draft rule pointing at a live segment?" forever.
const segmentSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        segmentId: { type: String, required: true, unique: true },
        name: { type: String, required: true },
        description: { type: String, default: "" },
        conditions: { type: [conditionSchema], default: [] },
    },
    { timestamps: true, toJSON: configToJson }
);

module.exports = mongoose.model("Segment", segmentSchema);
