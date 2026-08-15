const express = require("express");
const { FeatureKey } = require("../config/enums");
const expansionFunctions = require("../functions/expansion/expansionFunctions");
const copilotFunctions = require("../functions/copilot/copilotFunctions");
const procedureFunctions = require("../functions/procedure/procedureFunctions");
const connectorFunctions = require("../functions/knowledge/connectorFunctions");
const generalFunctions = require("../functions/utilFunctions/generalFunctions");
const { reqOrgOwnerAuth } = require("../middlewares/auth");
const { attachPlan, requireFeature } = require("../middlewares/plan");

const router = express.Router();

function fail(req, res, error) {
    console.error(`Expansion router ${req.path} catch block`);
    console.error(error);
    generalFunctions.captureException(error);
    return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
}

// ── Copilot (§5.1) ───────────────────────────────────────────────────
// Sold as seats, so it is plan-gated at the route as well as inside
// copilotFunctions — the command palette reaches the function directly.

router.get("/:orgId/copilot", reqOrgOwnerAuth, attachPlan, requireFeature(FeatureKey.COPILOT), async (req, res) => {
    try {
        const { status, json } = await copilotFunctions.getThread({
            orgId: req.params.orgId,
            conversationId: req.query.conversationId || null,
            memberEmail: req.auth.email,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/:orgId/copilot/ask", reqOrgOwnerAuth, attachPlan, requireFeature(FeatureKey.COPILOT), async (req, res) => {
    try {
        const { status, json } = await copilotFunctions.ask({
            orgId: req.params.orgId,
            conversationId: req.body.conversationId || null,
            memberEmail: req.auth.email,
            question: req.body.question,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

// AI Compose. Returns a draft and writes nothing to the customer conversation.
router.post("/:orgId/copilot/compose", reqOrgOwnerAuth, attachPlan, requireFeature(FeatureKey.COPILOT), async (req, res) => {
    try {
        const { status, json } = await copilotFunctions.compose({
            orgId: req.params.orgId,
            conversationId: req.body.conversationId,
            memberEmail: req.auth.email,
            instruction: req.body.instruction,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.delete("/:orgId/copilot", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await copilotFunctions.clearThread({
            orgId: req.params.orgId,
            conversationId: req.query.conversationId || null,
            memberEmail: req.auth.email,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

// ── Credential store (§5.3) ──────────────────────────────────────────

router.get("/:orgId/credentials", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await expansionFunctions.listCredentials({ orgId: req.params.orgId });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/:orgId/credentials", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await expansionFunctions.createCredential({
            orgId: req.params.orgId,
            name: req.body.name,
            type: req.body.type,
            secret: req.body.secret,
            headerName: req.body.headerName,
            username: req.body.username,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/:orgId/credentials/:credentialId/rotate", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await expansionFunctions.rotateCredential({
            orgId: req.params.orgId,
            credentialId: req.params.credentialId,
            secret: req.body.secret,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.delete("/:orgId/credentials/:credentialId", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await expansionFunctions.deleteCredential({
            orgId: req.params.orgId,
            credentialId: req.params.credentialId,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

// ── Procedures v2 (§5.4) ─────────────────────────────────────────────

router.get("/:orgId/procedures-v2", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await procedureFunctions.listProcedures({ orgId: req.params.orgId });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/:orgId/procedures-v2", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await procedureFunctions.createProcedure({
            orgId: req.params.orgId,
            name: req.body.name,
            description: req.body.description,
            triggerType: req.body.triggerType,
            keywords: req.body.keywords,
            intentDescription: req.body.intentDescription,
            eventName: req.body.eventName,
            steps: req.body.steps,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.patch("/:orgId/procedures-v2/:procedureId", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await procedureFunctions.updateProcedure({
            orgId: req.params.orgId,
            procedureId: req.params.procedureId,
            ...req.body,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.delete("/:orgId/procedures-v2/:procedureId", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await procedureFunctions.deleteProcedure({
            orgId: req.params.orgId,
            procedureId: req.params.procedureId,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/:orgId/procedures-v2/draft", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await procedureFunctions.draftFromProse({
            orgId: req.params.orgId,
            prose: req.body.prose,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/:orgId/procedures-v2/trigger", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await procedureFunctions.triggerByEvent({
            orgId: req.params.orgId,
            eventName: req.body.eventName,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

// ── Teams and assignment (§5.7) ──────────────────────────────────────

router.get("/:orgId/teams", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await expansionFunctions.listTeams({ orgId: req.params.orgId });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/:orgId/teams", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await expansionFunctions.createTeam({
            orgId: req.params.orgId,
            name: req.body.name,
            description: req.body.description,
            memberEmails: req.body.memberEmails,
            assignmentRules: req.body.assignmentRules,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.delete("/:orgId/teams/:teamId", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await expansionFunctions.deleteTeam({
            orgId: req.params.orgId,
            teamId: req.params.teamId,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/:orgId/conversations/:conversationId/assign", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await expansionFunctions.assignConversation({
            orgId: req.params.orgId,
            conversationId: req.params.conversationId,
            assignedTo: req.body.assignedTo,
            teamId: req.body.teamId,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/:orgId/teams/auto-assign", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await expansionFunctions.autoAssign({ orgId: req.params.orgId });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

// ── Macros (§5.8) ────────────────────────────────────────────────────

router.get("/:orgId/macros", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await expansionFunctions.listMacros({ orgId: req.params.orgId, role: req.query.role });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/:orgId/macros", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await expansionFunctions.createMacro({
            orgId: req.params.orgId,
            name: req.body.name,
            shortcut: req.body.shortcut,
            body: req.body.body,
            visibleToRoles: req.body.visibleToRoles,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.delete("/:orgId/macros/:macroId", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await expansionFunctions.deleteMacro({
            orgId: req.params.orgId,
            macroId: req.params.macroId,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/:orgId/macros/:macroId/render", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await expansionFunctions.renderMacro({
            orgId: req.params.orgId,
            macroId: req.params.macroId,
            conversationId: req.body.conversationId,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

// ── Migration connectors (§5.5) ──────────────────────────────────────

router.get("/:orgId/connectors", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = connectorFunctions.listConnectors();
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/:orgId/connectors/import", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await connectorFunctions.importFrom({
            orgId: req.params.orgId,
            connector: req.body.connector,
            config: req.body.config,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

module.exports = router;
