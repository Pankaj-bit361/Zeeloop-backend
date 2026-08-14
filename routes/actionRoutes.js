const express = require("express");
const actionFunctions = require("../functions/action/actionFunctions");
const generalFunctions = require("../functions/utilFunctions/generalFunctions");
const { reqOrgOwnerAuth } = require("../middlewares/auth");

const router = express.Router();

router.get("/:orgId/actions", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await actionFunctions.listActions({ orgId: req.params.orgId });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Action router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.post("/:orgId/actions", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await actionFunctions.createAction({
            orgId: req.params.orgId,
            name: req.body.name,
            description: req.body.description,
            accessType: req.body.accessType,
            method: req.body.method,
            urlTemplate: req.body.urlTemplate,
            params: req.body.params,
            headers: req.body.headers,
            secret: req.body.secret,
            requiresIdentity: req.body.requiresIdentity,
            requiresConfirmation: req.body.requiresConfirmation,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Action router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.patch("/:orgId/actions/:actionId", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await actionFunctions.updateAction({
            orgId: req.params.orgId,
            actionId: req.params.actionId,
            name: req.body.name,
            description: req.body.description,
            accessType: req.body.accessType,
            method: req.body.method,
            urlTemplate: req.body.urlTemplate,
            params: req.body.params,
            headers: req.body.headers,
            secret: req.body.secret,
            enabled: req.body.enabled,
            requiresIdentity: req.body.requiresIdentity,
            requiresConfirmation: req.body.requiresConfirmation,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Action router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.delete("/:orgId/actions/:actionId", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await actionFunctions.deleteAction({
            orgId: req.params.orgId,
            actionId: req.params.actionId,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Action router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.post("/:orgId/actions/:actionId/test", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await actionFunctions.testAction({
            orgId: req.params.orgId,
            actionId: req.params.actionId,
            args: req.body.args,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Action router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

module.exports = router;
