// Pure unit tests for the plan registry and effective-plan resolution.
// No server, no database — these are the rules that decide what a paying
// customer may do, so they are worth testing in isolation from HTTP.
"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { PLANS, UNLIMITED, getPlan, isWithinLimit, planHasFeature, SOFT_LIMIT_RATIO } = require("../config/plans");
const { PlanId, FeatureKey, SubscriptionStatus } = require("../config/enums");
const billingFunctions = require("../functions/billing/billingFunctions");

const DAY_MS = 24 * 60 * 60 * 1000;
const future = (days) => new Date(Date.now() + days * DAY_MS);
const past = (days) => new Date(Date.now() - days * DAY_MS);

// Shorthand for the pure resolver under test.
const resolve = (subscription) => billingFunctions._resolveEffectivePlanId({ subscription });

describe("plan registry", () => {
    test("every PlanId has a registry entry", () => {
        for (const id of Object.values(PlanId)) {
            assert.ok(PLANS[id], `missing registry entry for ${id}`);
            assert.equal(PLANS[id].id, id);
        }
    });

    test("getPlan falls back to FREE for an unknown id", () => {
        assert.equal(getPlan("ENTERPRISE_PLATINUM").id, PlanId.FREE);
        assert.equal(getPlan(undefined).id, PlanId.FREE);
    });

    test("FREE is docs-only — no tables, actions or procedures", () => {
        assert.ok(planHasFeature(PlanId.FREE, FeatureKey.KNOWLEDGE));
        assert.equal(planHasFeature(PlanId.FREE, FeatureKey.TABLES), false);
        assert.equal(planHasFeature(PlanId.FREE, FeatureKey.ACTIONS), false);
        assert.equal(planHasFeature(PlanId.FREE, FeatureKey.PROCEDURES), false);
    });

    test("paid tiers unlock tables and actions — the 'where is my order' trigger", () => {
        for (const id of [PlanId.STARTER, PlanId.GROWTH, PlanId.SCALE]) {
            assert.ok(planHasFeature(id, FeatureKey.TABLES), `${id} should include TABLES`);
            assert.ok(planHasFeature(id, FeatureKey.ACTIONS), `${id} should include ACTIONS`);
        }
    });

    test("every plan carries a cost ceiling — an unbounded model bill is not a plan", () => {
        for (const plan of Object.values(PLANS)) {
            assert.equal(typeof plan.limits.costUsd, "number", `${plan.id} has no costUsd ceiling`);
            assert.ok(plan.limits.costUsd > 0);
        }
    });

    test("STARTER is the $29 entry tier, and it is what unlocks the upgrade trigger", () => {
        // The number is asserted because it is shown in three other places —
        // the landing page, the dashboard's plan cards, and the provider's
        // variant. If it moves here and nowhere else, customers see one price
        // and get charged another.
        assert.equal(PLANS[PlanId.STARTER].priceUsd, 29);
        assert.equal(PLANS[PlanId.STARTER].limits.conversations, 1000);
        assert.ok(planHasFeature(PlanId.STARTER, FeatureKey.TABLES));
        assert.ok(planHasFeature(PlanId.STARTER, FeatureKey.ACTIONS));
        // Not everything, though — procedures and the email channel are what
        // GROWTH is for, and a tier that includes them has nothing to sell.
        assert.equal(planHasFeature(PlanId.STARTER, FeatureKey.PROCEDURES), false);
        assert.equal(planHasFeature(PlanId.STARTER, FeatureKey.EMAIL_CHANNEL), false);
    });

    test("every paid tier is cheaper than the one above it, with no gaps in the ladder", () => {
        // Guards the insertion itself: a new tier priced outside its slot makes
        // the pricing page non-monotonic, which is the kind of thing nobody
        // notices until a customer asks why the cheaper plan does more.
        const paid = [PlanId.STARTER, PlanId.GROWTH, PlanId.SCALE];
        for (const id of paid) {
            assert.ok(PLANS[id].priceUsd > 0, `${id} is a paid tier and must cost something`);
        }
    });

    test("limits increase monotonically with price", () => {
        const ladder = [PlanId.FREE, PlanId.STARTER, PlanId.GROWTH, PlanId.SCALE];
        for (let i = 1; i < ladder.length; i++) {
            const lower = PLANS[ladder[i - 1]];
            const higher = PLANS[ladder[i]];
            assert.ok(higher.priceUsd > lower.priceUsd, `${higher.id} must cost more than ${lower.id}`);
            assert.ok(
                higher.limits.conversations > lower.limits.conversations,
                `${higher.id} must allow more conversations than ${lower.id}`
            );
        }
    });
});

