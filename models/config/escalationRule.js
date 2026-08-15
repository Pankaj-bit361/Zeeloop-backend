const mongoose = require("mongoose");
const { EscalationMode } = require("../../config/enums");
const { conditionSchema, publishableFields, configToJson } = require("./shared");

// §2.2, deterministic half. Conditions are evaluated in code before generation,
// so "escalate after three failed attempts" is auditable: it either matched or
// it did not, and the trace records which rule fired.
//
// The probabilistic half lives in escalationGuidance.js. They are deliberately
// separate models rather than one with a mode flag — a support manager reading
// "why did this escalate" needs to know whether the answer is "a rule said so"
// or "the model judged so", and a shared collection blurs exactly that.
const escalationRuleSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        escalationRuleId: { type: String, required: true, unique: true },
        title: { type: String, required: true },
        // ALL conditions must match. An "any" mode was considered and left out:
        // two rules express it, and one rule that sometimes fires for reasons
        // the reader has to re-derive is worse than two obvious ones.
        conditions: { type: [conditionSchema], default: [] },
        // Where this particular escalation lands, when it should not follow the
        // workspace default. null → org.escalation.
        target: {
            mode: { type: String, enum: Object.values(EscalationMode), default: null },
            // A member email, or a team inbox id.
            memberEmail: { type: String, default: null },
            teamId: { type: String, default: null },
        },
        ...publishableFields,
    },
    { timestamps: true, toJSON: configToJson }
);

escalationRuleSchema.index({ orgId: 1, publishState: 1, enabled: 1 });

module.exports = mongoose.model("EscalationRule", escalationRuleSchema);
