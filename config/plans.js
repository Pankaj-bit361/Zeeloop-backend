const { PlanId, FeatureKey } = require("./enums");

// The plan registry. Everything about what a workspace may do lives here, so
// pricing and packaging changes are an edit to this file rather than a hunt
// through conditionals scattered across the codebase (§0.2).
//
// PRICES ARE PLACEHOLDERS. They are not a pricing decision — spec.md §12 fixes
// the shape (tiered conversation volume, tables/actions/procedures behind the
// paid tier) but not the numbers. Set `priceUsd` and the provider variant ids
// before anything is charged.
//
// `limits` are per billing period. null means unlimited — checked explicitly
// everywhere rather than relying on Infinity arithmetic.

const UNLIMITED = null;

const PLANS = {
    [PlanId.FREE]: {
        id: PlanId.FREE,
        name: "Free",
        priceUsd: 0,
        // Docs-only Q&A, per spec.md §12. The upgrade trigger is the moment
        // they want "where is my order" to work, which needs TABLES + ACTIONS.
        features: [FeatureKey.KNOWLEDGE],
        limits: {
            conversations: 100,
            sources: 3,
            actions: 0,
            tables: 0,
            seats: 1,
            // Hard ceiling on model spend per period, independent of the
            // conversation count — a single pathological conversation can burn
            // far more than its share (§8.2).
            costUsd: 5,
        },
    },

    // The entry paid tier, and the one the FREE plan's ceiling is designed to
    // push people into: it is the cheapest way to make "where is my order"
    // work, because it is the first plan with TABLES and ACTIONS.
    //
    // 1,000 conversations rather than 500 so the step up from FREE is a step in
    // volume as well as capability — the landing page advertises 500 on FREE,
    // and two adjacent cards showing the same number reads as a mistake.
    [PlanId.STARTER]: {
        id: PlanId.STARTER,
        name: "Starter",
        priceUsd: 29,
        features: [FeatureKey.KNOWLEDGE, FeatureKey.TABLES, FeatureKey.ACTIONS],
        limits: { conversations: 1000, sources: 25, actions: 5, tables: 3, seats: 3, costUsd: 55 },
    },

    [PlanId.GROWTH]: {
        id: PlanId.GROWTH,
        name: "Growth",
        priceUsd: 149,
        features: [
            FeatureKey.KNOWLEDGE,
            FeatureKey.TABLES,
            FeatureKey.ACTIONS,
            FeatureKey.PROCEDURES,
            FeatureKey.EMAIL_CHANNEL,
            FeatureKey.REMOVE_BRANDING,
        ],
        limits: { conversations: 2000, sources: 100, actions: 25, tables: 10, seats: 10, costUsd: 150 },
    },

    [PlanId.SCALE]: {
        id: PlanId.SCALE,
        name: "Scale",
        priceUsd: 499,
        features: Object.values(FeatureKey),
        limits: {
            conversations: 10000,
            sources: UNLIMITED,
            actions: UNLIMITED,
            tables: UNLIMITED,
            seats: UNLIMITED,
            costUsd: 600,
        },
    },
};

// Fraction of a limit at which the dashboard starts warning (§0.3). Deliberately
// not 1.0 — a customer who discovers the ceiling by hitting it has already had a
// bad day.
const SOFT_LIMIT_RATIO = 0.8;

// Trial length in days for a new workspace (§0.5). No card required, so an
// expired trial drops to FREE rather than suspending.
const TRIAL_DAYS = 14;

// How long a past-due subscription keeps working before features suspend.
const GRACE_PERIOD_DAYS = 7;

function getPlan(planId) {
    return PLANS[planId] || PLANS[PlanId.FREE];
}

// A limit of null is unlimited; anything else compares numerically. Callers
// must never do `used > limit` directly, or unlimited plans start failing.
function isWithinLimit(used, limit) {
    if (limit === UNLIMITED) return true;
    return used < limit;
}

function planHasFeature(planId, featureKey) {
    return getPlan(planId).features.includes(featureKey);
}

module.exports = {
    PLANS,
    UNLIMITED,
    SOFT_LIMIT_RATIO,
    TRIAL_DAYS,
    GRACE_PERIOD_DAYS,
    getPlan,
    isWithinLimit,
    planHasFeature,
};
