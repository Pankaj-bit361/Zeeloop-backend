const mongoose = require("mongoose");
const { MemberRole, MemberStatus } = require("../../config/enums");

// A dashboard seat. Distinct from EndUser, who is a customer talking to the
// widget — a Member is someone who logs in and answers escalations.
const memberSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        memberId: { type: String, required: true, unique: true },
        email: { type: String, required: true },
        name: { type: String, default: "" },
        designation: { type: String, default: "" },
        role: { type: String, enum: Object.values(MemberRole), default: MemberRole.AGENT },
        status: { type: String, enum: Object.values(MemberStatus), default: MemberStatus.ACTIVE },
        lastActiveAt: { type: Date, default: null },
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

// One seat per email per org
memberSchema.index({ orgId: 1, email: 1 }, { unique: true });

// "Which orgs can this account open?" is a lookup by email alone, which the
// compound index above cannot serve — its leading field is orgId. Every sign-in
// runs this query, so it gets its own index.
memberSchema.index({ email: 1 });

module.exports = mongoose.model("Member", memberSchema);
