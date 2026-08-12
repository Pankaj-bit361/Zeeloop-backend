const express = require("express");
const analyticsFunctions = require("../functions/analytics/analyticsFunctions");
const generalFunctions = require("../functions/utilFunctions/generalFunctions");
const { reqOrgOwnerAuth } = require("../middlewares/auth");

const router = express.Router();

router.get("/:orgId/overview", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await analyticsFunctions.getOverview({
            orgId: req.params.orgId,
            days: req.query.days,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.log(`Analytics router ${req.path} catch block`);
        console.log(error);
        generalFunctions.captureSentryException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.get("/:orgId/content-gaps", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await analyticsFunctions.getContentGaps({
            orgId: req.params.orgId,
            days: req.query.days,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.log(`Analytics router ${req.path} catch block`);
        console.log(error);
        generalFunctions.captureSentryException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

module.exports = router;
