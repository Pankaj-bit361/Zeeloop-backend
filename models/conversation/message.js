const mongoose = require("mongoose");
const { MessageRole, ToolCallStatus } = require("../../config/enums");

const citationSchema = new mongoose.Schema(
    {
        chunkId: { type: String },
        sourceId: { type: String },
        heading: { type: String },
    },
    { _id: false }
);

const toolCallSchema = new mongoose.Schema(
    {
        actionId: { type: String },
        actionName: { type: String },
        args: { type: mongoose.Schema.Types.Mixed },
        status: { type: String, enum: Object.values(ToolCallStatus) },
        executionId: { type: String },
    },
    { _id: false }
);

// The Answer Receipt: the proof trail behind a verified answer, shown to the
// end user in the widget. Only ANSWERED turns that passed validation carry one.
const receiptSchema = new mongoose.Schema(
    {
        searched: { type: Number },
        read: { type: [String], default: [] },
        grounded: { type: Boolean },
        answersQuery: { type: Boolean },
        tookMs: { type: Number },
    },
    { _id: false }
);

const messageSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        messageId: { type: String, required: true, unique: true },
        conversationId: { type: String, required: true, index: true },
        role: { type: String, enum: Object.values(MessageRole), required: true },
        content: { type: String, required: true },
        citations: { type: [citationSchema], default: [] },
        toolCalls: { type: [toolCallSchema], default: [] },
        receipt: { type: receiptSchema, default: null },
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

messageSchema.index({ orgId: 1, conversationId: 1, createdAt: 1 });

module.exports = mongoose.model("Message", messageSchema);
