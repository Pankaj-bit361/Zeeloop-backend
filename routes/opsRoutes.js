const express = require("express");
const expansionFunctions = require("../functions/expansion/expansionFunctions");
const auditFunctions = require("../functions/audit/auditFunctions");
const outboundWebhookFunctions = require("../functions/webhook/outboundWebhookFunctions");
const securityFunctions = require("../functions/security/securityFunctions");
const generalFunctions = require("../functions/utilFunctions/generalFunctions");
const { reqOrgOwnerAuth } = require("../middlewares/auth");

const router = express.Router();

function fail(req, res, error) {
    console.error(`Ops router ${req.path} catch block`);
    console.error(error);
    generalFunctions.captureException(error);
    return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
}

// ── Audit log (§8.4) ─────────────────────────────────────────────────
// Read-only by design. There is no write endpoint and no delete endpoint — an
// audit log an admin can edit answers no question worth asking.

router.get("/:orgId/audit-log", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await auditFunctions.list({
            orgId: req.params.orgId,
            action: req.query.action,
            page: req.query.page,
            limit: req.query.limit,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

// ── Blocklist (§8.2) ─────────────────────────────────────────────────

router.get("/:orgId/blocklist", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await expansionFunctions.listBlocklist({ orgId: req.params.orgId });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/:orgId/blocklist", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await expansionFunctions.addBlocklistEntry({
            orgId: req.params.orgId,
            type: req.body.type,
            value: req.body.value,
            reason: req.body.reason,
            expiresAt: req.body.expiresAt,
            actorEmail: req.auth.email,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.delete("/:orgId/blocklist/:blocklistEntryId", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await expansionFunctions.removeBlocklistEntry({
            orgId: req.params.orgId,
            blocklistEntryId: req.params.blocklistEntryId,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

// ── Origin allowlist and secret rotation (§8.4) ──────────────────────

router.get("/:orgId/security", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await securityFunctions.getSecuritySettings({ orgId: req.params.orgId });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.patch("/:orgId/security/origins", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await securityFunctions.updateOriginAllowlist({
            orgId: req.params.orgId,
            allowedOrigins: req.body.allowedOrigins,
            enforce: req.body.enforce,
            actorEmail: req.auth.email,
            ip: req.ip,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

// Rotation with a grace window: the old secret keeps working while the customer
// deploys their new signing code (§8.4).
router.post("/:orgId/security/rotate-secret", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await securityFunctions.rotateWidgetSecret({
            orgId: req.params.orgId,
            actorEmail: req.auth.email,
            ip: req.ip,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

// Ends the grace window early, for a rotation done because the old secret
// leaked — where "it keeps working for 48 hours" is the opposite of what is
// wanted.
router.post("/:orgId/security/revoke-previous-secret", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await securityFunctions.revokePreviousSecret({
            orgId: req.params.orgId,
            actorEmail: req.auth.email,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

// ── Outbound webhooks (§5.6) ─────────────────────────────────────────

router.get("/:orgId/webhooks", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await outboundWebhookFunctions.list({ orgId: req.params.orgId });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/:orgId/webhooks", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await outboundWebhookFunctions.create({
            orgId: req.params.orgId,
            url: req.body.url,
            events: req.body.events,
            actorEmail: req.auth.email,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.delete("/:orgId/webhooks/:outboundWebhookId", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await outboundWebhookFunctions.remove({
            orgId: req.params.orgId,
            outboundWebhookId: req.params.outboundWebhookId,
            actorEmail: req.auth.email,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

module.exports = router;