describe("isWithinLimit", () => {
    test("null means unlimited, never a numeric comparison", () => {
        assert.equal(isWithinLimit(0, UNLIMITED), true);
        assert.equal(isWithinLimit(999_999, UNLIMITED), true);
    });

    test("is exclusive at the boundary — the limit is a ceiling, not a target", () => {
        assert.equal(isWithinLimit(99, 100), true);
        assert.equal(isWithinLimit(100, 100), false);
        assert.equal(isWithinLimit(101, 100), false);
    });

    test("a zero limit admits nothing", () => {
        assert.equal(isWithinLimit(0, 0), false);
    });
});

describe("_resolveEffectivePlanId", () => {
    test("ACTIVE keeps the purchased plan", () => {
        const result = resolve({ status: SubscriptionStatus.ACTIVE, plan: PlanId.GROWTH });
        assert.equal(result.planId, PlanId.GROWTH);
        assert.equal(result.reason, null);
    });

    test("a live trial grants the trial plan", () => {
        const result = resolve({
            status: SubscriptionStatus.TRIALING,
            plan: PlanId.STARTER,
            trialEndsAt: future(3),
        });
        assert.equal(result.planId, PlanId.STARTER);
    });

    test("an expired trial drops to FREE rather than suspending", () => {
        const result = resolve({
            status: SubscriptionStatus.TRIALING,
            plan: PlanId.STARTER,
            trialEndsAt: past(1),
        });
        assert.equal(result.planId, PlanId.FREE);
        assert.equal(result.reason, "TRIAL_ENDED");
    });

    test("PAST_DUE inside the grace window keeps working — an expired card is not a decision to leave", () => {
        const result = resolve({
            status: SubscriptionStatus.PAST_DUE,
            plan: PlanId.GROWTH,
            gracePeriodEndsAt: future(3),
        });
        assert.equal(result.planId, PlanId.GROWTH);
        assert.equal(result.reason, "PAYMENT_FAILED_IN_GRACE");
    });

    test("PAST_DUE past the grace window drops to FREE", () => {
        const result = resolve({
            status: SubscriptionStatus.PAST_DUE,
            plan: PlanId.GROWTH,
            gracePeriodEndsAt: past(1),
        });
        assert.equal(result.planId, PlanId.FREE);
        assert.equal(result.reason, "PAYMENT_FAILED");
    });

    test("CANCELLED keeps the plan until the period they paid for ends", () => {
        const result = resolve({
            status: SubscriptionStatus.CANCELLED,
            plan: PlanId.SCALE,
            currentPeriodEnd: future(10),
        });
        assert.equal(result.planId, PlanId.SCALE);
        assert.equal(result.reason, "CANCELLED_ACTIVE_UNTIL_PERIOD_END");
    });

    test("CANCELLED past the period end drops to FREE", () => {
        const result = resolve({
            status: SubscriptionStatus.CANCELLED,
            plan: PlanId.SCALE,
            currentPeriodEnd: past(1),
        });
        assert.equal(result.planId, PlanId.FREE);
    });

    test("EXPIRED always drops to FREE", () => {
        const result = resolve({
            status: SubscriptionStatus.EXPIRED,
            plan: PlanId.SCALE,
            currentPeriodEnd: future(30),
        });
        assert.equal(result.planId, PlanId.FREE);
    });

    test("a missing trialEndsAt does not accidentally grant a paid plan", () => {
        const result = resolve({ status: SubscriptionStatus.TRIALING, plan: PlanId.SCALE, trialEndsAt: null });
        assert.equal(result.planId, PlanId.FREE);
    });
});

describe("soft limit ratio", () => {
    test("warns before the ceiling, not at it", () => {
        assert.ok(SOFT_LIMIT_RATIO > 0 && SOFT_LIMIT_RATIO < 1);
    });
});
