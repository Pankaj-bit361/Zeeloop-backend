const express = require("express");
const { reqOrgOwnerAuth, requireRole, OWNER_OR_ADMIN } = require("../middlewares/auth");
const complianceFunctions = require("../functions/compliance/complianceFunctions");
const generalFunctions = require("../functions/utilFunctions/generalFunctions");

const router = express.Router();

router.get("/:orgId/export", reqOrgOwnerAuth, requireRole(...OWNER_OR_ADMIN), async (req, res) => {
    try {
        const { status, json } = await complianceFunctions.exportWorkspace({ orgId: req.params.orgId });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Compliance router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

// DELETE rather than POST: this is a deletion, and making it read like one in
// the access logs matters when someone is auditing who erased what.
router.delete("/:orgId/end-users/:endUserId", reqOrgOwnerAuth, requireRole(...OWNER_OR_ADMIN), async (req, res) => {
    try {
        const { status, json } = await complianceFunctions.eraseEndUser({
            orgId: req.params.orgId,
            endUserId: req.params.endUserId,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Compliance router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

module.exports = router;
