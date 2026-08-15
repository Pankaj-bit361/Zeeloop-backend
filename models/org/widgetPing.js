const mongoose = require("mongoose");

// §1.6 step 5 — install verification.
//
// One row per (workspace, origin), upserted on every widget bootstrap. This is
// the evidence behind "we can see your widget", and it is deliberately evidence
// rather than a checkbox: the failure this catches is a snippet pasted into the
// wrong template, where the customer is certain they installed it and nothing
// is running.
//
// The origin doubles as the answer to "which of your sites is this on", which is
// what someone needs when the widget appears on staging and not on production.
const widgetPingSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        // The Origin header of the bootstrapping page. Null for direct hits and
        // for our own demo pages.
        origin: { type: String, default: null },
        firstSeenAt: { type: Date, default: Date.now },
        lastSeenAt: { type: Date, default: Date.now },
        // Upserted rather than one row per load — a busy site would otherwise
        // write a row per page view forever.
        hits: { type: Number, default: 1 },
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

widgetPingSchema.index({ orgId: 1, origin: 1 }, { unique: true });

module.exports = mongoose.model("WidgetPing", widgetPingSchema);
