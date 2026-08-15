const { ConfigObjectType, GuidanceCategory, IdPrefix, EscalationMode } = require("../../config/enums");
const GuidanceRule = require("../../models/config/guidanceRule");
const EscalationRule = require("../../models/config/escalationRule");
const EscalationGuidance = require("../../models/config/escalationGuidance");
const Attribute = require("../../models/config/attribute");
const conditionFunctions = require("./conditionFunctions");

// One registry, so CRUD, draft/live, version history and restore are written
// ONCE instead of five times (§2.1–§2.5). Adding a sixth configurable object
// means adding an entry here, not another near-identical functions file and
// another near-identical route file.
//
// Each entry declares what varies between the types and nothing else:
//   Model      the mongoose model
//   idField    the prefixed-id field name on that model
//   idPrefix   what generateId is called with
//   fields     writable field names, in the order they appear in the dashboard
//   validate   type-specific checks; returns { success, error }
//
// `fields` is an allowlist rather than a denylist. A denylist here would mean
// that adding `stats` to a schema silently makes it client-writable, which is
// exactly how attribution counters get faked.

function _requireText(value, label) {
    if (!value || typeof value !== "string" || !value.trim()) {
        return { success: false, error: `${label} is required` };
    }
    return { success: true };
}

const REGISTRY = {
    [ConfigObjectType.GUIDANCE_RULE]: {
        Model: GuidanceRule,
        idField: "guidanceRuleId",
        idPrefix: IdPrefix.GUIDANCE_RULE,
        label: "Guidance rule",
        fields: ["category", "title", "body"],
        validate: ({ body: payload }) => {
            const title = _requireText(payload.title, "title");
            if (!title.success) return title;
            const text = _requireText(payload.body, "body");
            if (!text.success) return text;
            if (!Object.values(GuidanceCategory).includes(payload.category)) {
                return { success: false, error: `category must be one of: ${Object.values(GuidanceCategory).join(", ")}` };
            }
            return { success: true };
        },
    },

    [ConfigObjectType.ESCALATION_RULE]: {
        Model: EscalationRule,
        idField: "escalationRuleId",
        idPrefix: IdPrefix.ESCALATION_RULE,
        label: "Escalation rule",
        fields: ["title", "conditions", "target"],
        validate: ({ body: payload }) => {
            const title = _requireText(payload.title, "title");
            if (!title.success) return title;
            if (payload.conditions !== undefined) {
                const conditions = conditionFunctions.validate({ conditions: payload.conditions });
                if (!conditions.success) return conditions;
                // A rule with no conditions matches every turn. That is almost
                // never what someone means by "escalation rule", and the failure
                // mode — every conversation escalating — is expensive enough to
                // be worth refusing at write time.
                if (payload.conditions.length === 0) {
                    return { success: false, error: "An escalation rule needs at least one condition, or it would escalate every conversation" };
                }
            }
            if (payload.target && payload.target.mode && !Object.values(EscalationMode).includes(payload.target.mode)) {
                return { success: false, error: `target.mode must be one of: ${Object.values(EscalationMode).join(", ")}` };
            }
            return { success: true };
        },
    },

    [ConfigObjectType.ESCALATION_GUIDANCE]: {
        Model: EscalationGuidance,
        idField: "escalationGuidanceId",
        idPrefix: IdPrefix.ESCALATION_GUIDANCE,
        label: "Escalation guidance",
        fields: ["title", "body"],
        validate: ({ body: payload }) => {
            const title = _requireText(payload.title, "title");
            if (!title.success) return title;
            return _requireText(payload.body, "body");
        },
    },

    [ConfigObjectType.ATTRIBUTE]: {
        Model: Attribute,
        idField: "attributeId",
        idPrefix: IdPrefix.ATTRIBUTE,
        label: "Attribute",
        fields: [
            "name",
            "description",
            "values",
            "conditions",
            "reDetectOnClose",
            "requireToClose",
            "visibleToTeams",
            "escalationRuleIds",
        ],
        validate: ({ body: payload }) => {
            const name = _requireText(payload.name, "name");
            if (!name.success) return name;
            if (payload.values !== undefined) {
                if (!Array.isArray(payload.values) || payload.values.length === 0) {
                    return { success: false, error: "An attribute needs at least one value" };
                }
                const names = payload.values.map((value) => String(value.name || "").trim().toLowerCase());
                if (names.some((value) => !value)) {
                    return { success: false, error: "Every attribute value needs a name" };
                }
                if (new Set(names).size !== names.length) {
                    return { success: false, error: "Attribute value names must be unique" };
                }
            }
            if (payload.conditions !== undefined) {
                return conditionFunctions.validate({ conditions: payload.conditions });
            }
            return { success: true };
        },
    },
};

// Built-in attributes cannot be deleted — analytics and the inbox read
// Sentiment by key, and a workspace that deletes it gets an inbox column that
// is permanently empty with no error anywhere.
function isProtected({ objectType, document }) {
    return objectType === ConfigObjectType.ATTRIBUTE && document.isBuiltIn === true;
}

function getEntry(objectType) {
    return REGISTRY[objectType] || null;
}

module.exports = { REGISTRY, getEntry, isProtected };
