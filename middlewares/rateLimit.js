const config = require("../config/config");
const { LimitReason } = require("../config/enums");
const crypto = require("node:crypto");
const RateBucket = require("../models/security/rateBucket");
const proxyaddr = require("proxy-addr");

// Shared fixed-window rate limiting for auth and public widget endpoints.
// are unauthenticated by design — the publicKey is embedded in customer HTML
// and can be copied by anyone — so this and the cost ceiling are the only
// things between a scraped key and an unbounded model bill.
//
// Production requests use atomic MongoDB counters, so adding API instances
// does not multiply the budget. The in-memory helper below is retained for
// isolated unit tests only.

// key -> array of request timestamps inside the window
const hits = new Map();

// Without this the Map grows for the lifetime of the process, one entry per
// distinct IP ever seen. unref so it never holds the process open in tests.
const sweeper = setInterval(() => {
    const cutoff = Date.now() - config.RATE_LIMIT_WINDOW_MS;
    for (const [key, timestamps] of hits) {
        const live = timestamps.filter((t) => t > cutoff);
        if (live.length === 0) hits.delete(key);
        else hits.set(key, live);
    }
}, config.RATE_LIMIT_WINDOW_MS);
if (sweeper.unref) sweeper.unref();

function consume(key, limit) {
    const now = Date.now();
    const cutoff = now - config.RATE_LIMIT_WINDOW_MS;
    const timestamps = (hits.get(key) || []).filter((t) => t > cutoff);

    if (timestamps.length >= limit) {
        const retryAfterMs = timestamps[0] + config.RATE_LIMIT_WINDOW_MS - now;
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }

    timestamps.push(now);
    hits.set(key, timestamps);
    return { allowed: true, remaining: limit - timestamps.length };
}

// Express has already applied the trusted proxy policy to req.ip. WebSocket
// upgrade requests are raw HTTP, so apply the same policy to those requests.
const trustProxy = typeof config.TRUST_PROXY === "number" ? (_, hop) => hop < config.TRUST_PROXY
    : config.TRUST_PROXY ? proxyaddr.compile(config.TRUST_PROXY.split(",").map(value => value.trim())) : () => false;
function clientIp(req) {
    if (req.ip) return req.ip;
    if (!req.socket?.remoteAddress) return "unknown";
    return proxyaddr(req, trustProxy);
}

async function consumeShared(key, limit, windowMs = config.RATE_LIMIT_WINDOW_MS) {
    if (limit <= 0) return { allowed: false, retryAfterSeconds: Math.ceil(windowMs / 1000) };
    const now = Date.now();
    const windowStart = new Date(Math.floor(now / windowMs) * windowMs);
    const filter = { key: crypto.createHash("sha256").update(key).digest("hex"), windowStart };
    const update = { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(windowStart.getTime() + windowMs * 2) } };
    let bucket;
    try { bucket = await RateBucket.findOneAndUpdate(filter, update, { new: true, upsert: true }); }
    catch (error) {
        if (error.code !== 11000) throw error;
        bucket = await RateBucket.findOneAndUpdate(filter, update, { new: true });
    }
    return { allowed: bucket.count <= limit, remaining: Math.max(0, limit - bucket.count),
        retryAfterSeconds: Math.max(1, Math.ceil((windowStart.getTime() + windowMs - now) / 1000)) };
}

function rejectLimit(res, result) {
    res.setHeader("Retry-After", String(result.retryAfterSeconds));
    return res.status(429).json({ success: false, error: "Too many requests. Please slow down.", reason: LimitReason.RATE_LIMITED });
}

async function authRateLimit(req, res, next) {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    try {
        const ip = await consumeShared(`auth:ip:${clientIp(req)}`, config.AUTH_RATE_LIMIT_PER_IP);
        if (!ip.allowed) return rejectLimit(res, ip);
        const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : null;
        if (email) {
            const account = await consumeShared(`auth:${req.path}:${email}`, config.AUTH_RATE_LIMIT_PER_ACCOUNT);
            if (!account.allowed) return rejectLimit(res, account);
        }
        return next();
    } catch (error) {
        console.error("authRateLimit: unavailable", error.message);
        return res.status(503).json({ success: false, error: "Sign-in is temporarily unavailable. Please retry shortly." });
    }
}

// Three tiers, checked cheapest-signal-first. The end-user limit stops one
// visitor hammering the widget; the org limit caps a whole workspace; the IP
// limit catches a script rotating fabricated conversation ids.
async function widgetRateLimit(req, res, next) {
    if (req.method === "OPTIONS") return next();
    try {
        const publicKey = req.body && req.body.publicKey;
        const conversationId = req.body && req.body.conversationId;
        const identityEmail = req.body && req.body.identity && req.body.identity.email;

        const checks = [
            // Identified visitors are limited by identity; anonymous ones by
            // conversation, which is the closest thing to a visitor id we have.
            {
                key: `eu:${publicKey}:${identityEmail || conversationId || clientIp(req)}`,
                limit: config.RATE_LIMIT_PER_END_USER,
            },
            { key: `ip:${clientIp(req)}`, limit: config.RATE_LIMIT_PER_IP },
            ...(publicKey ? [{ key: `org:${publicKey}`, limit: config.RATE_LIMIT_PER_ORG }] : []),
        ];

        for (const check of checks) {
            const result = await consumeShared(check.key, check.limit);
            if (!result.allowed) {
                res.setHeader("Retry-After", String(result.retryAfterSeconds));
                return res.status(429).json({
                    success: false,
                    error: "Too many requests. Please slow down.",
                    reason: LimitReason.RATE_LIMITED,
                });
            }
        }

        return next();
    } catch (error) {
        // Refuse paid work when shared abuse controls are unavailable.
        console.error("rateLimit:widgetRateLimit: Catch block");
        console.error(error);
        return res.status(503).json({ success: false, error: "Service is temporarily unavailable. Please retry shortly." });
    }
}

// Exposed for tests, which need a clean window per case.
function _reset() {
    hits.clear();
}

module.exports = { widgetRateLimit, authRateLimit, consume, consumeShared, clientIp, _reset };
