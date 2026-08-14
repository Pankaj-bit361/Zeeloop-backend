const express = require("express");
const orgFunctions = require("../functions/org/orgFunctions");
const userFunctions = require("../functions/user/userFunctions");
const memberFunctions = require("../functions/member/memberFunctions");
const generalFunctions = require("../functions/utilFunctions/generalFunctions");
const { reqOrgOwnerAuth } = require("../middlewares/auth");
const { seatCapacity } = require("../middlewares/planGates");

const router = express.Router();

router.get("/:orgId/settings", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await orgFunctions.getSettings({ orgId: req.params.orgId });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Org router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.patch("/:orgId/settings", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await orgFunctions.updateSettings({
            orgId: req.params.orgId,
            name: req.body.name,
            website: req.body.website,
            agentName: req.body.agentName,
            greeting: req.body.greeting,
            language: req.body.language,
            escalationMode: req.body.escalationMode,
            escalationEmail: req.body.escalationEmail,
            widgetPosition: req.body.widgetPosition,
            allowedOrigins: req.body.allowedOrigins,
            widgetTheme: req.body.widgetTheme,
            widgetAccentColor: req.body.widgetAccentColor,
            widgetBackground: req.body.widgetBackground,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Org router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.post("/:orgId/widget-secret/reveal", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await orgFunctions.revealSecret({ orgId: req.params.orgId });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Org router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.post("/:orgId/widget-secret/rotate", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await orgFunctions.rotateSecret({ orgId: req.params.orgId });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Org router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.get("/:orgId/onboarding", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await orgFunctions.getOnboarding({ orgId: req.params.orgId });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Org router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.get("/:orgId/me", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await memberFunctions.getMe({ orgId: req.params.orgId, email: req.auth.email });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Org router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.patch("/:orgId/me", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await memberFunctions.updateMe({
            orgId: req.params.orgId,
            email: req.auth.email,
            name: req.body.name,
            designation: req.body.designation,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Org router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.get("/:orgId/members", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await memberFunctions.listMembers({ orgId: req.params.orgId });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Org router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.post("/:orgId/members", reqOrgOwnerAuth, ...seatCapacity, async (req, res) => {
    try {
        const { status, json } = await memberFunctions.inviteMember({
            orgId: req.params.orgId,
            email: req.body.email,
            role: req.body.role,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Org router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.delete("/:orgId/members/:memberId", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await memberFunctions.removeMember({
            orgId: req.params.orgId,
            memberId: req.params.memberId,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Org router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.get("/:orgId/users", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await userFunctions.listUsers({
            orgId: req.params.orgId,
            verified: req.query.verified,
            search: req.query.search,
            page: req.query.page,
            limit: req.query.limit,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Org router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.get("/:orgId/users/:endUserId", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await userFunctions.getUser({
            orgId: req.params.orgId,
            endUserId: req.params.endUserId,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Org router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

module.exports = router;
