const express = require("express");
const chatFunctions = require("../functions/chat/chatFunctions");
const generalFunctions = require("../functions/utilFunctions/generalFunctions");

const router = express.Router();

router.post("/bootstrap", async (req, res) => {
    try {
        const { status, json } = await chatFunctions.bootstrap({
            publicKey: req.body.publicKey,
            conversationId: req.body.conversationId,
            identity: req.body.identity,
            accentColor: req.body.accentColor,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.log(`Widget router ${req.path} catch block`);
        console.log(error);
        generalFunctions.captureSentryException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.post("/messages", async (req, res) => {
    try {
        const { status, json } = await chatFunctions.sendMessage({
            publicKey: req.body.publicKey,
            conversationId: req.body.conversationId,
            content: req.body.content,
            identity: req.body.identity,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.log(`Widget router ${req.path} catch block`);
        console.log(error);
        generalFunctions.captureSentryException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.post("/actions/confirm", async (req, res) => {
    try {
        const { status, json } = await chatFunctions.confirmAction({
            publicKey: req.body.publicKey,
            conversationId: req.body.conversationId,
            confirmed: req.body.confirmed,
            identity: req.body.identity,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.log(`Widget router ${req.path} catch block`);
        console.log(error);
        generalFunctions.captureSentryException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.post("/conversations", async (req, res) => {
    try {
        const { status, json } = await chatFunctions.listWidgetConversations({
            publicKey: req.body.publicKey,
            conversationIds: req.body.conversationIds,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.log(`Widget router ${req.path} catch block`);
        console.log(error);
        generalFunctions.captureSentryException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.post("/help", async (req, res) => {
    try {
        const { status, json } = await chatFunctions.help({
            publicKey: req.body.publicKey,
            query: req.body.query,
            chunkId: req.body.chunkId,
            sourceId: req.body.sourceId,
            suggest: req.body.suggest,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.log(`Widget router ${req.path} catch block`);
        console.log(error);
        generalFunctions.captureSentryException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.post("/feedback", async (req, res) => {
    try {
        const { status, json } = await chatFunctions.feedback({
            publicKey: req.body.publicKey,
            conversationId: req.body.conversationId,
            rating: req.body.rating,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.log(`Widget router ${req.path} catch block`);
        console.log(error);
        generalFunctions.captureSentryException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

module.exports = router;
