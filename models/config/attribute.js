const mongoose = require("mongoose");
const { conditionSchema, publishableFields, configToJson } = require("./shared");

// §2.3 — the Gate stage already classifies sentiment on every turn. This
// promotes that from one hardcoded enum into a configurable system, so a
// workspace can classify "Issue Type" or "Urgency" with the same machinery.
//
// The descriptions are not documentation: `description` is the classifier's
// instruction and each value's `description` is its few-shot definition. That is
// why the template in the PRD is two thousand characters — a value defined as
// "billing" classifies badly, and a value defined with examples, common
// questions and keywords classifies well.
const attributeValueSchema = new mongoose.Schema(
    {
        _id: false,
        name: { type: String, required: true },
        description: { type: String, default: "" },
    },
    { _id: false }
);

const attributeSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        attributeId: { type: String, required: true, unique: true },
        name: { type: String, required: true },
        description: { type: String, default: "" },
        values: { type: [attributeValueSchema], default: [] },
        // When to run detection at all. Empty → every conversation.
        conditions: { type: [conditionSchema], default: [] },
        // Sentiment shifts over a conversation; issue type rarely does. Only
        // re-run detection where it can actually change the answer.
        reDetectOnClose: { type: Boolean, default: false },
        // The agent may not mark a conversation resolved until this attribute
        // has a value — the mechanism behind "always tag why it escalated".
        requireToClose: { type: Boolean, default: false },
        visibleToTeams: { type: [String], default: [] },
        // Detecting a value can itself trigger an escalation, which is how
        // "Urgency = critical" reaches a human without a second rule restating
        // the same condition.
        escalationRuleIds: { type: [String], default: [] },
        // Pre-built attributes ship with the workspace and can be edited but
        // not deleted — removing "Sentiment" would silently break the analytics
        // that read it.
        isBuiltIn: { type: Boolean, default: false },
        // Stable key for the four built-ins, so code can find Sentiment without
        // matching on a display name the customer is free to rename.
        key: { type: String, default: null },
        ...publishableFields,
    },
    { timestamps: true, toJSON: configToJson }
);

attributeSchema.index({ orgId: 1, publishState: 1, enabled: 1 });
attributeSchema.index({ orgId: 1, key: 1 });

module.exports = mongoose.model("Attribute", attributeSchema);
