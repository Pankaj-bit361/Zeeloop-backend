const mongoose = require("mongoose");

const tableRowSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        rowId: { type: String, required: true, unique: true },
        tableId: { type: String, required: true, index: true },
        // value of the table's identity-key column, used to match a verified end user
        identityValue: { type: String, required: true },
        data: { type: mongoose.Schema.Types.Mixed, default: {} },
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

tableRowSchema.index({ orgId: 1, tableId: 1, identityValue: 1 });

module.exports = mongoose.model("TableRow", tableRowSchema);
