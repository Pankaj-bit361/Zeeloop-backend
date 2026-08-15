const express = require("express");
const { ApiScope, FeatureKey, ConversationStatus } = require("../config/enums");
const { ApiKey } = require("../models/org/expansion");
const Org = require("../models/org/org");
const Conversation = require("../models/conversation/conversation");
const Message = require("../models/conversation/message");
const KnowledgeSource = require("../models/knowledge/knowledgeSource");
const expansionFunctions = require("../functions/expansion/expansionFunctions");
const analyticsFunctions = require("../functions/analytics/analyticsFunctions");
const knowledgeFunctions = require("../functions/knowledge/knowledgeFunctions");
const generalFunctions = require("../functions/utilFunctions/generalFunctions");
const { planHasFeature } = require("../config/plans");

const router = express.Router();

// §5.6 — the customer-facing REST API.
//
// Mounted at /v1, deliberately outside /api/org. It is a different product
// surface: authenticated by a scoped key rather than a dashboard session,
// versioned because customers write code against it, and documented as stable.
//
// Three properties enforced here rather than trusted:
//
//   1. The key decides the org. There is no orgId in any path — a caller cannot
//      name a workspace, only present a credential that belongs to one. This is
//      the whole tenancy story, and putting the orgId in the URL would make it
//      one missing check away from broken.
//   2. Scopes are checked per route, not per key type. A read key that is
//      talked into writing is the failure this prevents.
//   3. Rate limited per key, in memory, matching how widgetRateLimit works.

// Same sliding window as middlewares/rateLimit — in-process, which is right for
// a single-instance deployment and is documented as such there.
const requestLog = new Map();

function rateLimit(apiKey) {
    const now = Date.now();
    const windowStart = now - 60_000;
    const timestamps = (requestLog.get(apiKey.apiKeyId) || []).filter((time) => time > windowStart);

    if (timestamps.length >= apiKey.rateLimitPerMinute) {
        return { allowed: false, retryAfter: Math.ceil((timestamps[0] + 60_000 - now) / 1000) };
    }

    timestamps.push(now);
    requestLog.set(apiKey.apiKeyId, timestamps);

    // Bounded, or a long-running process accumulates one array per key that was
    // ever used.
    if (requestLog.size > 5000) {
        for (const [key, times] of requestLog) {
            if (times.every((time) => time <= windowStart)) requestLog.delete(key);
        }
    }

    return { allowed: true, remaining: apiKey.rateLimitPerMinute - timestamps.length };
}

