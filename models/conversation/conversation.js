const mongoose = require("mongoose");
const { ConversationStatus, FeedbackRating } = require("../../config/enums");

const conversationSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        conversationId: { type: String, required: true, unique: true },
        endUserId: { type: String, index: true },
        status: { type: String, enum: Object.values(ConversationStatus), default: ConversationStatus.OPEN },
        // set by the resolution cron, never at write time
        isResolved: { type: Boolean, default: false },
        turnCount: { type: Number, default: 0 },
        totalCostUsd: { type: Number, default: 0 },
        lastMessageAt: { type: Date },
        lastMessagePreview: { type: String },
        hasHumanReply: { type: Boolean, default: false },
        feedback: { type: String, enum: [...Object.values(FeedbackRating), null], default: null },
        endedAt: { type: Date },
        // a human closed it from the inbox — deliberately separate from
        // isResolved, which only ever means "the agent resolved it alone"
        manuallyResolvedAt: { type: Date, default: null },
        // a write action proposed last turn, waiting on the user's yes
        pendingAction: {
            actionId: { type: String },
            args: { type: mongoose.Schema.Types.Mixed },
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

conversationSchema.index({ orgId: 1, status: 1, lastMessageAt: -1 });

module.exports = mongoose.model("Conversation", conversationSchema);
