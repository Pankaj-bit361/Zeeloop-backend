// Pure unit tests for the condition evaluator (§2.2, §2.3, §2.6).
//
// One evaluator serves segments, escalation rules and attribute triggers, so a
// bug here silently misroutes every one of them. No server, no database.
"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const conditionFunctions = require("../functions/config/conditionFunctions");
const { ConditionOperator, ConditionField, GateSentiment } = require("../config/enums");

const evaluate = (conditions, context) => conditionFunctions.evaluate({ conditions, context }).matched;
const one = (field, operator, value, key) => [{ field, operator, value, key }];

describe("condition evaluator — the empty case", () => {
    test("no conditions matches everything", () => {
        assert.equal(evaluate([], {}), true);
        assert.equal(evaluate(undefined, {}), true);
        assert.equal(evaluate(null, { anything: true }), true);
    });

    test("an empty list is 'applies to everyone', not 'broken'", () => {
        // The distinction that matters: a guidance rule with no audience filter
        // is the normal case. Reading it as "matches nobody" would silently
        // disable most of the configuration surface.
        const result = conditionFunctions.evaluate({ conditions: [], context: {} });
        assert.equal(result.success, true);
        assert.equal(result.matched, true);
        assert.deepEqual(result.failed, []);
    });
});

describe("condition evaluator — operators", () => {
    test("EQUALS compares loosely across JSON body types", () => {
        // Values arrive from a form as strings; the context has real types.
        assert.equal(evaluate(one(ConditionField.TURN_COUNT, ConditionOperator.EQUALS, "3"), { turnCount: 3 }), true);
        assert.equal(
            evaluate(one(ConditionField.IDENTITY_VERIFIED, ConditionOperator.EQUALS, "true"), { identityVerified: true }),
            true
        );
        assert.equal(
            evaluate(one(ConditionField.SENTIMENT, ConditionOperator.EQUALS, "angry"), { sentiment: GateSentiment.ANGRY }),
            true
        );
    });

    test("NOT_EQUALS is the exact inverse", () => {
        assert.equal(evaluate(one(ConditionField.SENTIMENT, ConditionOperator.NOT_EQUALS, "ANGRY"), { sentiment: "NEUTRAL" }), true);
        assert.equal(evaluate(one(ConditionField.SENTIMENT, ConditionOperator.NOT_EQUALS, "ANGRY"), { sentiment: "ANGRY" }), false);
    });

    test("GREATER_THAN and LESS_THAN compare numerically, not lexically", () => {
        // The bug this catches: "10" < "9" as strings.
        assert.equal(evaluate(one(ConditionField.TURN_COUNT, ConditionOperator.GREATER_THAN, 9), { turnCount: 10 }), true);
        assert.equal(evaluate(one(ConditionField.TURN_COUNT, ConditionOperator.LESS_THAN, 9), { turnCount: 10 }), false);
        assert.equal(evaluate(one(ConditionField.TURN_COUNT, ConditionOperator.GREATER_THAN, "9"), { turnCount: "10" }), true);
    });

    test("GREATER_THAN on a null field does not match", () => {
        assert.equal(evaluate(one(ConditionField.SENTIMENT, ConditionOperator.GREATER_THAN, 3), { sentiment: null }), false);
    });

    test("CONTAINS is case-insensitive", () => {
        assert.equal(
            evaluate(one(ConditionField.EMAIL_DOMAIN, ConditionOperator.CONTAINS, "ACME"), { email: "a@acme.com" }),
            true
        );
    });

    test("IS_SET treats empty string as unset", () => {
        assert.equal(evaluate(one(ConditionField.LANGUAGE, ConditionOperator.IS_SET), { language: "en" }), true);
        assert.equal(evaluate(one(ConditionField.LANGUAGE, ConditionOperator.IS_SET), { language: "" }), false);
        assert.equal(evaluate(one(ConditionField.LANGUAGE, ConditionOperator.IS_NOT_SET), { language: null }), true);
    });

    test("IN matches any member of the list", () => {
        const conditions = one(ConditionField.SENTIMENT, ConditionOperator.IN, ["NEGATIVE", "ANGRY"]);
        assert.equal(evaluate(conditions, { sentiment: "ANGRY" }), true);
        assert.equal(evaluate(conditions, { sentiment: "POSITIVE" }), false);
    });

    test("IN with a non-array value does not match rather than throwing", () => {
        assert.equal(evaluate(one(ConditionField.SENTIMENT, ConditionOperator.IN, "ANGRY"), { sentiment: "ANGRY" }), false);
    });
});

