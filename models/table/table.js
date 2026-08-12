const mongoose = require("mongoose");

const columnSchema = new mongoose.Schema(
    {
        name: { type: String, required: true },
        type: { type: String, default: "string" },
        // exactly one column per table carries the identity key (e.g. email)
        isIdentityKey: { type: Boolean, default: false },
    },
    { _id: false }
);

const tableSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        tableId: { type: String, required: true, unique: true },
        name: { type: String, required: true },
        description: { type: String },
        columns: { type: [columnSchema], default: [] },
        rowCount: { type: Number, default: 0 },
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

module.exports = mongoose.model("Table", tableSchema);
