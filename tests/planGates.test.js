// Unit tests for the plan gating middleware. Driven with fake req/res objects
// rather than over HTTP, because the behaviour that matters here — what happens
// when the plan is missing, at the boundary, and on unlimited plans — is
// awkward to provoke against a live database.
"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { requireFeature, requireCapacity } = require("../middlewares/plan");
const { getPlan } = require("../config/plans");
const { PlanId, FeatureKey, LimitReason } = require("../config/enums");

function fakeRes() {
    return {
        statusCode: null,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        },
    };
}

function run(middleware, req) {
    return new Promise((resolve) => {
        const res = fakeRes();
        let nextCalled = false;
        const maybe = middleware(req, res, () => {
            nextCalled = true;
            resolve({ nextCalled, res });
        });
        // Async middleware resolves after next(); sync middleware that answered
        // without calling next needs resolving here.
        Promise.resolve(maybe).then(() => {
            if (!nextCalled) resolve({ nextCalled, res });
        });
    });
}

describe("requireFeature", () => {
    test("passes a plan that includes the feature", async () => {
        const gate = requireFeature(FeatureKey.TABLES);
        const { nextCalled } = await run(gate, { plan: getPlan(PlanId.GROWTH), params: {} });
        assert.equal(nextCalled, true);
    });

    test("refuses a plan that does not, with 402 and the required feature", async () => {
        const gate = requireFeature(FeatureKey.TABLES);
        const { nextCalled, res } = await run(gate, { plan: getPlan(PlanId.FREE), params: {} });
        assert.equal(nextCalled, false);
        assert.equal(res.statusCode, 402);
        assert.equal(res.body.reason, LimitReason.PLAN_FEATURE);
        assert.equal(res.body.data.requiredFeature, FeatureKey.TABLES);
        assert.equal(res.body.data.currentPlan, PlanId.FREE);
    });

    test("fails open when no plan was attached — one outage must not become two", async () => {
        const gate = requireFeature(FeatureKey.TABLES);
        const { nextCalled } = await run(gate, { params: {} });
        assert.equal(nextCalled, true);
    });
});

describe("requireCapacity", () => {
    const orgId = "org_test";

    test("passes below the limit", async () => {
        const gate = requireCapacity("tables", async () => 2);
        const { nextCalled } = await run(gate, { plan: getPlan(PlanId.GROWTH), params: { orgId } });
        assert.equal(nextCalled, true);
    });

    test("refuses at the limit — the ceiling is not a target", async () => {
        const plan = getPlan(PlanId.GROWTH);
        const gate = requireCapacity("tables", async () => plan.limits.tables);
        const { nextCalled, res } = await run(gate, { plan, params: { orgId } });
        assert.equal(nextCalled, false);
        assert.equal(res.statusCode, 402);
        assert.equal(res.body.reason, LimitReason.PLAN_LIMIT);
        assert.equal(res.body.data.limit, plan.limits.tables);
    });

    test("an unlimited limit never counts, so the count query is skipped entirely", async () => {
        let counted = false;
        const gate = requireCapacity("tables", async () => {
            counted = true;
            return 10_000;
        });
        const { nextCalled } = await run(gate, { plan: getPlan(PlanId.SCALE), params: { orgId } });
        assert.equal(nextCalled, true);
        assert.equal(counted, false, "an unlimited plan should not pay for a countDocuments");
    });

    test("a zero limit refuses the first one", async () => {
        const gate = requireCapacity("actions", async () => 0);
        const { nextCalled, res } = await run(gate, { plan: getPlan(PlanId.FREE), params: { orgId } });
        assert.equal(nextCalled, false);
        assert.equal(res.statusCode, 402);
    });

    test("fails open when no plan was attached", async () => {
        const gate = requireCapacity("tables", async () => 10_000);
        const { nextCalled } = await run(gate, { params: { orgId } });
        assert.equal(nextCalled, true);
    });

    test("a counter that throws returns 500 rather than silently admitting", async () => {
        const gate = requireCapacity("tables", async () => {
            throw new Error("mongo is down");
        });
        const { nextCalled, res } = await run(gate, { plan: getPlan(PlanId.GROWTH), params: { orgId } });
        assert.equal(nextCalled, false);
        assert.equal(res.statusCode, 500);
    });
});
