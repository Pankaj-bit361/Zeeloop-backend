const mongoose = require("mongoose");
const { AccessType, TestStatus } = require("../../config/enums");

const paramSchema = new mongoose.Schema(
    {
        name: { type: String, required: true },
        description: { type: String },
        required: { type: Boolean, default: false },
    },
    { _id: false }
);

const actionSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        actionId: { type: String, required: true, unique: true },
        name: { type: String, required: true },
        description: { type: String, required: true },
        // required with no default: forcing the author to declare READ or WRITE is the point
        accessType: { type: String, enum: Object.values(AccessType), required: true },
        method: { type: String, default: "GET" },
        urlTemplate: { type: String, required: true },
        params: { type: [paramSchema], default: [] },
        headers: { type: mongoose.Schema.Types.Mixed, default: {} },
        // AES-256-GCM encrypted at rest
        secret: { type: String },
        enabled: { type: Boolean, default: false },
        requiresIdentity: { type: Boolean, default: true },
        requiresConfirmation: { type: Boolean, default: true },
        // null = never tested. Changing url/params/secret resets this to null.
        lastTestStatus: { type: String, enum: [...Object.values(TestStatus), null], default: null },
        lastTestedAt: { type: Date },
    },
    {
        timestamps: true,
        toJSON: {
            transform: (doc, ret) => {
                delete ret._id;
                delete ret.__v;
                delete ret.secret;
                return ret;
            },
        },
    }
);

module.exports = mongoose.model("Action", actionSchema);
