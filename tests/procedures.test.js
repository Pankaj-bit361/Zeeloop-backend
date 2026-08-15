// Pure unit tests for procedures v2 (§5.4).
//
// The property that matters most: v1 documents — a flat array of strings — must
// keep working with no migration. Everything else is additive.
"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const procedureFunctions = require("../functions/procedure/procedureFunctions");
const { ProcedureStepType, ConditionField, ConditionOperator } = require("../config/enums");

describe("step normalisation — backward compatibility", () => {
    test("a v1 array of strings reads as INSTRUCTION steps", () => {
        // No migration, no deploy window. A step stored as a string always was
        // an instruction; this just says so.
        const steps = procedureFunctions.normaliseSteps(["Ask for the order id", "Look it up", "Confirm"]);

        assert.equal(steps.length, 3);
        assert.equal(steps[0].type, ProcedureStepType.INSTRUCTION);
        assert.equal(steps[0].text, "Ask for the order id");
    });

    test("mixed v1 strings and v2 objects both survive", () => {
        const steps = procedureFunctions.normaliseSteps([
            "Greet the customer",
            { type: ProcedureStepType.TOOL, actionId: "act_lookup", text: "Look up the order" },
        ]);

        assert.equal(steps[0].type, ProcedureStepType.INSTRUCTION);
        assert.equal(steps[1].type, ProcedureStepType.TOOL);
        assert.equal(steps[1].actionId, "act_lookup");
    });

    test("an unknown step type falls back to INSTRUCTION rather than being dropped", () => {
        const steps = procedureFunctions.normaliseSteps([{ type: "LOOP", text: "Repeat until done" }]);
        assert.equal(steps[0].type, ProcedureStepType.INSTRUCTION);
        assert.equal(steps[0].text, "Repeat until done");
    });

    test("empty steps are dropped", () => {
        const steps = procedureFunctions.normaliseSteps(["", null, { text: "" }, "Real step"]);
        assert.equal(steps.length, 1);
        assert.equal(steps[0].text, "Real step");
    });

    test("branch children are flattened to strings, refusing nesting", () => {
        // A branch inside a branch is a visual workflow builder, which is an
        // explicit non-goal.
        const steps = procedureFunctions.normaliseSteps([
            {
                type: ProcedureStepType.BRANCH,
                conditions: [],
                thenSteps: ["Refund it", { text: "Email them" }, { type: ProcedureStepType.BRANCH, text: "" }],
            },
        ]);

        assert.deepEqual(steps[0].thenSteps, ["Refund it", "Email them"]);
    });

    test("step count is capped", () => {
        const many = Array.from({ length: 100 }, (unused, index) => `Step ${index}`);
        assert.equal(procedureFunctions.normaliseSteps(many).length, procedureFunctions.MAX_STEPS);
    });

    test("a non-array returns empty rather than throwing", () => {
        assert.deepEqual(procedureFunctions.normaliseSteps(null), []);
        assert.deepEqual(procedureFunctions.normaliseSteps("Ask for the order id"), []);
    });
});

describe("branch resolution in the prompt (§5.4)", () => {
    const branchProcedure = {
        steps: [
            "Greet the customer",
            {
                type: ProcedureStepType.BRANCH,
                conditions: [{ field: ConditionField.IDENTITY_VERIFIED, operator: ConditionOperator.EQUALS, value: true }],
                thenSteps: ["Look up their account", "Offer the refund"],
                elseSteps: ["Ask them to sign in"],
            },
            "Confirm the outcome",
        ],
    };

    test("only the matching branch reaches the model", () => {
        // A model shown both sides of an IF picks whichever it prefers, which
        // makes the condition decorative. Resolved in code, it is a guarantee.
        const verified = procedureFunctions.renderForPrompt({
            procedure: branchProcedure,
            context: { identityVerified: true },
            actionsById: new Map(),
        });

        assert.match(verified, /Look up their account/);
        assert.match(verified, /Offer the refund/);
        assert.doesNotMatch(verified, /Ask them to sign in/);
    });

    test("the else branch is used when the condition fails", () => {
        const anonymous = procedureFunctions.renderForPrompt({
            procedure: branchProcedure,
            context: { identityVerified: false },
            actionsById: new Map(),
        });

        assert.match(anonymous, /Ask them to sign in/);
        assert.doesNotMatch(anonymous, /Offer the refund/);
    });

    test("steps stay numbered continuously across a branch", () => {
        // The model is told to follow steps "in order", so a gap in the
        // numbering after a branch reads as a missing step.
        const rendered = procedureFunctions.renderForPrompt({
            procedure: branchProcedure,
            context: { identityVerified: true },
            actionsById: new Map(),
        });

        const numbers = [...rendered.matchAll(/^(\d+)\./gm)].map((match) => Number(match[1]));
        assert.deepEqual(numbers, [1, 2, 3, 4]);
    });
});

describe("tool steps in the prompt", () => {
    test("a tool step names the action and the tool_call shape", () => {
        const rendered = procedureFunctions.renderForPrompt({
            procedure: { steps: [{ type: ProcedureStepType.TOOL, actionId: "act_lookup", text: "Look up the order" }] },
            context: {},
            actionsById: new Map([["act_lookup", { actionId: "act_lookup", name: "Look up order" }]]),
        });

        assert.match(rendered, /Look up the order/);
        assert.match(rendered, /"actionId":"act_lookup"/);
    });

    test("a tool step without continueOnFailure tells the model to stop on failure", () => {
        const rendered = procedureFunctions.renderForPrompt({
            procedure: { steps: [{ type: ProcedureStepType.TOOL, actionId: "act_x", continueOnFailure: false }] },
            context: {},
            actionsById: new Map([["act_x", { actionId: "act_x", name: "Do it" }]]),
        });
        assert.match(rendered, /hand off to a human/i);
    });

    test("a tool step whose action is missing degrades to an instruction, not a silent skip", () => {
        // The action was deleted or is untested. Dropping the step would make
        // the agent skip something the author considered mandatory, with nobody
        // knowing.
        const rendered = procedureFunctions.renderForPrompt({
            procedure: { steps: [{ type: ProcedureStepType.TOOL, actionId: "act_gone" }] },
            context: {},
            actionsById: new Map(),
        });

        assert.match(rendered, /cannot complete this step/i);
        assert.doesNotMatch(rendered, /act_gone/);
    });
});
