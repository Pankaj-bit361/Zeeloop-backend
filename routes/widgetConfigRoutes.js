const express = require("express");
const widgetConfigFunctions = require("../functions/widget/widgetConfigFunctions");
const emailFunctions = require("../functions/email/emailFunctions");
const inboundEmailFunctions = require("../functions/email/inboundEmailFunctions");
const generalFunctions = require("../functions/utilFunctions/generalFunctions");
const Org = require("../models/org/org");
const { reqOrgOwnerAuth } = require("../middlewares/auth");

const router = express.Router();

function fail(req, res, error) {
    console.error(`Widget config router ${req.path} catch block`);
    console.error(error);
    generalFunctions.captureException(error);
    return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
}

// ── Appearance, home screen, welcome, launcher (§4.1–§4.5) ───────────

router.get("/:orgId/widget-config", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await widgetConfigFunctions.getConfig({ orgId: req.params.orgId });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.patch("/:orgId/widget-config", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await widgetConfigFunctions.updateConfig({
            orgId: req.params.orgId,
            widget: req.body.widget,
            actorEmail: req.auth.email,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

// The header text colour, with the reason it was chosen. Exposed so the
// dashboard can show "computed from your accent colour" or prompt for a manual
// choice on a gradient (§4.5) rather than silently rendering unreadable text.
router.get("/:orgId/widget-config/header-color", reqOrgOwnerAuth, async (req, res) => {
    try {
        const org = await Org.findOne({ orgId: req.params.orgId }).lean();
        if (!org) return res.status(404).json({ success: false, error: "Org not found" });
        return res.status(200).json({ success: true, data: widgetConfigFunctions.resolveHeaderTextColor({ org }) });
    } catch (error) {
        return fail(req, res, error);
    }
});

// Answers "why is my launcher not showing on this page" without a support
// ticket — the reason string is the whole point.
router.post("/:orgId/widget-config/launcher-preview", reqOrgOwnerAuth, async (req, res) => {
    try {
        const org = await Org.findOne({ orgId: req.params.orgId }).lean();
        if (!org) return res.status(404).json({ success: false, error: "Org not found" });

        const result = await widgetConfigFunctions.shouldShowLauncher({
            org,
            pageUrl: req.body.pageUrl,
            identityVerified: req.body.identityVerified === true,
            endUser: req.body.endUser || null,
            pageSettings: req.body.pageSettings || null,
        });
        return res.status(200).json({ success: true, data: result });
    } catch (error) {
        return fail(req, res, error);
    }
});

// ── Email channel (§4.8) ─────────────────────────────────────────────

// The address a workspace publishes, plus whether sending is actually wired up.
// Both, because an address with no configured provider accepts mail and never
// replies, and discovering that from silence is the worst way to discover it.
router.get("/:orgId/email-channel", reqOrgOwnerAuth, async (req, res) => {
    try {
        const org = await Org.findOne({ orgId: req.params.orgId }).lean();
        if (!org) return res.status(404).json({ success: false, error: "Org not found" });

        return res.status(200).json({
            success: true,
            data: {
                inboundAddress: inboundEmailFunctions.inboundAddress({ org }),
                outboundConfigured: !!require("../config/config").EMAIL_API_KEY,
                inboundConfigured: !!require("../config/config").EMAIL_INBOUND_SECRET,
            },
        });
    } catch (error) {
        return fail(req, res, error);
    }
});

router.get("/:orgId/email-log", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await emailFunctions.listLog({
            orgId: req.params.orgId,
            limit: req.query.limit,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

module.exports = router;
