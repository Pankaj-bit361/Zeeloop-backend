const express = require("express");
const batchTestFunctions = require("../functions/eval/batchTestFunctions");
const simulationFunctions = require("../functions/eval/simulationFunctions");
const qualityFunctions = require("../functions/eval/qualityFunctions");
const recommendationFunctions = require("../functions/eval/recommendationFunctions");
const monitorFunctions = require("../functions/eval/monitorFunctions");
const conversationSearchFunctions = require("../functions/eval/conversationSearchFunctions");
const generalFunctions = require("../functions/utilFunctions/generalFunctions");
const { reqOrgOwnerAuth } = require("../middlewares/auth");

const router = express.Router();

function fail(req, res, error) {
    console.error(`Eval router ${req.path} catch block`);
    console.error(error);
    generalFunctions.captureException(error);
    return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
}

// ── Batch tests (§3.1) ───────────────────────────────────────────────

router.get("/:orgId/batch-tests", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await batchTestFunctions.list({ orgId: req.params.orgId });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/:orgId/batch-tests", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await batchTestFunctions.create({
            orgId: req.params.orgId,
            name: req.body.name,
            description: req.body.description,
            questions: req.body.questions,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.get("/:orgId/batch-tests/:batchTestId", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await batchTestFunctions.get({
            orgId: req.params.orgId,
            batchTestId: req.params.batchTestId,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.delete("/:orgId/batch-tests/:batchTestId", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await batchTestFunctions.remove({
            orgId: req.params.orgId,
            batchTestId: req.params.batchTestId,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/:orgId/batch-tests/:batchTestId/questions", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await batchTestFunctions.addQuestions({
            orgId: req.params.orgId,
            batchTestId: req.params.batchTestId,
            questions: req.body.questions,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

// Solves the cold start — see batchTestFunctions.generateQuestions.
router.post("/:orgId/batch-tests/:batchTestId/generate", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await batchTestFunctions.generateQuestions({
            orgId: req.params.orgId,
            batchTestId: req.params.batchTestId,
            limit: req.body.limit,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.patch("/:orgId/batch-tests/:batchTestId/questions/:questionId", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await batchTestFunctions.rateQuestion({
            orgId: req.params.orgId,
            batchTestId: req.params.batchTestId,
            questionId: req.params.questionId,
            rating: req.body.rating,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.delete("/:orgId/batch-tests/:batchTestId/questions/:questionId", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await batchTestFunctions.deleteQuestion({
            orgId: req.params.orgId,
            batchTestId: req.params.batchTestId,
            questionId: req.params.questionId,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/:orgId/batch-tests/:batchTestId/run", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await batchTestFunctions.run({
            orgId: req.params.orgId,
            batchTestId: req.params.batchTestId,
            target: req.body.target,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

// ── Simulations (§3.2) ───────────────────────────────────────────────

router.get("/:orgId/simulations", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await simulationFunctions.list({ orgId: req.params.orgId });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/:orgId/simulations", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await simulationFunctions.create({
            orgId: req.params.orgId,
            name: req.body.name,
            description: req.body.description,
            persona: req.body.persona,
            criteria: req.body.criteria,
            expectedOutcome: req.body.expectedOutcome,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.delete("/:orgId/simulations/:simulationId", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await simulationFunctions.remove({
            orgId: req.params.orgId,
            simulationId: req.params.simulationId,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/:orgId/simulations/:simulationId/run", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await simulationFunctions.run({
            orgId: req.params.orgId,
            simulationId: req.params.simulationId,
            target: req.body.target,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

// The regression suite: every simulation in the workspace, one config flip.
router.post("/:orgId/simulations/run-all", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await simulationFunctions.runAll({
            orgId: req.params.orgId,
            target: req.body.target,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

// ── Quality (§3.4) ───────────────────────────────────────────────────

router.get("/:orgId/quality", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await qualityFunctions.getQualitySummary({
            orgId: req.params.orgId,
            days: req.query.days,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

// ── Recommendations (§3.5) ───────────────────────────────────────────

router.get("/:orgId/recommendations", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await recommendationFunctions.listRecommendations({ orgId: req.params.orgId });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

// On demand rather than on a cron — it costs an embedding call per distinct gap.
router.post("/:orgId/recommendations/compute", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await recommendationFunctions.computeRecommendations({ orgId: req.params.orgId });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/:orgId/recommendations/:recommendationId/create-snippet", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await recommendationFunctions.createSnippetFromRecommendation({
            orgId: req.params.orgId,
            recommendationId: req.params.recommendationId,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/:orgId/recommendations/:recommendationId/dismiss", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await recommendationFunctions.dismiss({
            orgId: req.params.orgId,
            recommendationId: req.params.recommendationId,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

// ── Monitors and the review queue (§3.6) ─────────────────────────────

router.get("/:orgId/monitors", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await monitorFunctions.listMonitors({ orgId: req.params.orgId });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/:orgId/monitors", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await monitorFunctions.createMonitor({
            orgId: req.params.orgId,
            name: req.body.name,
            trigger: req.body.trigger,
            keywords: req.body.keywords,
            samplePercent: req.body.samplePercent,
            scoreBelow: req.body.scoreBelow,
            scorecard: req.body.scorecard,
            assignTo: req.body.assignTo,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.delete("/:orgId/monitors/:monitorId", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await monitorFunctions.deleteMonitor({
            orgId: req.params.orgId,
            monitorId: req.params.monitorId,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/:orgId/monitors/sweep", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await monitorFunctions.runSweep({ orgId: req.params.orgId });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.get("/:orgId/reviews", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await monitorFunctions.listQueue({
            orgId: req.params.orgId,
            status: req.query.status,
            assignedTo: req.query.assignedTo,
            page: req.query.page,
            limit: req.query.limit,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/:orgId/reviews/:reviewId", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await monitorFunctions.submitReview({
            orgId: req.params.orgId,
            reviewId: req.params.reviewId,
            scores: req.body.scores,
            note: req.body.note,
            status: req.body.status,
            reviewerEmail: req.auth.email,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/:orgId/reviews/:reviewId/promote", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await monitorFunctions.promoteToSimulation({
            orgId: req.params.orgId,
            reviewId: req.params.reviewId,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

// ── Conversation search and saved views (§3.7) ───────────────────────

// POST rather than GET: the filter object is nested (attribute pairs, date
// ranges) and encoding that into a query string produces something nobody can
// read in a log or reproduce by hand.
router.post("/:orgId/conversations/search", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await conversationSearchFunctions.search({
            orgId: req.params.orgId,
            filters: req.body.filters,
            page: req.body.page,
            limit: req.body.limit,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.get("/:orgId/views", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await conversationSearchFunctions.listViews({ orgId: req.params.orgId });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/:orgId/views", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await conversationSearchFunctions.saveView({
            orgId: req.params.orgId,
            name: req.body.name,
            filters: req.body.filters,
            createdBy: req.auth.email,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

router.delete("/:orgId/views/:savedViewId", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await conversationSearchFunctions.deleteView({
            orgId: req.params.orgId,
            savedViewId: req.params.savedViewId,
        });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

module.exports = router;