describe("condition evaluator — field resolution", () => {
    test("EMAIL_DOMAIN takes everything after the last @", () => {
        assert.equal(
            evaluate(one(ConditionField.EMAIL_DOMAIN, ConditionOperator.EQUALS, "brightloop.io"), { email: "maya@brightloop.io" }),
            true
        );
        // A plus-addressed mailbox still resolves to the real domain.
        assert.equal(
            evaluate(one(ConditionField.EMAIL_DOMAIN, ConditionOperator.EQUALS, "acme.com"), { email: "a+tag@acme.com" }),
            true
        );
    });

    test("FIRST_SEEN_DAYS_AGO is computed, not read", () => {
        const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
        assert.equal(
            evaluate(one(ConditionField.FIRST_SEEN_DAYS_AGO, ConditionOperator.GREATER_THAN, 7), { firstSeenAt: tenDaysAgo }),
            true
        );
        assert.equal(
            evaluate(one(ConditionField.FIRST_SEEN_DAYS_AGO, ConditionOperator.GREATER_THAN, 30), { firstSeenAt: tenDaysAgo }),
            false
        );
    });

    test("ATTRIBUTE and TABLE_VALUE read through their key", () => {
        assert.equal(
            evaluate(one(ConditionField.ATTRIBUTE, ConditionOperator.EQUALS, "BILLING", "Issue Type"), {
                attributes: { "Issue Type": "BILLING" },
            }),
            true
        );
        assert.equal(
            evaluate(one(ConditionField.TABLE_VALUE, ConditionOperator.EQUALS, "gold", "tier"), { tableValues: { tier: "gold" } }),
            true
        );
    });

    test("an unknown field never matches", () => {
        // The allowlist is the tenancy protection: a stored condition must not
        // be able to name an arbitrary path on the context object.
        assert.equal(evaluate([{ field: "widgetSecret", operator: ConditionOperator.IS_SET }], { widgetSecret: "ws_live_x" }), false);
    });
});

describe("condition evaluator — AND semantics", () => {
    test("every condition must match", () => {
        const conditions = [
            { field: ConditionField.IDENTITY_VERIFIED, operator: ConditionOperator.EQUALS, value: true },
            { field: ConditionField.TURN_COUNT, operator: ConditionOperator.GREATER_THAN, value: 2 },
        ];
        assert.equal(evaluate(conditions, { identityVerified: true, turnCount: 5 }), true);
        assert.equal(evaluate(conditions, { identityVerified: true, turnCount: 1 }), false);
        assert.equal(evaluate(conditions, { identityVerified: false, turnCount: 5 }), false);
    });

    test("failed conditions are reported so the UI can say which", () => {
        const conditions = [
            { field: ConditionField.IDENTITY_VERIFIED, operator: ConditionOperator.EQUALS, value: true },
            { field: ConditionField.TURN_COUNT, operator: ConditionOperator.GREATER_THAN, value: 99 },
        ];
        const result = conditionFunctions.evaluate({ conditions, context: { identityVerified: true, turnCount: 1 } });
        assert.equal(result.matched, false);
        assert.equal(result.failed.length, 1);
        assert.equal(result.failed[0].field, ConditionField.TURN_COUNT);
    });
});

describe("condition validation", () => {
    test("rejects an unknown field at write time", () => {
        const result = conditionFunctions.validate({ conditions: [{ field: "PLAN_NAME", operator: ConditionOperator.EQUALS, value: "x" }] });
        assert.equal(result.success, false);
        assert.match(result.error, /Unknown condition field/);
    });

    test("rejects an unknown operator", () => {
        const result = conditionFunctions.validate({ conditions: [{ field: ConditionField.PLAN, operator: "MATCHES", value: "x" }] });
        assert.equal(result.success, false);
        assert.match(result.error, /Unknown condition operator/);
    });

    test("keyed fields require a key", () => {
        const result = conditionFunctions.validate({
            conditions: [{ field: ConditionField.ATTRIBUTE, operator: ConditionOperator.EQUALS, value: "BILLING" }],
        });
        assert.equal(result.success, false);
        assert.match(result.error, /require a key/);
    });

    test("IN requires an array", () => {
        const result = conditionFunctions.validate({
            conditions: [{ field: ConditionField.SENTIMENT, operator: ConditionOperator.IN, value: "ANGRY" }],
        });
        assert.equal(result.success, false);
        assert.match(result.error, /array value/);
    });

    test("accepts a valid condition list", () => {
        const result = conditionFunctions.validate({
            conditions: [
                { field: ConditionField.SENTIMENT, operator: ConditionOperator.IN, value: ["ANGRY", "NEGATIVE"] },
                { field: ConditionField.TURN_COUNT, operator: ConditionOperator.GREATER_THAN, value: 3 },
            ],
        });
        assert.equal(result.success, true);
    });
});

describe("condition description", () => {
    test("renders 'everyone' for an empty list", () => {
        assert.equal(conditionFunctions.describe({ conditions: [] }), "everyone");
    });

    test("renders a readable AND chain", () => {
        const text = conditionFunctions.describe({
            conditions: [
                { field: ConditionField.IDENTITY_VERIFIED, operator: ConditionOperator.EQUALS, value: true },
                { field: ConditionField.ATTRIBUTE, operator: ConditionOperator.EQUALS, value: "BILLING", key: "Issue Type" },
            ],
        });
        assert.match(text, /IDENTITY_VERIFIED equals true/);
        assert.match(text, /AND/);
        assert.match(text, /ATTRIBUTE\[Issue Type\]/);
    });
});
