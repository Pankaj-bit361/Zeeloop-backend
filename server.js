// The New Relic agent patches express, mongoose and http at require time, so it
// has to load before any of them — hence dotenv up here too, ahead of
// config/config.js, purely so the license key is readable at this point.
// No key means no agent: the backend must run without it, same as Sentry.
require("dotenv").config();
if (process.env.NEW_RELIC_LICENSE_KEY && process.env.NEW_RELIC_ENABLED !== "false") {
    require("newrelic");
}

const path = require("path");
const express = require("express");
const mongoose = require("mongoose");
const helmet = require("helmet");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const cron = require("node-cron");
const config = require("./config/config");
const generalFunctions = require("./functions/utilFunctions/generalFunctions");
const analyticsFunctions = require("./functions/analytics/analyticsFunctions");
const complianceFunctions = require("./functions/compliance/complianceFunctions");
const healthFunctions = require("./functions/health/healthFunctions");
const indexReadiness = require("./functions/health/indexReadiness");
const widgetRoutes = require("./routes/widgetRoutes");
const knowledgeRoutes = require("./routes/knowledgeRoutes");
const actionRoutes = require("./routes/actionRoutes");
const conversationRoutes = require("./routes/conversationRoutes");
const analyticsRoutes = require("./routes/analyticsRoutes");
const authRoutes = require("./routes/authRoutes");
const oauthRoutes = require("./routes/oauthRoutes");
const orgRoutes = require("./routes/orgRoutes");
const tableRoutes = require("./routes/tableRoutes");
const billingRoutes = require("./routes/billingRoutes");
const complianceRoutes = require("./routes/complianceRoutes");
const webhookRoutes = require("./routes/webhookRoutes");
const configRoutes = require("./routes/configRoutes");
const evalRoutes = require("./routes/evalRoutes");
const widgetConfigRoutes = require("./routes/widgetConfigRoutes");
const opsRoutes = require("./routes/opsRoutes");
const expansionRoutes = require("./routes/expansionRoutes");
const onboardingRoutes = require("./routes/onboardingRoutes");
const publicApiRoutes = require("./routes/publicApiRoutes");
const inboundEmailRoutes = require("./routes/inboundEmailRoutes");
const attributionFunctions = require("./functions/analytics/attributionFunctions");
const subscriptionFunctions = require("./functions/billing/subscriptionFunctions");
const qualityFunctions = require("./functions/eval/qualityFunctions");
const crawlWorker = require("./functions/knowledge/crawlWorker");
const knowledgeFunctions = require("./functions/knowledge/knowledgeFunctions");
const expansionFunctions = require("./functions/expansion/expansionFunctions");
const { requestContext } = require("./middlewares/requestContext");
const { widgetRateLimit } = require("./middlewares/rateLimit");
const { enforceOriginAllowlist } = require("./middlewares/originAllowlist");
const logger = require("./functions/utilFunctions/logger");

// §8.3 — structured logging. Installed before anything else logs, because it
// replaces the global console methods and a line written before this call goes
// out unstructured. See functions/utilFunctions/logger.js for why patching
// console is the right call here rather than rewriting 400 call sites.
//
// No-ops entirely when pino is absent or LOG_FORMAT=pretty, so local
// development is unchanged.
logger.install({ format: config.LOG_FORMAT, level: config.LOG_LEVEL });

const app = express();

// First in the chain: everything downstream, including the error handler, needs
// the request id to already exist.
app.use(requestContext);
app.use(helmet());
// The verify hook keeps the exact bytes for webhook signature checking. HMACs
// are computed over what the provider sent, and re-serialising the parsed JSON
// produces different bytes — different key order, different whitespace — so a
// signature checked against it never matches. Capped so a large upload cannot
// be retained twice.
app.use(
    express.json({
        limit: config.JSON_BODY_LIMIT,
        verify: (req, res, buf) => {
            if (buf && buf.length && buf.length <= 1_000_000) req.rawBody = buf;
        },
    })
);
app.use(cookieParser());

// Widget routes are public and CORS * — the whole point is running on customer sites.
const widgetCors = cors({ origin: "*" });
// Dashboard routes are restricted to known origins. `credentials` is what lets
// the session cookie ride along; it is also why the origin list can never
// become "*" — browsers reject that pairing outright.
const dashboardCors = cors({ origin: config.CORS_DASHBOARD_ORIGINS, credentials: true });

// The Elastic Beanstalk load balancer health-checks / by default. Answering it
// here rather than repointing the check at /health keeps the fix in the repo,
// where an environment rebuild cannot silently undo it. Both paths are
// liveness-only on purpose: they report that the process is up and accepting
// connections, and deliberately do not touch Mongo — a database blip should
// take conversations down, not have the balancer pull every instance out of
// service and leave nothing serving at all.
app.get("/", (req, res) => res.status(200).json({ success: true, status: "ok" }));
app.get("/health", (req, res) => res.status(200).json({ success: true, status: "ok" }));

