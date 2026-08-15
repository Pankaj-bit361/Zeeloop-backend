const mongoose = require("mongoose");
const { ProcedureStepType, ProcedureTriggerType } = require("../../config/enums");
const { conditionSchema, statsSchema } = require("../config/shared");

// §5.4 — procedures v2. A step is one of three things:
//
//   INSTRUCTION  plain text the model must follow, as before
//   BRANCH       an IF on a condition, with steps on each side
//   TOOL         an action the model must call at this point
//
// `text` stays on every step type so the v1 documents — a flat array of strings
// — keep working: they are read back as INSTRUCTION steps with `text` set, which
// is what they always were.
const procedureStepSchema = new mongoose.Schema(
    {
        _id: false,
        type: { type: String, enum: Object.values(ProcedureStepType), default: ProcedureStepType.INSTRUCTION },
        text: { type: String, default: "" },
        // TOOL steps: which action, and whether the procedure may continue if
        // the call fails.
        actionId: { type: String, default: null },
        continueOnFailure: { type: Boolean, default: false },
        // BRANCH steps. Nested one level only — a branch inside a branch is a
        // workflow builder, which is an explicit non-goal.
        conditions: { type: [conditionSchema], default: [] },
        thenSteps: { type: [String], default: [] },
        elseSteps: { type: [String], default: [] },
    },
    { _id: false }
);

const procedureSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        procedureId: { type: String, required: true, unique: true },
        name: { type: String, required: true },
        description: { type: String },
        // §5.4 — how this procedure gets loaded. KEYWORD is the v1 behaviour and
        // stays the default so nothing existing changes meaning.
        triggerType: {
            type: String,
            enum: Object.values(ProcedureTriggerType),
            default: ProcedureTriggerType.KEYWORD,
        },
        // triggers: any keyword match loads the procedure into the prompt
        keywords: { type: [String], default: [] },
        // INTENT triggering — a natural-language description of when this
        // procedure applies, matched by the classifier rather than by substring.
        // Catches "I want my money back" for a refund procedure keyed on
        // "refund", which is the case keywords always miss.
        intentDescription: { type: String, default: "" },
        // EVENT triggering — a named event posted by the customer's site or by
        // an agent from the inbox.
        eventName: { type: String, default: null },
        // ordered steps the model must follow — an SOP, not a suggestion.
        // Legacy string arrays are migrated on read; see procedureFunctions.
        steps: { type: [mongoose.Schema.Types.Mixed], default: [] },
        enabled: { type: Boolean, default: true },
        // §2.5 — computed by cron from TurnTrace.
        stats: { type: statsSchema, default: () => ({}) },
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

procedureSchema.index({ orgId: 1, enabled: 1, triggerType: 1 });

module.exports = mongoose.model("Procedure", procedureSchema);
module.exports.procedureStepSchema = procedureStepSchema;
