const express = require("express");
const { ConfigObjectType } = require("../config/enums");
const configFunctions = require("../functions/config/configFunctions");
const guidanceFunctions = require("../functions/config/guidanceFunctions");
const segmentFunctions = require("../functions/config/segmentFunctions");
const attributeFunctions = require("../functions/config/attributeFunctions");
const orgConfigFunctions = require("../functions/config/orgConfigFunctions");
const generalFunctions = require("../functions/utilFunctions/generalFunctions");
const { reqOrgOwnerAuth } = require("../middlewares/auth");

const router = express.Router();

// §2 — the configuration surface. Guidance rules, escalation rules, escalation
// guidance and attributes are all served by ONE set of handlers parameterised by
// `:objectType`, because configFunctions is registry-driven and four
// near-identical route files would be four places to forget a fix.
//
// The URL segment is the lowercase, hyphenated form of the enum — /guidance-rules
// rather than /GUIDANCE_RULE — because it is a URL. The mapping is explicit
// rather than computed, so a rename in the enum cannot silently change a public
// path.
const TYPE_BY_PATH = {
    "guidance-rules": ConfigObjectType.GUIDANCE_RULE,
    "escalation-rules": ConfigObjectType.ESCALATION_RULE,
    "escalation-guidance": ConfigObjectType.ESCALATION_GUIDANCE,
    "attributes": ConfigObjectType.ATTRIBUTE,
};

// Resolves :objectType once, so no handler has to remember to. An unknown
// segment 404s here rather than reaching a function that would return a
// confusing 400 about configuration types.
function resolveType(req, res, next) {
    const objectType = TYPE_BY_PATH[req.params.objectType];
    if (!objectType) {
        return res.status(404).json({ success: false, error: "Unknown configuration type" });
    }
    req.objectType = objectType;
    return next();
}

function fail(req, res, error) {
    console.error(`Config router ${req.path} catch block`);
    console.error(error);
    generalFunctions.captureException(error);
    return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
}

// ── Suggestion chips ─────────────────────────────────────────────────
// Served from the backend so the dashboard and the prompt composer cannot drift
// apart on what a category means (§2.1).
router.get("/:orgId/config/suggestions", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await guidanceFunctions.listSuggestions();
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

// ── Agent identity, tone and business context (§2.7, §2.8) ───────────
router.get("/:orgId/config/agent", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await orgConfigFunctions.getAgentConfig({ orgId: req.params.orgId });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.patch("/:orgId/config/agent", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await orgConfigFunctions.updateAgentConfig({
            orgId: req.params.orgId,
            agent: req.body.agent,
            businessContext: req.body.businessContext,
            actorEmail: req.auth.email,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

// ── Segments (§2.6) ──────────────────────────────────────────────────
router.get("/:orgId/config/segments", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await segmentFunctions.listSegments({ orgId: req.params.orgId });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/:orgId/config/segments", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await segmentFunctions.createSegment({
            orgId: req.params.orgId,
            name: req.body.name,
            description: req.body.description,
            conditions: req.body.conditions,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.patch("/:orgId/config/segments/:segmentId", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await segmentFunctions.updateSegment({
            orgId: req.params.orgId,
            segmentId: req.params.segmentId,
            name: req.body.name,
            description: req.body.description,
            conditions: req.body.conditions,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.delete("/:orgId/config/segments/:segmentId", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await segmentFunctions.deleteSegment({
            orgId: req.params.orgId,
            segmentId: req.params.segmentId,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

// ── Attribute values on a conversation (§2.3) ────────────────────────
// Mounted before the generic :objectType routes so "attributes" as a type and
// this specific path cannot collide.
router.put("/:orgId/conversations/:conversationId/attributes/:attributeId", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await attributeFunctions.setValue({
            orgId: req.params.orgId,
            conversationId: req.params.conversationId,
            attributeId: req.params.attributeId,
            // Explicitly allowed to be null — that is how a value is cleared.
            value: req.body.value === undefined ? null : req.body.value,
            actorEmail: req.auth.email,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

// ── Generic config CRUD ──────────────────────────────────────────────
router.get("/:orgId/config/:objectType", reqOrgOwnerAuth, resolveType, async (req, res) => {
    try {
        const { status, json } = await configFunctions.list({
            orgId: req.params.orgId,
            objectType: req.objectType,
            publishState: req.query.publishState,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/:orgId/config/:objectType", reqOrgOwnerAuth, resolveType, async (req, res) => {
    try {
        const { status, json } = await configFunctions.create({
            orgId: req.params.orgId,
            objectType: req.objectType,
            body: req.body,
            actorEmail: req.auth.email,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.get("/:orgId/config/:objectType/:objectId", reqOrgOwnerAuth, resolveType, async (req, res) => {
    try {
        const { status, json } = await configFunctions.get({
            orgId: req.params.orgId,
            objectType: req.objectType,
            objectId: req.params.objectId,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.patch("/:orgId/config/:objectType/:objectId", reqOrgOwnerAuth, resolveType, async (req, res) => {
    try {
        const { status, json } = await configFunctions.update({
            orgId: req.params.orgId,
            objectType: req.objectType,
            objectId: req.params.objectId,
            body: req.body,
            actorEmail: req.auth.email,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.delete("/:orgId/config/:objectType/:objectId", reqOrgOwnerAuth, resolveType, async (req, res) => {
    try {
        const { status, json } = await configFunctions.remove({
            orgId: req.params.orgId,
            objectType: req.objectType,
            objectId: req.params.objectId,
            actorEmail: req.auth.email,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

// ── Draft / live (§2.4) ──────────────────────────────────────────────
router.post("/:orgId/config/:objectType/:objectId/publish", reqOrgOwnerAuth, resolveType, async (req, res) => {
    try {
        const { status, json } = await configFunctions.publish({
            orgId: req.params.orgId,
            objectType: req.objectType,
            objectId: req.params.objectId,
            enabled: req.body.enabled,
            actorEmail: req.auth.email,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/:orgId/config/:objectType/:objectId/unpublish", reqOrgOwnerAuth, resolveType, async (req, res) => {
    try {
        const { status, json } = await configFunctions.unpublish({
            orgId: req.params.orgId,
            objectType: req.objectType,
            objectId: req.params.objectId,
            actorEmail: req.auth.email,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

// ── Version history (§2.5) ───────────────────────────────────────────
router.get("/:orgId/config/:objectType/:objectId/versions", reqOrgOwnerAuth, resolveType, async (req, res) => {
    try {
        const { status, json } = await configFunctions.listVersions({
            orgId: req.params.orgId,
            objectType: req.objectType,
            objectId: req.params.objectId,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/:orgId/config/:objectType/:objectId/restore/:version", reqOrgOwnerAuth, resolveType, async (req, res) => {
    try {
        const { status, json } = await configFunctions.restore({
            orgId: req.params.orgId,
            objectType: req.objectType,
            objectId: req.params.objectId,
            version: req.params.version,
            actorEmail: req.auth.email,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

module.exports = router;
module.exports.TYPE_BY_PATH = TYPE_BY_PATH;
