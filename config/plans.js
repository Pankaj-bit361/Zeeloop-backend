const { PlanId, FeatureKey } = require("./enums");

// The plan registry. Everything about what a workspace may do lives here, so
// pricing and packaging changes are an edit to this file rather than a hunt
// through conditionals scattered across the codebase (§0.2).
//
// These are the REAL prices as of 16 August 2026, and they agree with the
// landing page and the dashboard's plan cards.
//
// The conversation caps are set from measured unit cost, not from what sounds
// generous. At ANSWER_MODEL=haiku a conversation costs roughly $0.028 (5 chunks
// of retrieved context, a few hundred output tokens, the gate and attribute
// passes, embedding and rerank, across 2-4 turns). The caps leave about a 60-70%
// gross margin at full usage, which is what makes the plans survive a customer
// who actually uses what they bought.
//
// For reference, the self-serve market charges $0.18-0.80 per conversation
// (Chatbase, once its credit multipliers are unwound) and Intercom Fin charges
// $0.99 per RESOLUTION. These caps price at $0.07-0.10 per conversation, so
// they remain 2-10x cheaper than the nearest competitor while making money. They previously did not: the
// pages quoted $99/3,000 and $399/15,000 while this file enforced $149/2,000
// and $499/10,000, so customers were sold one thing and cut off at another.
//
// Three places have to move together, and one more outside this repo: the
// Razorpay PLAN carries the amount that is actually charged, so a change here
// without a change there quotes a price nobody is billed.
//
//   backend/config/plans.js   (this file — what is enforced)
//   web/src/app/page.tsx      (what is advertised)
//   zealoop  Billing.tsx      (what a signed-in customer is shown)
//   Razorpay plan_xxx         (what the card is actually charged)
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
            // A conversation is a thread, not a message: `conversations` is
            // incremented once, when the thread is created (usageFunctions
            // `recordTurn`, on `isNewConversation`). Every later message in
            // that thread counts as a turn instead. So this is 50 distinct
            // visitors in a period, each of whom may ask as much as they like.
            conversations: 50,
            sources: 3,
            actions: 0,
            tables: 0,
            seats: 1,
            /* Hard ceiling on model spend per period, independent of the
               conversation count — a single pathological conversation can burn
               far more than its share (§8.2).

               These now sit BELOW the plan price, which is a change: they used
               to sit at or above it, so the guard could not fire until the
               customer was already unprofitable. Sized at roughly 2.5x the
               expected spend at the full conversation cap, so an ordinary heavy
               user never meets it and a runaway is stopped while there is still
               margin left. */
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
        limits: { conversations: 300, sources: 25, actions: 5, tables: 3, seats: 3, costUsd: 20 },
    },

    [PlanId.GROWTH]: {
        id: PlanId.GROWTH,
        name: "Growth",
        priceUsd: 99,
        features: [
            FeatureKey.KNOWLEDGE,
            FeatureKey.TABLES,
            FeatureKey.ACTIONS,
            FeatureKey.PROCEDURES,
            FeatureKey.EMAIL_CHANNEL,
            FeatureKey.REMOVE_BRANDING,
        ],
        limits: { conversations: 1200, sources: 100, actions: 25, tables: 10, seats: 10, costUsd: 70 },
    },

    [PlanId.SCALE]: {
        id: PlanId.SCALE,
        name: "Scale",
        priceUsd: 399,
        features: Object.values(FeatureKey),
        limits: {
            conversations: 6000,
            sources: UNLIMITED,
            actions: UNLIMITED,
            tables: UNLIMITED,
            seats: UNLIMITED,
            costUsd: 280,
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
