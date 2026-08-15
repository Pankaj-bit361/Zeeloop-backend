const { ConditionOperator, ConditionField } = require("../../config/enums");

// One evaluator for every condition list in the product: segments (§2.6),
// escalation rules (§2.2) and attribute detection triggers (§2.3).
//
// Pure and synchronous by design. Everything it needs arrives on the context
// object, assembled once per turn by the caller — an evaluator that fetched its
// own data would issue one query per rule per turn, and would make "why did
// this rule fire" impossible to answer from the trace alone.
//
// Conditions ALL must match. See the note on escalationRule.js for why there is
// no "any" mode.

// Fields are resolved through this map rather than by property lookup, so a
// stored condition can only ever read what is deliberately exposed. A version
// that did `context[condition.field]` would let a support manager name any path
// on the context object, which is a tenancy leak waiting for someone to try it.
const FIELD_RESOLVERS = {
    [ConditionField.IDENTITY_VERIFIED]: (context) => context.identityVerified === true,
    [ConditionField.TURN_COUNT]: (context) => Number(context.turnCount || 0),
    [ConditionField.SENTIMENT]: (context) => context.sentiment || null,
    [ConditionField.INTENT]: (context) => context.intent || null,
    [ConditionField.PLAN]: (context) => context.planId || null,
    [ConditionField.LANGUAGE]: (context) => context.language || null,
    [ConditionField.CONVERSATION_COUNT]: (context) => Number(context.conversationCount || 0),
    [ConditionField.FIRST_SEEN_DAYS_AGO]: (context) => {
        if (!context.firstSeenAt) return null;
        const ms = Date.now() - new Date(context.firstSeenAt).getTime();
        return Math.floor(ms / 86_400_000);
    },
    [ConditionField.EMAIL_DOMAIN]: (context) => {
        const email = context.email || "";
        const at = email.lastIndexOf("@");
        return at === -1 ? null : email.slice(at + 1).toLowerCase();
    },
    // Keyed fields: `key` names which attribute or column, because one
    // ConditionField covers all of them.
    [ConditionField.ATTRIBUTE]: (context, key) => (context.attributes || {})[key] ?? null,
    [ConditionField.TABLE_VALUE]: (context, key) => (context.tableValues || {})[key] ?? null,
};

class ConditionFunctions {
    // ── Public Functions ─────────────────────────────────────────────

    // An empty condition list matches everything. That is the difference between
    // "this rule applies to everyone" and "this rule is broken", and every
    // caller wants the first reading — a guidance rule with no audience filter
    // is the normal case, not an oversight.
    evaluate({ conditions, context }) {
        console.log("ConditionFunctions:evaluate: count:", (conditions || []).length);
        try {
            if (!conditions || conditions.length === 0) return { success: true, matched: true, failed: [] };

            const failed = [];
            for (const condition of conditions) {
                if (!this._matchOne({ condition, context: context || {} })) {
                    failed.push(condition);
                }
            }
            return { success: true, matched: failed.length === 0, failed };
        } catch (error) {
            console.error("ConditionFunctions:evaluate: Catch block");
            console.error(error);
            // Fail closed. A rule whose conditions could not be evaluated must
            // not be treated as matching — silently applying an escalation rule
            // nobody can explain is worse than not applying it.
            return { success: false, matched: false, failed: conditions || [] };
        }
    }

    // Human-readable rendering for the dashboard and for trace attribution.
    describe({ conditions }) {
        if (!conditions || conditions.length === 0) return "everyone";
        return conditions
            .map((condition) => {
                const field = condition.key ? `${condition.field}[${condition.key}]` : condition.field;
                if (condition.operator === ConditionOperator.IS_SET) return `${field} is set`;
                if (condition.operator === ConditionOperator.IS_NOT_SET) return `${field} is not set`;
                return `${field} ${condition.operator.toLowerCase().replace(/_/g, " ")} ${JSON.stringify(condition.value)}`;
            })
            .join(" AND ");
    }

    // Rejects conditions the evaluator could never satisfy, at write time
    // rather than at turn time. A rule saved with a typo'd field would
    // otherwise sit in the list looking enabled and never fire.
    validate({ conditions }) {
        if (!Array.isArray(conditions)) return { success: false, error: "conditions must be an array" };
        for (const condition of conditions) {
            if (!FIELD_RESOLVERS[condition.field]) {
                return { success: false, error: `Unknown condition field: ${condition.field}` };
            }
            if (!Object.values(ConditionOperator).includes(condition.operator)) {
                return { success: false, error: `Unknown condition operator: ${condition.operator}` };
            }
            const keyed = condition.field === ConditionField.ATTRIBUTE || condition.field === ConditionField.TABLE_VALUE;
            if (keyed && !condition.key) {
                return { success: false, error: `${condition.field} conditions require a key` };
            }
            if (condition.operator === ConditionOperator.IN && !Array.isArray(condition.value)) {
                return { success: false, error: "IN conditions require an array value" };
            }
        }
        return { success: true };
    }

    // ── Private Helper Functions ─────────────────────────────────────

    _matchOne({ condition, context }) {
        const resolver = FIELD_RESOLVERS[condition.field];
        if (!resolver) return false;

        const actual = resolver(context, condition.key);
        const expected = condition.value;

        switch (condition.operator) {
            case ConditionOperator.IS_SET:
                return actual !== null && actual !== undefined && actual !== "";
            case ConditionOperator.IS_NOT_SET:
                return actual === null || actual === undefined || actual === "";
            case ConditionOperator.EQUALS:
                return this._looseEquals(actual, expected);
            case ConditionOperator.NOT_EQUALS:
                return !this._looseEquals(actual, expected);
            case ConditionOperator.CONTAINS:
                return String(actual ?? "").toLowerCase().includes(String(expected ?? "").toLowerCase());
            case ConditionOperator.NOT_CONTAINS:
                return !String(actual ?? "").toLowerCase().includes(String(expected ?? "").toLowerCase());
            case ConditionOperator.GREATER_THAN:
                return this._numeric(actual) !== null && this._numeric(actual) > this._numeric(expected);
            case ConditionOperator.LESS_THAN:
                return this._numeric(actual) !== null && this._numeric(actual) < this._numeric(expected);
            case ConditionOperator.IN:
                return Array.isArray(expected) && expected.some((item) => this._looseEquals(actual, item));
            default:
                return false;
        }
    }

    // Values arrive from JSON bodies, so "true" and true, "3" and 3 are both
    // common for the same condition. Comparing them as strings after a boolean
    // normalisation is what a support manager typing into a form expects;
    // strict equality here would make half the rules they write silently never
    // match.
    _looseEquals(actual, expected) {
        if (actual === expected) return true;
        if (actual === null || actual === undefined || expected === null || expected === undefined) return false;
        if (typeof actual === "boolean" || typeof expected === "boolean") {
            return this._toBool(actual) === this._toBool(expected);
        }
        return String(actual).toLowerCase() === String(expected).toLowerCase();
    }

    _toBool(value) {
        if (typeof value === "boolean") return value;
        return String(value).toLowerCase() === "true";
    }

    _numeric(value) {
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    }
}

module.exports = new ConditionFunctions();
module.exports.FIELD_RESOLVERS = FIELD_RESOLVERS;