// Deep health is a different question from liveness: "can this deployment
// actually do its job". For humans and uptime monitors, never for the load
// balancer — see the note above.
app.get("/health/deep", async (req, res) => {
    const { status, json } = await healthFunctions.deepCheck();
    return res.status(status).json(json);
});

// §8.5 — the public status page's data source. Unauthenticated on purpose: a
// status endpoint that needs a login is useless during the outage it exists to
// report, which is the only time anyone reads it.
//
// Deliberately says less than /health/deep. Component names and up/down, with
// no error strings, no versions and no hostnames — a public endpoint should not
// tell the internet which of our dependencies is currently weak.
app.get("/status", async (req, res) => {
    const { json } = await healthFunctions.deepCheck();
    const checks = json.checks || {};
    return res.status(200).json({
        success: true,
        status: json.status,
        components: [
            { name: "API", status: "ok" },
            { name: "Database", status: checks.database ? checks.database.status : "unknown" },
            { name: "Search", status: checks.search ? checks.search.status : "unknown" },
            { name: "AI responses", status: checks.chat ? checks.chat.status : "unknown" },
            { name: "Knowledge indexing", status: checks.embedding ? checks.embedding.status : "unknown" },
        ],
        checkedAt: json.checkedAt || new Date().toISOString(),
    });
});

// §8.5 — in-app changelog. Product-wide rather than per workspace, so it needs
// no org scope and no auth.
app.get("/changelog", dashboardCors, async (req, res) => {
    const { status, json } = await expansionFunctions.listChangelog({ limit: req.query.limit });
    return res.status(status).json(json);
});

// OAuth round-trip. Root-mounted and CORS-free: the provider redirect URIs are
// registered as ${API_URL}/auth/<provider>/callback and every hop is a top-level
// navigation, never a cross-origin fetch.
app.use("/auth", oauthRoutes);

// Provider webhooks. Root-mounted and CORS-free for the same reason as OAuth:
// these are server-to-server posts whose URL is registered with the provider,
// and the signature is the credential.
app.use("/webhooks", webhookRoutes);

// §4.8 and §4.9 — the mail provider's inbound parse webhook, plus public
// article search for the widget. Root-mounted and CORS-free for the same reason
// as the routes above: server-to-server posts to registered URLs, where the
// shared secret is the credential.
app.use("/inbound", widgetCors, inboundEmailRoutes);

// Rate limiting and the origin allowlist sit on the widget mount rather than
// inside the router, so a route added later is covered by default instead of by
// remembering. Order matters: rate limiting first, because it is in-memory and
// free, and the allowlist check costs a database read.
app.use("/api/widget", widgetCors, widgetRateLimit, enforceOriginAllowlist, widgetRoutes);

