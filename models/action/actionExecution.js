const mongoose = require("mongoose");
const { ExecutionStatus, BlockReason } = require("../../config/enums");

const actionExecutionSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        executionId: { type: String, required: true, unique: true },
        actionId: { type: String, required: true, index: true },
        conversationId: { type: String, index: true },
        endUserId: { type: String },
        status: { type: String, enum: Object.values(ExecutionStatus), required: true },
        blockReason: { type: String, enum: [...Object.values(BlockReason), null], default: null },
        request: {
            method: { type: String },
            url: { type: String },
            args: { type: mongoose.Schema.Types.Mixed },
        },
        response: {
            status: { type: Number },
            body: { type: mongoose.Schema.Types.Mixed },
            durationMs: { type: Number },
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

module.exports = mongoose.model("ActionExecution", actionExecutionSchema);
