const config = require("../config/config");
const { LimitReason } = require("../config/enums");

// Sliding-window rate limiting for the public widget endpoints (§8.2). These
// are unauthenticated by design — the publicKey is embedded in customer HTML
// and can be copied by anyone — so this and the cost ceiling are the only
// things between a scraped key and an unbounded model bill.
//
// In-process on purpose. A Redis-backed limiter is strictly better across
// several instances, but there is no Redis in this stack today and an
// in-process limiter that works is worth more than a distributed one that is
// not deployed. Behind N instances each gets 1/N of the budget, which fails in
// the safe direction. Swap the two Map operations below for Redis when it
// exists.

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

// Behind a load balancer req.ip is the balancer unless trust proxy is set, so
// prefer the forwarded chain's first entry. Spoofable in principle, which is
// why the per-org limit exists underneath it as the real backstop.
function clientIp(req) {
    const forwarded = req.get("x-forwarded-for");
    if (forwarded) return forwarded.split(",")[0].trim();
    return req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
}

// Three tiers, checked cheapest-signal-first. The end-user limit stops one
// visitor hammering the widget; the org limit caps a whole workspace; the IP
// limit catches a script rotating fabricated conversation ids.
function widgetRateLimit(req, res, next) {
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
            const result = consume(check.key, check.limit);
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
        // Fail open. A bug in the limiter must not take the widget down for
        // every customer — the cost ceiling still backstops spend.
        console.error("rateLimit:widgetRateLimit: Catch block");
        console.error(error);
        return next();
    }
}

// Exposed for tests, which need a clean window per case.
function _reset() {
    hits.clear();
}

module.exports = { widgetRateLimit, consume, clientIp, _reset };
