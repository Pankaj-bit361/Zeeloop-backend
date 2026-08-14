const express = require("express");
const chatFunctions = require("../functions/chat/chatFunctions");
const generalFunctions = require("../functions/utilFunctions/generalFunctions");
const { reqOrgOwnerAuth } = require("../middlewares/auth");

const router = express.Router();

router.get("/:orgId/conversations", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await chatFunctions.listConversations({
            orgId: req.params.orgId,
            status: req.query.status,
            search: req.query.search,
            page: req.query.page,
            limit: req.query.limit,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Conversation router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.get("/:orgId/conversations/:conversationId", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await chatFunctions.getConversation({
            orgId: req.params.orgId,
            conversationId: req.params.conversationId,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Conversation router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.patch("/:orgId/conversations/:conversationId", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await chatFunctions.updateConversationStatus({
            orgId: req.params.orgId,
            conversationId: req.params.conversationId,
            status: req.body.status,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Conversation router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.post("/:orgId/conversations/:conversationId/reply", reqOrgOwnerAuth, async (req, res) => {
    try {
        const { status, json } = await chatFunctions.replyAsHuman({
            orgId: req.params.orgId,
            conversationId: req.params.conversationId,
            content: req.body.content,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Conversation router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

module.exports = router;