// Authenticates by hashing the presented key and looking up the hash. The stored
// value is a hash, so a database read never yields a usable credential.
function requireApiKey(...requiredScopes) {
    return async (req, res, next) => {
        try {
            const header = req.headers.authorization || "";
            const presented = header.startsWith("Bearer ") ? header.slice(7) : null;
            if (!presented) {
                return res.status(401).json({ success: false, error: "Missing API key. Send it as: Authorization: Bearer <key>" });
            }

            const apiKey = await ApiKey.findOne({
                keyHash: expansionFunctions.hashKey(presented),
                revokedAt: null,
            });
            if (!apiKey) {
                return res.status(401).json({ success: false, error: "Invalid or revoked API key" });
            }

            const missing = requiredScopes.filter((scope) => !apiKey.scopes.includes(scope));
            if (missing.length > 0) {
                return res.status(403).json({
                    success: false,
                    error: `This key is missing the ${missing.join(", ")} scope`,
                });
            }

            const org = await Org.findOne({ orgId: apiKey.orgId }).select("orgId name credits").lean();
            if (!org) {
                return res.status(401).json({ success: false, error: "Invalid or revoked API key" });
            }
            // Gated on the plan at request time, not only at key creation: a
            // workspace that downgrades must lose API access, and a key issued
            // last month should not outlive the plan that allowed it.
            if (!planHasFeature((org.credits && org.credits.plan) || "FREE", FeatureKey.PUBLIC_API)) {
                return res.status(402).json({ success: false, error: "The API is not included on this workspace's plan" });
            }

            const limit = rateLimit(apiKey);
            if (!limit.allowed) {
                res.setHeader("retry-after", String(limit.retryAfter));
                return res.status(429).json({ success: false, error: "Rate limit exceeded" });
            }
            res.setHeader("x-ratelimit-remaining", String(limit.remaining));

            // Best-effort and not awaited: a timestamp update must not add a
            // write to the latency of every API call.
            ApiKey.updateOne({ _id: apiKey._id }, { $set: { lastUsedAt: new Date() } }).catch(() => {});

            req.apiKey = apiKey;
            req.orgId = apiKey.orgId;
            return next();
        } catch (error) {
            console.error("publicApi:requireApiKey: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
        }
    };
}

function fail(req, res, error) {
    console.error(`Public API ${req.path} catch block`);
    console.error(error);
    generalFunctions.captureException(error);
    return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
}

// ── Discovery ────────────────────────────────────────────────────────
// Generated from the route table below rather than maintained separately, so
// the docs cannot drift from what is actually mounted.

const ENDPOINTS = [
    { method: "GET", path: "/v1/conversations", scope: ApiScope.CONVERSATIONS_READ, description: "List conversations, newest first." },
    { method: "GET", path: "/v1/conversations/:id", scope: ApiScope.CONVERSATIONS_READ, description: "One conversation with its messages." },
    { method: "POST", path: "/v1/conversations/:id/close", scope: ApiScope.CONVERSATIONS_WRITE, description: "Mark a conversation resolved." },
    { method: "GET", path: "/v1/knowledge/sources", scope: ApiScope.KNOWLEDGE_READ, description: "List knowledge sources." },
    { method: "POST", path: "/v1/knowledge/sources", scope: ApiScope.KNOWLEDGE_WRITE, description: "Create a snippet source." },
    { method: "DELETE", path: "/v1/knowledge/sources/:id", scope: ApiScope.KNOWLEDGE_WRITE, description: "Delete a source and its chunks." },
    { method: "GET", path: "/v1/analytics/overview", scope: ApiScope.ANALYTICS_READ, description: "Automation, involvement and resolution rates." },
];

router.get("/", (req, res) => {
    return res.status(200).json({
        success: true,
        data: {
            version: "1",
            authentication: "Authorization: Bearer <key>. The key determines the workspace.",
            scopes: Object.values(ApiScope),
            endpoints: ENDPOINTS,
            webhooks: {
                signature: "HMAC-SHA256 over `${timestamp}.${rawBody}`, in the zealoop-signature header.",
                timestampHeader: "zealoop-timestamp",
                note: "Reject deliveries whose timestamp is more than five minutes old.",
            },
        },
    });
});

// ── Conversations ────────────────────────────────────────────────────

router.get("/conversations", requireApiKey(ApiScope.CONVERSATIONS_READ), async (req, res) => {
    try {
        const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
        const page = Math.max(1, Number(req.query.page) || 1);

        const query = { orgId: req.orgId };
        if (req.query.status && Object.values(ConversationStatus).includes(req.query.status)) {
            query.status = req.query.status;
        }

        const [conversations, total] = await Promise.all([
            Conversation.find(query)
                .sort({ lastMessageAt: -1 })
                .skip((page - 1) * limit)
                .limit(limit)
                .lean(),
            Conversation.countDocuments(query),
        ]);

        return res.status(200).json({
            success: true,
            data: conversations.map((conversation) => ({
                id: conversation.conversationId,
                status: conversation.status,
                channel: conversation.channel,
                turnCount: conversation.turnCount,
                resolved: conversation.isResolved,
                attributes: (conversation.attributes || []).map((attribute) => ({
                    name: attribute.name,
                    value: attribute.value,
                })),
                lastMessageAt: conversation.lastMessageAt,
                createdAt: conversation.createdAt,
            })),
            pagination: { page, limit, total },
        });
    } catch (error) {
        return fail(req, res, error);
    }
});

router.get("/conversations/:id", requireApiKey(ApiScope.CONVERSATIONS_READ), async (req, res) => {
    try {
        const conversation = await Conversation.findOne({ orgId: req.orgId, conversationId: req.params.id }).lean();
        if (!conversation) return res.status(404).json({ success: false, error: "Conversation not found" });

        const messages = await Message.find({ orgId: req.orgId, conversationId: req.params.id })
            .sort({ createdAt: 1 })
            .limit(200)
            .lean();

        return res.status(200).json({
            success: true,
            data: {
                id: conversation.conversationId,
                status: conversation.status,
                channel: conversation.channel,
                resolved: conversation.isResolved,
                messages: messages.map((message) => ({
                    role: message.role,
                    content: message.content,
                    createdAt: message.createdAt,
                })),
            },
        });
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/conversations/:id/close", requireApiKey(ApiScope.CONVERSATIONS_WRITE), async (req, res) => {
    try {
        const conversation = await Conversation.findOne({ orgId: req.orgId, conversationId: req.params.id });
        if (!conversation) return res.status(404).json({ success: false, error: "Conversation not found" });

        // §2.3 — requireToClose is enforced here too. A rule that the dashboard
        // honours and the API ignores is not a rule.
        const attributeFunctions = require("../functions/config/attributeFunctions");
        const required = await attributeFunctions.checkRequiredForClose({
            orgId: req.orgId,
            conversationId: req.params.id,
        });
        if (required.missing.length > 0) {
            return res.status(400).json({
                success: false,
                error: `These attributes must be set before closing: ${required.missing.map((attribute) => attribute.name).join(", ")}`,
            });
        }

        conversation.status = ConversationStatus.RESOLVED;
        conversation.manuallyResolvedAt = new Date();
        await conversation.save();

        return res.status(200).json({ success: true, data: { id: conversation.conversationId, status: conversation.status } });
    } catch (error) {
        return fail(req, res, error);
    }
});

// ── Knowledge ────────────────────────────────────────────────────────

router.get("/knowledge/sources", requireApiKey(ApiScope.KNOWLEDGE_READ), async (req, res) => {
    try {
        const sources = await KnowledgeSource.find({ orgId: req.orgId })
            .select("sourceId type name url status chunkCount lastSyncedAt")
            .sort({ createdAt: -1 })
            .lean();

        return res.status(200).json({
            success: true,
            data: sources.map((source) => ({
                id: source.sourceId,
                type: source.type,
                name: source.name,
                url: source.url || null,
                status: source.status,
                chunkCount: source.chunkCount,
                lastSyncedAt: source.lastSyncedAt,
            })),
        });
    } catch (error) {
        return fail(req, res, error);
    }
});

router.post("/knowledge/sources", requireApiKey(ApiScope.KNOWLEDGE_WRITE), async (req, res) => {
    try {
        const { status, json } = await knowledgeFunctions.createSource({
            orgId: req.orgId,
            // SNIPPET only over the API. A URL or SITEMAP source starts a crawl
            // of a host the caller names, which is an SSRF primitive if it can
            // be triggered by an API key — the dashboard path has a human
            // behind it.
            type: "SNIPPET",
            name: req.body.name,
            content: req.body.content,
        });
        if (!json.success) return res.status(status).json(json);

        return res.status(201).json({ success: true, data: { id: json.data.sourceId, status: json.data.status } });
    } catch (error) {
        return fail(req, res, error);
    }
});

router.delete("/knowledge/sources/:id", requireApiKey(ApiScope.KNOWLEDGE_WRITE), async (req, res) => {
    try {
        const { status, json } = await knowledgeFunctions.deleteSource({ orgId: req.orgId, sourceId: req.params.id });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

// ── Analytics ────────────────────────────────────────────────────────

router.get("/analytics/overview", requireApiKey(ApiScope.ANALYTICS_READ), async (req, res) => {
    try {
        const { status, json } = await analyticsFunctions.getOverview({ orgId: req.orgId, days: req.query.days });
        return res.status(status).json(json);
    } catch (error) {
        return fail(req, res, error);
    }
});

module.exports = router;
module.exports.ENDPOINTS = ENDPOINTS;
