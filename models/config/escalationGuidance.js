const mongoose = require("mongoose");
const { publishableFields, configToJson } = require("./shared");

// §2.2, probabilistic half. Natural language injected into the prompt for the
// long tail no condition list can express — "escalate when the customer sounds
// like they are about to churn" is real, common, and not a comparison operator.
const escalationGuidanceSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        escalationGuidanceId: { type: String, required: true, unique: true },
        title: { type: String, required: true },
        body: { type: String, required: true },
        ...publishableFields,
    },
    { timestamps: true, toJSON: configToJson }
);

escalationGuidanceSchema.index({ orgId: 1, publishState: 1, enabled: 1 });

module.exports = mongoose.model("EscalationGuidance", escalationGuidanceSchema);
