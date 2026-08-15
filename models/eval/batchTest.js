const mongoose = require("mongoose");
const { EvalRating, RunStatus, ConfigTarget } = require("../../config/enums");

// §3.1 — a saved set of questions run against the agent, with per-question
// ratings kept across runs so a change can be compared to the last one.
//
// `lastAnswer` and `lastRating` live on the question rather than only in the run
// history because the thing a support manager actually does is open the list,
// read the answers, and mark the bad ones. That workflow needs the current
// answer beside the question, not two clicks away in a run record.

const questionSchema = new mongoose.Schema(
    {
        _id: false,
        // Stable across edits so ratings survive reordering the list.
        questionId: { type: String, required: true },
        text: { type: String, required: true },
        // What a good answer looks like, in prose. Not asserted automatically —
        // it is the rubric a human reads against, and the prompt the judge uses
        // when one is asked to pre-rate.
        expectedBehaviour: { type: String, default: "" },
        lastAnswer: { type: String, default: null },
        lastOutcome: { type: String, default: null },
        lastCitations: { type: Number, default: 0 },
        lastRating: { type: String, enum: Object.values(EvalRating), default: EvalRating.UNRATED },
        lastRunAt: { type: Date, default: null },
        // The answer from the run before this one. This single field is the
        // whole run-to-run diff feature: "which answers changed" is a
        // comparison, and keeping one generation of history makes it free.
        previousAnswer: { type: String, default: null },
    },
    { _id: false }
);

const runSchema = new mongoose.Schema(
    {
        _id: false,
        runId: { type: String, required: true },
        target: { type: String, enum: Object.values(ConfigTarget), default: ConfigTarget.LIVE },
        status: { type: String, enum: Object.values(RunStatus), default: RunStatus.QUEUED },
        startedAt: { type: Date, default: Date.now },
        finishedAt: { type: Date, default: null },
        passed: { type: Number, default: 0 },
        failed: { type: Number, default: 0 },
        unrated: { type: Number, default: 0 },
        changed: { type: Number, default: 0 },
        error: { type: String, default: null },
    },
    { _id: false }
);

const batchTestSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        batchTestId: { type: String, required: true, unique: true },
        name: { type: String, required: true },
        description: { type: String, default: "" },
        questions: { type: [questionSchema], default: [] },
        // Newest first, capped in batchTestFunctions. Full history would grow
        // without bound on a suite that runs on every deploy.
        runs: { type: [runSchema], default: [] },
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

module.exports = mongoose.model("BatchTest", batchTestSchema);
