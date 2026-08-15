const express = require("express");
const billingFunctions = require("../functions/billing/billingFunctions");
const generalFunctions = require("../functions/utilFunctions/generalFunctions");

const router = express.Router();

// Public and unauthenticated by necessity — the provider cannot hold a session.
// Authentication is the HMAC signature over the raw body, verified inside
// processWebhook. Mounted at the server root, CORS-free: this is a
// server-to-server POST, never a browser fetch.
router.post("/billing", async (req, res) => {
    try {
        const { status, json } = await billingFunctions.processWebhook({
            // Captured by the express.json verify hook in server.js. The parsed
            // body cannot be re-serialised for signature checking — different
            // bytes, failed HMAC, every time.
            rawBody: req.rawBody,
            // Lemon Squeezy signs into x-signature, Razorpay into
            // x-razorpay-signature, and Razorpay's per-delivery event id is a
            // header too. Rather than teach this route every provider's header
            // names, hand over the headers and let the adapter take what it
            // needs.
            signature: req.get("x-signature") || req.get("X-Signature"),
            headers: req.headers,
            body: req.body,
        });
        return res.status(status).json(json);
    } catch (error) {
        console.error(`Webhook router ${req.path} catch block`);
        console.error(error);
        generalFunctions.captureException(error);
        return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
    }
});

module.exports = router;
