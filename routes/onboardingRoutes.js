const express = require("express");
const wizardFunctions = require("../functions/onboarding/wizardFunctions");
const brandfetchFunctions = require("../functions/onboarding/brandfetchFunctions");
const knowledgeFunctions = require("../functions/knowledge/knowledgeFunctions");
const crawlWorker = require("../functions/knowledge/crawlWorker");
const generalFunctions = require("../functions/utilFunctions/generalFunctions");
const { reqOrgOwnerAuth } = require("../middlewares/auth");
const { sourceCapacity } = require("../middlewares/planGates");

const router = express.Router();

function fail(req, res, error) {
    console.error(`Onboarding router ${req.path} catch block`);
    console.error(error);
    generalFunctions.captureException(error);
    return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
}

// ── Setup wizard (§1.6) ──────────────────────────────────────────────

router.get("/:orgId/wizard", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await wizardFunctions.getWizardState({ orgId: req.params.orgId });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

// Step 1 — brand lookup. Returns a proposal; nothing is applied until the
// customer confirms in the dialog (§1.7).
router.post("/:orgId/wizard/brand", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await brandfetchFunctions.importBrand({ domain: req.body.domain });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/:orgId/wizard/domain", reqOrgOwnerAuth, ...sourceCapacity, async (req, res) => {
    try {
        const { status, json } = await wizardFunctions.applyDomain({
            orgId: req.params.orgId,
            domain: req.body.domain,
            brand: req.body.brand,
            startSync: req.body.startSync,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

// Steps 2 and 3 — prose in, structured objects out. Returns a proposal.
router.post("/:orgId/wizard/generate", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await wizardFunctions.generateFromProse({
            orgId: req.params.orgId,
            prose: req.body.prose,
            useDefaults: req.body.useDefaults,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

// Step 4 → the customer's edited proposal becomes real configuration objects.
router.post("/:orgId/wizard/apply", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await wizardFunctions.applyGeneration({
            orgId: req.params.orgId,
            guidance: req.body.guidance,
            escalation: req.body.escalation,
            businessContext: req.body.businessContext,
            issueTypes: req.body.issueTypes,
            agent: req.body.agent,
            actorEmail: req.auth.email,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

// Step 5 — polled until the widget is actually seen.
router.get("/:orgId/wizard/install", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await wizardFunctions.checkInstall({ orgId: req.params.orgId });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

// ── Onboarding checklist (§1.8) ──────────────────────────────────────

router.get("/:orgId/checklist", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await wizardFunctions.getChecklist({ orgId: req.params.orgId });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/:orgId/checklist/dismiss", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await wizardFunctions.dismissChecklist({
            orgId: req.params.orgId,
            dismissed: req.body.dismissed,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

// ── File ingest (§1.2) ───────────────────────────────────────────────

// Base64 in a JSON body rather than multipart. The whole API is JSON, adding
// multer for one endpoint means a second body-parsing path with its own limits
// and its own failure modes, and the size cap here is well inside what JSON
// handles. See MAX_UPLOAD_BYTES.
router.post("/:orgId/knowledge/upload", reqOrgOwnerAuth, ...sourceCapacity, async (req, res) => {
    try {
        const { status, json } = await knowledgeFunctions.uploadFile({
            orgId: req.params.orgId,
            filename: req.body.filename,
            mimeType: req.body.mimeType,
            base64: req.body.base64,
            name: req.body.name,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

// Re-upload. Replaces the source's content rather than creating a second one,
// so a workspace does not end up with three copies of the same handbook in the
// retrieval index.
router.put("/:orgId/knowledge/sources/:sourceId/file", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await knowledgeFunctions.uploadFile({
            orgId: req.params.orgId,
            sourceId: req.params.sourceId,
            filename: req.body.filename,
            mimeType: req.body.mimeType,
            base64: req.body.base64,
            name: req.body.name,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

// ── Crawl jobs (§1.3, §1.4) ──────────────────────────────────────────

router.get("/:orgId/knowledge/sources/:sourceId/crawl", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await crawlWorker.getStatus({
            orgId: req.params.orgId,
            sourceId: req.params.sourceId,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/:orgId/knowledge/sources/:sourceId/crawl", reqOrgOwnerAuth, async (req, res) => {
    try {
        const result = await crawlWorker.enqueue({
            orgId: req.params.orgId,
            sourceId: req.params.sourceId,
        });
        if (!result.success) {
            return res.status(500).json({ success: false, error: "Could not queue the crawl" });
        }
        return res.status(202).json({ success: true, data: result });
    } catch (error) {
        return fail(req, res, error);
    }
});

router.delete("/:orgId/crawl-jobs/:crawlJobId", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await crawlWorker.cancel({
            orgId: req.params.orgId,
            crawlJobId: req.params.crawlJobId,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.patch("/:orgId/knowledge/sources/:sourceId/schedule", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await knowledgeFunctions.updateSchedule({
            orgId: req.params.orgId,
            sourceId: req.params.sourceId,
            syncSchedule: req.body.syncSchedule,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

module.exports = router;
