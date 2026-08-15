const express = require("express");
const inboundEmailFunctions = require("../functions/email/inboundEmailFunctions");
const articleFunctions = require("../functions/widget/articleFunctions");
const generalFunctions = require("../functions/utilFunctions/generalFunctions");

const router = express.Router();

// §4.8 — the mail provider's inbound parse webhook.
//
// Root-mounted and CORS-free for the same reason as the OAuth and billing
// webhook routes: this is a server-to-server post to a URL registered with the
// provider, and the shared secret is the credential.
//
// The secret can arrive as a header or in the body, because providers differ on
// which they can be configured to send.
router.post("/email", async (req, res) => {
    try {
        const { status, json } = await inboundEmailFunctions.receive({
            secret: req.get("x-zealoop-inbound-secret") || req.body.secret,
            to: req.body.to,
            from: req.body.from,
            subject: req.body.subject,
            // "text" is the plain part; providers name the HTML part
            // differently, and plain text is what the pipeline wants anyway.
            text: req.body.text || req.body.plain || req.body["stripped-text"],
            messageId: req.body.messageId || req.body["Message-Id"] || req.get("message-id"),
            inReplyTo: req.body.inReplyTo || req.body["In-Reply-To"],
            references: req.body.references || req.body.References,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Inbound email router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        // 500 rather than a swallowed 200: a genuine server error SHOULD be
        // retried by the provider, unlike the "unknown address" case, which
        // inboundEmailFunctions deliberately answers 200 because retrying it
        // could never succeed.
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

// §4.9 — in-widget article search and reading. Public, keyed by publicKey, and
// mounted here rather than under /api/widget so it is not rate limited as
// aggressively as message sending: browsing help articles is the cheap path we
// actively want visitors to take instead of starting a conversation.
router.get("/articles/search", async (req, res) => {
    try {
        const { status, json } = await articleFunctions.searchArticles({
            publicKey: req.query.publicKey,
            query: req.query.q,
            limit: req.query.limit,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Inbound router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

router.get("/articles/:sourceId", async (req, res) => {
    try {
        const { status, json } = await articleFunctions.getArticle({
            publicKey: req.query.publicKey,
            sourceId: req.params.sourceId,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Inbound router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

module.exports = router;
