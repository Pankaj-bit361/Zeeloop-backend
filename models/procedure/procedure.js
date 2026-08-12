const mongoose = require("mongoose");

const procedureSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        procedureId: { type: String, required: true, unique: true },
        name: { type: String, required: true },
        description: { type: String },
        // triggers: any keyword match loads the procedure into the prompt
        keywords: { type: [String], default: [] },
        // ordered steps the model must follow — an SOP, not a suggestion
        steps: { type: [String], default: [] },
        enabled: { type: Boolean, default: true },
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

module.exports = mongoose.model("Procedure", procedureSchema);