// ── Widget static assets ─────────────────────────────────────
// widget.js is embedded by customer sites; the frame is loaded in an iframe on
// those same sites. helmet's defaults (frame-ancestors 'self' + X-Frame-Options
// SAMEORIGIN) would block exactly that, so these routes override both. That is
// safe: the frame holds no session — every request inside it re-authenticates
// with the org publicKey.
const widgetDist = path.join(__dirname, "../widget/dist");
// §8.4 — the frame's own CSP. `frame-ancestors *` is required (the whole point
// is embedding on customer sites) but everything else is locked down, because
// the frame renders content that originates with the customer's own knowledge
// base and end users' messages.
//
// The directives that matter, and why:
//   default-src 'self'   nothing loads from a third-party host
//   script-src 'self'    a stray <script> in an answer cannot execute
//   connect-src          the frame talks to this API and nowhere else, so an
//                        injected fetch cannot exfiltrate a conversation
//   object-src 'none'    no plugins, ever
//   base-uri 'none'      a <base> tag cannot repoint every relative URL
//
// 'unsafe-inline' is allowed for styles only: the theme tokens are injected as
// an inline style block, and the alternative is a per-request nonce on a
// response that is meant to be CDN-cacheable.
const FRAME_CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    `connect-src 'self' ${config.API_URL}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors *",
].join("; ");

const embeddable = (req, res, next) => {
    res.removeHeader("X-Frame-Options");
    res.setHeader("Content-Security-Policy", FRAME_CSP);
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    next();
};
app.get("/widget.js", widgetCors, embeddable, (req, res) => {
    res.sendFile(path.join(widgetDist, "widget.js"), { maxAge: "5m" });
});
app.get("/widget/demo", embeddable, (req, res) => {
    res.sendFile(path.join(widgetDist, "demo.html"));
});
// Side-by-side comparison against Intercom — internal demo page, not customer-facing.
app.get("/widget/compare", embeddable, (req, res) => {
    res.sendFile(path.join(widgetDist, "compare.html"));
});
// Theme derivation lab — renders the server's token derivation across test brand colors.
app.get("/widget/theme-lab", embeddable, (req, res) => {
    res.sendFile(path.join(widgetDist, "theme-lab.html"));
});
app.get("/widget/theme-lab.js", embeddable, (req, res) => {
    res.sendFile(path.join(widgetDist, "theme-lab.js"));
});
app.use("/widget/frame", embeddable, express.static(path.join(widgetDist, "frame"), { maxAge: "5m" }));
app.use("/api/auth", dashboardCors, authRoutes);
app.use("/api/knowledge", dashboardCors, knowledgeRoutes);
app.use("/api/org", dashboardCors, actionRoutes);
app.use("/api/org", dashboardCors, conversationRoutes);
app.use("/api/org", dashboardCors, tableRoutes);
app.use("/api/org", dashboardCors, orgRoutes);
app.use("/api/org", dashboardCors, billingRoutes);
app.use("/api/org", dashboardCors, complianceRoutes);
// §2 configuration surface, §3 evaluation, §4 widget config, §5 expansion,
// §8 operations. All org-scoped and all behind reqOrgOwnerAuth, so they mount
// on the same prefix as everything else the dashboard calls.
app.use("/api/org", dashboardCors, configRoutes);
app.use("/api/org", dashboardCors, evalRoutes);
app.use("/api/org", dashboardCors, widgetConfigRoutes);
app.use("/api/org", dashboardCors, opsRoutes);
app.use("/api/org", dashboardCors, expansionRoutes);
app.use("/api/org", dashboardCors, onboardingRoutes);
app.use("/api/analytics", dashboardCors, analyticsRoutes);

// §5.6 — the customer-facing REST API. Deliberately NOT under /api/org: it is
// authenticated by a scoped API key rather than by a dashboard session, it is
// versioned because customers write code against it, and its CORS policy is
// open because it is called from servers rather than from our dashboard.
app.use("/v1", cors({ origin: "*" }), publicApiRoutes);

app.use((req, res) => {
    return res.status(404).json({ success: false, error: "Not found" });
});

// Global error handler — the last line of defense.
app.use((error, req, res, next) => {
    console.error("Server: global error handler");
    console.error(error);
    generalFunctions.captureException(error);
    // requestContext stamps requestId onto any 5xx body on the way out.
    return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
});

// Mongo connect with retry — a database blip is a logged retry, not a crash.
async function connectWithRetry() {
    try {
        await mongoose.connect(config.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
        console.log("Server: connected to MongoDB");
        // Several idempotency guarantees are enforced by unique indexes rather
        // than by application code. Mongoose builds those in the background, so
        // on a fresh database there is a window at boot where the constraint
        // does not yet exist and a duplicate insert succeeds. Awaited here so
        // that window closes before traffic arrives.
        await indexReadiness.ensureCriticalIndexes();
        // Loud, not fatal. Without the Atlas search indexes retrieval returns
        // nothing and the agent abstains from every question — indistinguishable
        // from an empty knowledge base unless someone says so at boot (§8.3).
        await healthFunctions.assertSearchIndexes();
    } catch (error) {
        console.error("Server: MongoDB connection failed, retrying in 5s");
        console.error(error.message);
        setTimeout(connectWithRetry, 5000);
    }
}

app.listen(config.PORT, () => {
    console.log(`Server: Zealoop backend listening on port ${config.PORT}`);
});

connectWithRetry();

// Autonomous resolution is computed by cron, never at write time (§11).
cron.schedule(config.RESOLUTION_CRON, () => {
    analyticsFunctions.computeResolutions();
});

// Retention purge (§8.1). Disabled unless RETENTION_DAYS is set — a workspace
// that has not chosen a window keeps its data, and an unset variable must never
// read as "delete everything".
if (config.RETENTION_DAYS > 0) {
    cron.schedule(config.RETENTION_CRON, () => {
        complianceFunctions.purgeExpired();
    });
    console.log(`Server: retention purge scheduled (${config.RETENTION_DAYS} days, ${config.RETENTION_CRON})`);
}

// Attribution counters (§2.5). Computed from TurnTrace rather than incremented
// at write time — see attributionFunctions for why.
cron.schedule(config.ATTRIBUTION_CRON, () => {
    attributionFunctions.computeAttribution({});
});

// Answer quality grading (§3.4). Runs on 100% of conversations, unlike thumbs
// feedback which arrives on under 5%.
cron.schedule(config.QUALITY_CRON, () => {
    qualityFunctions.gradePending({});
});

// Trial notices, dunning and suspension (§0.5). Idempotent end to end, which is
// what makes it safe on a schedule that will occasionally fire twice.
cron.schedule(config.LIFECYCLE_CRON, () => {
    subscriptionFunctions.runLifecycleSweep({});
});

// §1.3 — the crawl worker. Crawling used to run inline on the request thread,
// which blocked it and could not survive a deploy. This is an in-process poller
// rather than BullMQ: Redis is not in this stack, and taking on an operational
// dependency to get a queue this shape would be a larger change than the
// feature. The job model carries lease and attempt fields, so moving to a real
// broker later is a swap of this loop rather than a redesign.
if (config.CRAWL_WORKER_ENABLED) {
    crawlWorker.start();

    // §1.4 — scheduled re-syncs. Queued, never crawled inline, so a hundred due
    // sources do not all run at once on one tick.
    cron.schedule("*/15 * * * *", () => {
        knowledgeFunctions.enqueueScheduledSyncs();
    });
}
