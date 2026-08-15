const mongoose = require("mongoose");
const {
    ConversationStatus,
    FeedbackRating,
    AttributeSource,
    ConversationChannel,
} = require("../../config/enums");

// §2.3 — one detected or overridden attribute value on a conversation.
// `source` is the point: a MANUAL value is both the correction and the training
// signal, and treating it identically to a model guess throws away the more
// valuable of the two.
const attributeValueSchema = new mongoose.Schema(
    {
        _id: false,
        attributeId: { type: String, required: true },
        // Denormalised so the inbox can render a column without a join per row.
        // The attribute's display name can change; this is a snapshot of what it
        // was called when the value was set.
        name: { type: String, default: "" },
        value: { type: String, default: null },
        source: { type: String, enum: Object.values(AttributeSource), default: AttributeSource.DETECTED },
        confidence: { type: Number, default: null },
        setBy: { type: String, default: null },
        setAt: { type: Date, default: Date.now },
    },
    { _id: false }
);

const conversationSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        conversationId: { type: String, required: true, unique: true },
        endUserId: { type: String, index: true },
        status: { type: String, enum: Object.values(ConversationStatus), default: ConversationStatus.OPEN },
        // §4.8 — which surface this conversation arrived on. Chat is the
        // default so every existing row keeps meaning what it meant.
        channel: {
            type: String,
            enum: Object.values(ConversationChannel),
            default: ConversationChannel.CHAT,
            index: true,
        },
        // Email threading. Set only on EMAIL conversations; the provider's
        // Message-ID chain is what keeps a reply attached to its thread.
        emailThread: {
            subject: { type: String, default: null },
            fromEmail: { type: String, default: null },
            messageIds: { type: [String], default: [] },
        },
        attributes: { type: [attributeValueSchema], default: [] },
        // §3.4 — model-graded quality, written by cron on 100% of conversations
        // rather than by the under-5% who click a thumb.
        quality: {
            score: { type: Number, default: null },
            reasonCategory: { type: String, default: null },
            reason: { type: String, default: null },
            gradedAt: { type: Date, default: null },
        },
        // Team inbox assignment (§5.7).
        assignedTo: { type: String, default: null, index: true },
        teamId: { type: String, default: null, index: true },
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
// §3.7 — the filtered inbox reads by channel and by attribute value.
conversationSchema.index({ orgId: 1, channel: 1, lastMessageAt: -1 });
conversationSchema.index({ orgId: 1, "attributes.attributeId": 1, "attributes.value": 1 });
// Email threading looks a conversation up by the Message-IDs already seen on it.
conversationSchema.index({ orgId: 1, "emailThread.messageIds": 1 });

module.exports = mongoose.model("Conversation", conversationSchema);
