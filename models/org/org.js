const mongoose = require("mongoose");
const { EscalationMode } = require("../../config/enums");

const orgSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, unique: true },
        name: { type: String, required: true },
        website: { type: String, default: "" },
        ownerEmail: { type: String, required: true },
        publicKey: { type: String, required: true, unique: true },
        // AES-256-GCM encrypted at rest; used to sign widget identify() payloads
        widgetSecret: { type: String, required: true },
        secretRotatedAt: { type: Date, default: null },
        agent: {
            name: { type: String, default: "Zea" },
            greeting: { type: String, default: "Hi! How can I help?" },
            language: { type: String, default: "en" },
        },
        escalation: {
            mode: { type: String, enum: Object.values(EscalationMode), default: EscalationMode.INBOX },
            email: { type: String, default: "" },
        },
        widget: {
            position: { type: String, default: "bottom-right" },
            allowedOrigins: { type: [String], default: [] },
            // Appearance — applied by the messenger at bootstrap. accentColor is
            // the "action color" (launcher, user bubbles, primary buttons);
            // background picks the home hero preset; theme is light|dark|auto.
            // Default is match-system; orgs explicitly pin light or dark.
            theme: { type: String, enum: ["light", "dark", "auto"], default: "auto" },
            accentColor: { type: String, default: "" },
            background: { type: String, default: "aurora" },
            // Pre-computed by themeDerivation on save — the widget never does
            // color math. { light: {...tokens}, dark: {...tokens} }
            themeTokens: { type: mongoose.Schema.Types.Mixed, default: null },
            // Bumped on every widget-affecting settings change; lets clients
            // and CDNs cache config and bust cleanly on publish.
            configVersion: { type: Number, default: 1 },
            // Composable home screen: [{ id, type, enabled, order, config }].
            // null → the default section set.
            homeSections: { type: mongoose.Schema.Types.Mixed, default: null },
        },
        credits: {
            plan: { type: String, default: "FREE" },
            conversationsUsed: { type: Number, default: 0 },
            conversationsLimit: { type: Number, default: 500 },
        },
    },
    {
        timestamps: true,
        toJSON: {
            transform: (doc, ret) => {
                delete ret._id;
                delete ret.__v;
                delete ret.widgetSecret;
                return ret;
            },
        },
    }
);

module.exports = mongoose.model("Org", orgSchema);
