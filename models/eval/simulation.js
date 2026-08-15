const mongoose = require("mongoose");
const { TurnOutcome, RunStatus, ConfigTarget } = require("../../config/enums");

// §3.2 — multi-turn behavioural tests.
//
// Strictly better than static Q&A pairs, and worth the extra machinery for one
// reason: most failures happen on turn two. A single-turn test cannot catch an
// agent that answers correctly and then contradicts itself when the customer
// pushes back, or one that loses a pronoun reference, or one that escalates on
// the first sign of frustration but not the third.
//
// The persona drives a model playing the customer. Criteria are natural
// language and judged by a second model — all must pass, because "mostly met
// the criteria" is not a test result.

const criterionResultSchema = new mongoose.Schema(
    {
        _id: false,
        criterion: { type: String, required: true },
        passed: { type: Boolean, default: false },
        reason: { type: String, default: "" },
    },
    { _id: false }
);

const simulationSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        simulationId: { type: String, required: true, unique: true },
        name: { type: String, required: true },
        description: { type: String, default: "" },
        persona: {
            // Blank means generate the opener from `details`, which is the
            // usual case: describing a frustrated customer is easier than
            // writing what one would say.
            openingMessage: { type: String, default: "" },
            details: { type: String, default: "" },
            identityVerified: { type: Boolean, default: false },
            attributes: { type: mongoose.Schema.Types.Mixed, default: {} },
        },
        criteria: { type: [String], default: [] },
        expectedOutcome: { type: String, enum: [...Object.values(TurnOutcome), null], default: null },
        // The five shipped scenarios are marked so they can be reset to their
        // original definition, and so "you have no simulations" never shows on
        // a workspace that has five.
        isBuiltIn: { type: Boolean, default: false },
        key: { type: String, default: null },
        lastRun: {
            runId: { type: String, default: null },
            status: { type: String, enum: [...Object.values(RunStatus), null], default: null },
            target: { type: String, enum: Object.values(ConfigTarget), default: ConfigTarget.LIVE },
            passed: { type: Boolean, default: null },
            actualOutcome: { type: String, default: null },
            perCriterion: { type: [criterionResultSchema], default: [] },
            // [{ role, content }] — the whole simulated exchange, so a failure
            // can be read rather than guessed at.
            transcript: { type: [{ _id: false, role: String, content: String }], default: [] },
            error: { type: String, default: null },
            ranAt: { type: Date, default: null },
        },
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

simulationSchema.index({ orgId: 1, key: 1 });

module.exports = mongoose.model("Simulation", simulationSchema);
