const mongoose = require("mongoose");

// §5.1 — Copilot. The agent-facing panel in the conversation detail view.
//
// Its own thread, deliberately separate from the customer conversation. The
// support agent asking "what's our refund policy for annual plans" must not
// appear in the customer's transcript, and a shared thread makes that one
// mistaken keystroke away.
//
// Same retrieval, same knowledge, plus internal-only sources — which is the
// whole reason Copilot is the cheapest second product available: about ninety
// percent of the infrastructure already exists.
const copilotMessageSchema = new mongoose.Schema(
    {
        _id: false,
        role: { type: String, enum: ["USER", "ASSISTANT"], required: true },
        content: { type: String, required: true },
        // Numbered inline citations, so the answer can say "[1]" and the panel
        // can list what [1] was.
        citations: {
            type: [{ _id: false, index: Number, chunkId: String, sourceId: String, heading: String }],
            default: [],
        },
        createdAt: { type: Date, default: Date.now },
    },
    { _id: false }
);

const copilotThreadSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        copilotThreadId: { type: String, required: true, unique: true },
        // The customer conversation this panel is attached to. Null for a
        // free-standing Ask Copilot from the command palette.
        conversationId: { type: String, default: null, index: true },
        // Whose panel. Copilot threads are per agent, not per conversation —
        // two people looking at the same ticket each have their own.
        memberEmail: { type: String, required: true },
        messages: { type: [copilotMessageSchema], default: [] },
        totalCostUsd: { type: Number, default: 0 },
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

copilotThreadSchema.index({ orgId: 1, conversationId: 1, memberEmail: 1 });

module.exports = mongoose.model("CopilotThread", copilotThreadSchema);
