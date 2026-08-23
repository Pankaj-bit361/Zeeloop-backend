const express = require("express");
const knowledgeFunctions = require("../functions/knowledge/knowledgeFunctions");
const generalFunctions = require("../functions/utilFunctions/generalFunctions");
const { reqOrgOwnerAuth } = require("../middlewares/auth");
const { sourceCapacity } = require("../middlewares/planGates");

const router = express.Router();

router.get("/:orgId/sources", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await knowledgeFunctions.listSources({ orgId: req.params.orgId });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Knowledge router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.post("/:orgId/sitemap/discover", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await knowledgeFunctions.discoverSitemap({
            orgId: req.params.orgId,
            url: req.body.url,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Knowledge router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.post("/:orgId/sources", reqOrgOwnerAuth, ...sourceCapacity, async (req, res) => {
    try {
        const { status, json } = await knowledgeFunctions.createSource({
            orgId: req.params.orgId,
            type: req.body.type,
            name: req.body.name,
            url: req.body.url,
            content: req.body.content,
            includedUrls: req.body.includedUrls,
            contentSelector: req.body.contentSelector,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Knowledge router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.patch("/:orgId/sources/:sourceId", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await knowledgeFunctions.updateSource({
            orgId: req.params.orgId,
            sourceId: req.params.sourceId,
            name: req.body.name,
            content: req.body.content,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Knowledge router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.delete("/:orgId/sources/:sourceId", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await knowledgeFunctions.deleteSource({
            orgId: req.params.orgId,
            sourceId: req.params.sourceId,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Knowledge router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.post("/:orgId/sources/:sourceId/resync", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await knowledgeFunctions.resyncSource({
            orgId: req.params.orgId,
            sourceId: req.params.sourceId,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Knowledge router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.get("/:orgId/chunks", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await knowledgeFunctions.listChunks({
            orgId: req.params.orgId,
            sourceId: req.query.sourceId,
            page: req.query.page,
            limit: req.query.limit,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Knowledge router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

module.exports = router;
