const mongoose = require("mongoose");
const { ApiScope, CredentialType, MemberRole, BlocklistType } = require("../../config/enums");

// The Phase 5 and §8 collections that are each too small to justify a file of
// their own. Grouped rather than scattered so the boilerplate is written once
// and so it is obvious these are peers.

function jsonTransform(alsoDelete = []) {
    return {
        transform: (doc, ret) => {
            delete ret._id;
            delete ret.__v;
            for (const field of alsoDelete) delete ret[field];
            return ret;
        },
    };
}

// §5.6 — customer-facing API keys, scoped.
//
// Only the HASH is stored. A key that can be read back out of the database is a
// key that leaks through any read path — and "show me my key again" is a feature
// worth refusing, because the alternative is storing a live credential in
// plaintext for the convenience of someone who lost theirs.
const apiKeySchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        apiKeyId: { type: String, required: true, unique: true },
        name: { type: String, required: true },
        // sha256 of the key. Indexed, because every authenticated request looks
        // a key up by it.
        keyHash: { type: String, required: true, index: true },
        // First and last few characters, for the list view. Enough to tell two
        // keys apart, not enough to use.
        keyPreview: { type: String, required: true },
        scopes: { type: [{ type: String, enum: Object.values(ApiScope) }], default: [] },
        // Per-key rate limit, per minute.
        rateLimitPerMinute: { type: Number, default: 60 },
        lastUsedAt: { type: Date, default: null },
        revokedAt: { type: Date, default: null },
        createdBy: { type: String, default: null },
    },
    { timestamps: true, toJSON: jsonTransform(["keyHash"]) }
);

// §5.3 — the credential store. Separate from the action definition so one API
// token is defined once and reused across ten actions, and rotated in one place
// rather than ten.
const credentialSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        credentialId: { type: String, required: true, unique: true },
        name: { type: String, required: true },
        type: { type: String, enum: Object.values(CredentialType), required: true },
        // AES-256-GCM encrypted. Never returned by any endpoint.
        secret: { type: String, required: true },
        // API_KEY_HEADER only: which header to put it in.
        headerName: { type: String, default: null },
        // BASIC only.
        username: { type: String, default: null },
        lastRotatedAt: { type: Date, default: null },
    },
    { timestamps: true, toJSON: jsonTransform(["secret"]) }
);

// §5.7 — team inboxes.
const teamSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        teamId: { type: String, required: true, unique: true },
        name: { type: String, required: true },
        description: { type: String, default: "" },
        // Member emails. Emails rather than member ids because membership is
        // already keyed by email everywhere else in this codebase, and mixing
        // the two is how a member who was removed and re-invited loses their
        // assignments.
        memberEmails: { type: [String], default: [] },
        // Auto-assignment by attribute: [{ attributeId, value }]. First match
        // wins, evaluated in order.
        assignmentRules: {
            type: [{ _id: false, attributeId: String, value: String }],
            default: [],
        },
    },
    { timestamps: true, toJSON: jsonTransform() }
);

// §5.8 — macros. Canned replies with variable substitution.
const macroSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        macroId: { type: String, required: true, unique: true },
        name: { type: String, required: true },
        // Keyboard trigger from the composer, e.g. "/refund".
        shortcut: { type: String, default: null },
        // `{first_name}`, `{agent_name}`, `{org_name}` are substituted on use.
        body: { type: String, required: true },
        // Which roles may use it. An empty list means everyone.
        visibleToRoles: { type: [{ type: String, enum: Object.values(MemberRole) }], default: [] },
        usageCount: { type: Number, default: 0 },
    },
    { timestamps: true, toJSON: jsonTransform() }
);

// §8.2 — identity and IP blocklist.
const blocklistEntrySchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        blocklistEntryId: { type: String, required: true, unique: true },
        type: { type: String, enum: Object.values(BlocklistType), required: true },
        // The email, IP, or domain. Lowercased on write so lookups are exact.
        value: { type: String, required: true },
        reason: { type: String, default: "" },
        createdBy: { type: String, default: null },
        // Null means permanent. A temporary block is often the right answer for
        // an abusive session that is probably one bad afternoon.
        expiresAt: { type: Date, default: null },
        hitCount: { type: Number, default: 0 },
    },
    { timestamps: true, toJSON: jsonTransform() }
);

// The widget's blocklist check runs on every message, so it reads exactly this.
blocklistEntrySchema.index({ orgId: 1, type: 1, value: 1 }, { unique: true });

// §8.5 — in-app changelog. Global rather than per workspace: it is our release
// notes, not theirs.
const changelogEntrySchema = new mongoose.Schema(
    {
        changelogEntryId: { type: String, required: true, unique: true },
        title: { type: String, required: true },
        body: { type: String, required: true },
        // "feature", "fix", "improvement" — kept as a free string because this
        // is content, and an enum here would mean a deploy to add a category.
        kind: { type: String, default: "feature" },
        publishedAt: { type: Date, default: Date.now, index: true },
    },
    { timestamps: true, toJSON: jsonTransform() }
);

module.exports = {
    ApiKey: mongoose.model("ApiKey", apiKeySchema),
    Credential: mongoose.model("Credential", credentialSchema),
    Team: mongoose.model("Team", teamSchema),
    Macro: mongoose.model("Macro", macroSchema),
    BlocklistEntry: mongoose.model("BlocklistEntry", blocklistEntrySchema),
    ChangelogEntry: mongoose.model("ChangelogEntry", changelogEntrySchema),
};
