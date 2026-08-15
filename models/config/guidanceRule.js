const mongoose = require("mongoose");
const { GuidanceCategory } = require("../../config/enums");
const { publishableFields, configToJson } = require("./shared");

// §2.1 — the agent's behaviour as editable objects instead of one prompt field.
//
// The category is not cosmetic. Enabled rules compose into the system prompt
// grouped by category, and a model given "Communication style: be concise" next
// to "Content and sources: never quote a price that isn't in the docs" follows
// both more reliably than one handed a flat list of sentences.
const guidanceRuleSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        guidanceRuleId: { type: String, required: true, unique: true },
        category: { type: String, enum: Object.values(GuidanceCategory), required: true },
        title: { type: String, required: true },
        // What actually reaches the model. The title is for the dashboard list.
        body: { type: String, required: true },
        ...publishableFields,
    },
    { timestamps: true, toJSON: configToJson }
);

// The prompt builder's exact query: this org's live, enabled rules.
guidanceRuleSchema.index({ orgId: 1, publishState: 1, enabled: 1 });

module.exports = mongoose.model("GuidanceRule", guidanceRuleSchema);
