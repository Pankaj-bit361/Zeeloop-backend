const express = require("express");
const { reqOrgOwnerAuth, requireRole, OWNER_OR_ADMIN } = require("../middlewares/auth");
const billingFunctions = require("../functions/billing/billingFunctions");
const usageFunctions = require("../functions/billing/usageFunctions");
const generalFunctions = require("../functions/utilFunctions/generalFunctions");
const geoFunctions = require("../functions/utilFunctions/geoFunctions");

const router = express.Router();

router.get("/:orgId/billing", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await billingFunctions.getBilling({
            orgId: req.params.orgId,
            country: geoFunctions.countryFromRequest(req),
        });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Billing router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.get("/:orgId/billing/usage", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await usageFunctions.listHistory({
            orgId: req.params.orgId,
            limit: req.query.limit,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Billing router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.post("/:orgId/billing/checkout", reqOrgOwnerAuth, requireRole(...OWNER_OR_ADMIN), async (req, res) => {
    try {
        const { status, json } = await billingFunctions.createCheckout({
            orgId: req.params.orgId,
            planId: req.body.planId,
            email: req.body.email,
            name: req.body.name,
            country: geoFunctions.countryFromRequest(req),
        });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Billing router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.patch("/:orgId/billing/currency", reqOrgOwnerAuth, requireRole(...OWNER_OR_ADMIN), async (req, res) => {
    try {
        const { status, json } = await billingFunctions.setCurrency({
            orgId: req.params.orgId,
            currency: req.body.currency,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Billing router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.post("/:orgId/billing/cancel", reqOrgOwnerAuth, requireRole(...OWNER_OR_ADMIN), async (req, res) => {
    try {
        const { status, json } = await billingFunctions.cancelSubscription({ orgId: req.params.orgId });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Billing router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

module.exports = router;
