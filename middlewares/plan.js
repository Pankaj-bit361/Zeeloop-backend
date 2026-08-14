const { LimitReason } = require("../config/enums");
const { isWithinLimit, planHasFeature, UNLIMITED } = require("../config/plans");
const billingFunctions = require("../functions/billing/billingFunctions");
const generalFunctions = require("../functions/utilFunctions/generalFunctions");

// Plan gating at the API layer (§0.2). Hiding an upgrade-only button in the UI
// is a courtesy; this is the part that actually holds, because anyone can call
// the endpoint directly with a valid org token.

// Resolves the workspace's effective plan onto req.plan. Runs after
// reqOrgOwnerAuth, so req.params.orgId is already proven to match the token.
async function attachPlan(req, res, next) {
    try {
        const orgId = req.params.orgId || (req.auth && req.auth.orgId);
        if (!orgId) return next();

        const resolved = await billingFunctions.getEffectivePlan({ orgId });
        if (!resolved.success) {
            // Fail open on a billing-lookup failure. Refusing paying customers
            // because the subscription read hiccuped is a worse outcome than
            // briefly serving someone a feature they no longer pay for.
            console.error("plan:attachPlan: could not resolve plan, failing open for orgId:", orgId);
            return next();
        }

        req.plan = resolved.plan;
        req.subscription = resolved.subscription;
        req.planDowngradeReason = resolved.downgradeReason;
        return next();
    } catch (error) {
        console.error("plan:attachPlan: Catch block");
        console.error(error);
        generalFunctions.captureException(error);
        return next();
    }
}

// Gate an entire route behind a capability.
function requireFeature(featureKey) {
    return function featureGate(req, res, next) {
        try {
            // attachPlan failed open and left no plan — do not compound one
            // outage into a second.
            if (!req.plan) return next();

            if (!planHasFeature(req.plan.id, featureKey)) {
                return res.status(402).json({
                    success: false,
                    error: `Your plan does not include ${featureKey.toLowerCase().replace(/_/g, " ")}`,
                    reason: LimitReason.PLAN_FEATURE,
                    data: { requiredFeature: featureKey, currentPlan: req.plan.id },
                });
            }
            return next();
        } catch (error) {
            console.error("plan:requireFeature: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
        }
    };
}

// Gate a create endpoint behind a countable limit. `countCurrent` receives the
// orgId and returns how many already exist, so this stays generic across
// sources, actions, tables and seats.
function requireCapacity(limitKey, countCurrent) {
    return async function capacityGate(req, res, next) {
        try {
            if (!req.plan) return next();

            const limit = req.plan.limits[limitKey];
            if (limit === UNLIMITED) return next();

            const orgId = req.params.orgId || (req.auth && req.auth.orgId);
            const used = await countCurrent(orgId);

            if (!isWithinLimit(used, limit)) {
                return res.status(402).json({
                    success: false,
                    error: `Your plan allows ${limit} ${limitKey}. Upgrade to add more.`,
                    reason: LimitReason.PLAN_LIMIT,
                    data: { limitKey, limit, used, currentPlan: req.plan.id },
                });
            }
            return next();
        } catch (error) {
            console.error("plan:requireCapacity: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
        }
    };
}

module.exports = { attachPlan, requireFeature, requireCapacity };
