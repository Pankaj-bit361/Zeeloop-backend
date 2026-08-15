const mongoose = require("mongoose");
const { ConditionOperator, ConditionField, Channel, PublishState } = require("../../config/enums");

// Sub-schemas shared by every configuration object (§2). Defined once because
// audience, channels, draft state and attribution counters mean the same thing
// on a guidance rule as they do on an escalation rule — and because a segment
// referenced from five places must be evaluated by one evaluator, not five.

// `_id: false` throughout: these are value objects. Mongo minting an ObjectId
// for every condition makes diffs between versions noisy for no benefit.

const conditionSchema = new mongoose.Schema(
    {
        _id: false,
        field: { type: String, enum: Object.values(ConditionField), required: true },
        operator: { type: String, enum: Object.values(ConditionOperator), required: true },
        // Mixed because a condition can compare against a string, a number, a
        // boolean or a list depending on the field and operator.
        value: { type: mongoose.Schema.Types.Mixed, default: null },
        // Only meaningful for ATTRIBUTE and TABLE_VALUE, which need to say
        // *which* attribute or column. Ignored for every other field.
        key: { type: String, default: null },
    },
    { _id: false }
);

// "everyone" is the default and by far the common case. A segment reference is
// resolved at evaluation time rather than denormalised, so editing a segment
// takes effect everywhere it is used without a backfill.
const audienceSchema = new mongoose.Schema(
    {
        _id: false,
        type: { type: String, enum: ["everyone", "segment"], default: "everyone" },
        segmentId: { type: String, default: null },
    },
    { _id: false }
);

// Computed by cron from TurnTrace, never incremented at write time (§2.5).
// Incrementing on the hot path would make every turn a write to every rule that
// applied to it, and would double-count on retries.
const statsSchema = new mongoose.Schema(
    {
        _id: false,
        used: { type: Number, default: 0 },
        resolved: { type: Number, default: 0 },
        escalated: { type: Number, default: 0 },
        computedAt: { type: Date, default: null },
    },
    { _id: false }
);

// Mixed into every config schema. `publishState` is what keeps a draft out of
// production; `enabled` is a separate switch so a live rule can be paused
// without being un-published, which is what "Save" and "Enable" being separate
// actions actually means (§2.4).
const publishableFields = {
    publishState: { type: String, enum: Object.values(PublishState), default: PublishState.DRAFT, index: true },
    enabled: { type: Boolean, default: false },
    // Empty means every channel. An empty list reading as "nowhere" would make
    // every object created before the email channel existed silently stop
    // working the day it shipped.
    channels: { type: [{ type: String, enum: Object.values(Channel) }], default: [] },
    audience: { type: audienceSchema, default: () => ({ type: "everyone" }) },
    stats: { type: statsSchema, default: () => ({}) },
    // Bumped on every save. The version log stores the previous body, so this
    // number and the log agree on what "v4" means.
    version: { type: Number, default: 1 },
    updatedBy: { type: String, default: null },
};

// Every config collection strips these the same way.
const configToJson = {
    transform: (doc, ret) => {
        delete ret._id;
        delete ret.__v;
        return ret;
    },
};

module.exports = { conditionSchema, audienceSchema, statsSchema, publishableFields, configToJson };
