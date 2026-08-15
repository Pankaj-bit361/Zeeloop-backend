const mongoose = require("mongoose");
const {
    EscalationMode,
    AnswerLength,
    LanguagePolicy,
    HeaderTextMode,
} = require("../../config/enums");

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
        // §8.4 — the previous secret stays valid for a grace window after a
        // rotation, so a customer can deploy their new backend signing code
        // without a gap where every identify() call fails. Cleared once expired.
        previousWidgetSecret: { type: String, default: null },
        previousSecretExpiresAt: { type: Date, default: null },
        agent: {
            name: { type: String, default: "Zea" },
            greeting: { type: String, default: "Hi! How can I help?" },
            language: { type: String, default: "en" },
            // §2.8 — identity and tone.
            avatarUrl: { type: String, default: "" },
            // "friendly" reads as first-person and contractions; "formal" does
            // not. Kept as a short string rather than an enum because it is
            // pasted into the prompt verbatim and the set is not load-bearing.
            formality: { type: String, enum: ["friendly", "neutral", "formal"], default: "friendly" },
            // Backed by a token ceiling as well as an instruction, so "concise"
            // actually shortens answers rather than politely requesting it.
            answerLength: { type: String, enum: Object.values(AnswerLength), default: AnswerLength.STANDARD },
            languagePolicy: { type: String, enum: Object.values(LanguagePolicy), default: LanguagePolicy.MATCH_USER },
            // Only read when languagePolicy is FIXED.
            fixedLanguage: { type: String, default: "en" },
        },
        // §2.7 — facts the agent may always state, kept out of the knowledge
        // index on purpose: these must be available on every turn, and anything
        // that has to be retrieved can fail to be retrieved.
        businessContext: {
            productOneLiner: { type: String, default: "" },
            pricingSummary: { type: String, default: "" },
            docsUrl: { type: String, default: "" },
            freeTierTerms: { type: String, default: "" },
            supportHours: { type: String, default: "" },
            // Open-ended extras: [{ label, value }].
            facts: {
                type: [{ _id: false, label: String, value: String }],
                default: [],
            },
        },
        escalation: {
            mode: { type: String, enum: Object.values(EscalationMode), default: EscalationMode.INBOX },
            email: { type: String, default: "" },
        },
        widget: {
            position: { type: String, default: "bottom-right" },
            allowedOrigins: { type: [String], default: [] },
            // §8.4 — when true, a request whose Origin is not in allowedOrigins
            // is refused. Off by default because turning it on for an existing
            // workspace with an empty list would take their widget down.
            enforceOriginAllowlist: { type: Boolean, default: false },
            // Appearance — applied by the messenger at bootstrap. accentColor is
            // the "action color" (launcher, user bubbles, primary buttons);
            // background picks the home hero preset; theme is light|dark|auto.
            // Default is match-system; orgs explicitly pin light or dark.
            theme: { type: String, enum: ["light", "dark", "auto"], default: "auto" },
            accentColor: { type: String, default: "" },
            background: { type: String, default: "aurora" },
            // §4.5 — AUTO computes header text from background luminance, which
            // is right for a solid colour and wrong for a gradient whose two
            // stops straddle the threshold. Those need a manual choice.
            headerTextMode: { type: String, enum: Object.values(HeaderTextMode), default: HeaderTextMode.AUTO },
            // Pre-computed by themeDerivation on save — the widget never does
            // color math. { light: {...tokens}, dark: {...tokens} }
            themeTokens: { type: mongoose.Schema.Types.Mixed, default: null },
            // Bumped on every widget-affecting settings change; lets clients
            // and CDNs cache config and bust cleanly on publish.
            configVersion: { type: Number, default: 1 },
            // Composable home screen: [{ id, type, enabled, order, config }].
            // null → the default section set.
            homeSections: { type: mongoose.Schema.Types.Mixed, default: null },
            // §4.2 — separate copy for visitors we know and visitors we don't.
            // `{first_name}` is substituted server-side; the dashboard renders
            // it as a chip so nobody has to learn a template syntax.
            welcome: {
                anonymous: { type: String, default: "" },
                identified: { type: String, default: "" },
            },
            // §4.3 — launcher visibility. Precedence is documented in
            // widgetConfigFunctions and enforced in one place.
            launcher: {
                showToVisitors: { type: Boolean, default: true },
                showToIdentified: { type: Boolean, default: true },
                // Glob-ish patterns matched against the page URL. Include wins
                // nothing on its own — an empty include list means "everywhere".
                urlInclude: { type: [String], default: [] },
                urlExclude: { type: [String], default: [] },
                segmentIds: { type: [String], default: [] },
            },
        },
        // §1.8 — the Get Started card. Steps themselves are derived from real
        // data every time; only the dismissal is stored, because a checklist
        // that lies about progress is worse than none.
        onboarding: {
            dismissed: { type: Boolean, default: false },
            wizardCompletedAt: { type: Date, default: null },
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
                delete ret.previousWidgetSecret;
                return ret;
            },
        },
    }
);

module.exports = mongoose.model("Org", orgSchema);
