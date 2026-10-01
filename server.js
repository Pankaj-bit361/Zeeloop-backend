// The New Relic agent patches express, mongoose and http at require time, so it
// has to load before any of them — hence dotenv up here too, ahead of
// config/config.js, purely so the license key is readable at this point.
// No key means no agent: the backend must run without it, same as Sentry.
require("dotenv").config();
if (process.env.NEW_RELIC_LICENSE_KEY && process.env.NEW_RELIC_ENABLED !== "false") {
    require("newrelic");
}

const path = require("path");
const http = require("http");
const express = require("express");
const mongoose = require("mongoose");
const helmet = require("helmet");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const cron = require("node-cron");
const config = require("./config/config");
const generalFunctions = require("./functions/utilFunctions/generalFunctions");
const realtimeHub = require("./functions/realtime/realtimeHub");
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
const mcpRoutes = require("./routes/mcpRoutes");
const mcpOAuthRoutes = require("./routes/mcpOAuthRoutes");
const inboundEmailRoutes = require("./routes/inboundEmailRoutes");
const attributionFunctions = require("./functions/analytics/attributionFunctions");
const subscriptionFunctions = require("./functions/billing/subscriptionFunctions");
const qualityFunctions = require("./functions/eval/qualityFunctions");
const crawlWorker = require("./functions/knowledge/crawlWorker");
const knowledgeFunctions = require("./functions/knowledge/knowledgeFunctions");
const expansionFunctions = require("./functions/expansion/expansionFunctions");
const { requestContext } = require("./middlewares/requestContext");
const { sanitize } = require("./middlewares/sanitize");
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
app.set("trust proxy", config.TRUST_PROXY);
let indexesReady = false;

// First in the chain: everything downstream, including the error handler, needs
// the request id to already exist.
app.use(requestContext);
app.use(helmet());
// The verify hook keeps the exact bytes for webhook signature checking. HMACs
// are computed over what the provider sent, and re-serialising the parsed JSON
// produces different bytes — different key order, different whitespace — so a
// signature checked against it never matches. Capped so a large upload cannot
// be retained twice.
const jsonBody = express.json({
    limit: config.JSON_BODY_LIMIT,
    verify: (req, res, buf) => {
        if (buf && buf.length && buf.length <= 1_000_000) req.rawBody = buf;
    },
});
const isMcpPath = req => /^\/mcp\/?$/i.test(req.path);
const isMcpOAuthPath = req => /^\/oauth\/mcp(\/|$)/i.test(req.path);
// The SDK's Node adapter receives req.body, so its stream-size limit cannot
// bound JSON already parsed by Express. Enforce the smaller MCP limit here,
// including whitespace and decoded compressed bodies.
const mcpJsonBody = express.json({ limit: 65_536 });
const oauthJsonBody = express.json({ limit: 16_384 });
app.use((req, res, next) => (isMcpPath(req) ? mcpJsonBody : isMcpOAuthPath(req) ? oauthJsonBody : jsonBody)(req, res, next));
const oauthFormBody = express.urlencoded({ extended: false, limit: 16_384 });
app.use((req, res, next) => isMcpOAuthPath(req) ? oauthFormBody(req, res, next) : next());
app.use((error, req, res, next) => {
    if (isMcpOAuthPath(req) && [400, 413, 415].includes(error.status)) {
        res.setHeader("Cache-Control", "private, no-store");
        return res.status(error.status).json({ error: "invalid_request", error_description: error.status === 413 ? "OAuth request exceeds the 16 KiB limit" : "Invalid OAuth request body" });
    }
    if (!isMcpPath(req) || ![400, 413, 415].includes(error.status)) return next(error);
    res.setHeader("Cache-Control", "private, no-store");
    const message = error.status === 413 ? "MCP request exceeds the 64 KiB limit"
        : error.status === 415 ? "Unsupported MCP request encoding" : "Invalid JSON request";
    return res.status(error.status).json({ jsonrpc: "2.0", id: null,
        error: { code: error.status === 400 ? -32700 : -32600, message } });
});
app.use(cookieParser());

/* §8.6 — reject MongoDB operator syntax in anything a client sends, before it
   can reach a query. Mounted after the body parser and before every route, so
   there is no path into the app that skips it.

   Webhook signature verification is unaffected: it reads req.rawBody, captured
   by the express.json verify hook above, so a rejected body is rejected before
   it matters and a legitimate one still verifies against the original bytes. */
// MCP metadata uses namespaced dotted keys. Its SDK validates the JSON-RPC
// envelope and every tool's strict schema; no body object reaches MongoDB.
app.use((req, res, next) => isMcpPath(req) ? next() : sanitize(req, res, next));

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
app.get("/ready", (req, res) => {
    const ready = indexesReady && mongoose.connection.readyState === 1;
    res.status(ready ? 200 : 503).json({ success: ready, status: ready ? "ready" : "starting" });
});
// Readiness also gates writes when a load balancer still routes to a booting
// instance. The uniqueness constraints must exist before accepting traffic.
app.use((req, res, next) => {
    if (/^\/(api|v1|mcp|oauth|webhooks|inbound|auth)(\/|$)/.test(req.path) && (!indexesReady || mongoose.connection.readyState !== 1)) {
        res.setHeader("Retry-After", "5");
        return res.status(503).json({ success: false, error: "Service is starting. Please retry shortly." });
    }
    next();
});

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
// remembering. Shared rate limiting runs before the workspace policy lookup.
app.use("/api/widget", widgetCors, widgetRateLimit, enforceOriginAllowlist, widgetRoutes);

// ── Widget static assets ─────────────────────────────────────
// widget.js is embedded by customer sites; the frame is loaded in an iframe on
// those same sites. helmet's defaults (frame-ancestors 'self' + X-Frame-Options
// SAMEORIGIN) would block exactly that, so these routes override both. That is
// safe: the frame holds no session — every request inside it re-authenticates
// with the org publicKey.
/* Where the widget build lives.

   Deployed: public/widget, a copy vendored into THIS repository by
   `npm run widget:sync`. It has to be in this repo, because this repo is what
   gets deployed — the sibling ../widget checkout that exists on a laptop is
   not on the server, and reading from it is how production served 500 on the
   one URL every customer's install snippet points at.

   Developing: ../widget/dist wins when it is present, so a widget change is
   visible the moment it is built, without a sync step in the loop. The suite
   fails if that fresh build and the vendored copy differ, so the copy cannot
   be forgotten. WIDGET_DIST overrides both. */
const widgetDist = (() => {
    const fs = require("fs");
    const candidates = [
        process.env.WIDGET_DIST,
        path.join(__dirname, "../widget/dist"),
        path.join(__dirname, "public/widget"),
    ].filter(Boolean);
    const found = candidates.find((dir) => fs.existsSync(path.join(dir, "widget.js")));
    if (!found) {
        console.error("Server: NO WIDGET BUILD FOUND — /widget.js will answer 503. Run `npm run widget:sync`.");
        return path.join(__dirname, "public/widget");
    }
    console.log("Server: widget served from", path.relative(__dirname, found) || found);
    return found;
})();
const widgetReady = require("fs").existsSync(path.join(widgetDist, "widget.js"));
// A missing build is a deployment gap, not a bug: say so, rather than the
// generic 500 that sendFile-on-nothing used to produce.
const requireWidgetBuild = (req, res, next) => {
    if (widgetReady) return next();
    return res.status(503).json({ success: false, error: "The widget build is not deployed on this server" });
};
// The frame's CSP permits customer embedding unless the workspace enables an
// allowlist. Everything else is locked down, because
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
    // WebSocket counts as connect-src: without the ws(s) origin here the
    // real-time socket is blocked by our own policy and the widget silently
    // falls back to polling forever.
    `connect-src 'self' ${config.API_URL} ${String(config.API_URL).replace(/^http/, "ws")}`,
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

// Origin on an iframe's API requests identifies this API, not its parent site.
// Only the browser's frame-ancestors check verifies every actual ancestor.
const widgetFramePolicy = async (req, res, next) => {
    if (!["/", "/index.html"].includes(req.path) || typeof req.query.pk !== "string") return next();
    try {
        const org = await require("./models/org/org").findOne({ publicKey: req.query.pk }).select("widget").lean();
        if (org) {
            res.locals.widgetFramePolicy = true;
            if (org.widget?.enforceOriginAllowlist) {
                const security = require("./functions/security/securityFunctions");
                const origins = (org.widget.allowedOrigins || []).map(value => security.normaliseOrigin(value)).filter(Boolean);
                if (req.query.preview === "1") {
                    origins.push(...config.CORS_DASHBOARD_ORIGINS.map(value => security.normaliseOrigin(value)).filter(Boolean));
                }
                res.setHeader("Content-Security-Policy", FRAME_CSP.replace("frame-ancestors *", `frame-ancestors ${origins.length ? origins.join(" ") : "'none'"}`));
            }
        }
        next();
    } catch (error) {
        generalFunctions.captureException(error);
        res.status(503).json({ success: false, error: "Widget policy is temporarily unavailable" });
    }
};

// The demo, compare and theme-lab pages are stand-ins for a CUSTOMER'S site,
// not part of the widget. They carry the inline snippet a customer pastes, so
// the frame's `script-src 'self'` would block exactly the thing they exist to
// demonstrate. They serve no customer data and are not linked from the product.
const demoPage = (req, res, next) => {
    res.removeHeader("X-Frame-Options");
    res.setHeader("Content-Security-Policy", "frame-ancestors *");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    next();
};
/* Widget assets: compressed, and cached for how each file is actually used.

   Measured before this (Sep 2026): production sent frame.js and frame.css
   uncompressed (38 KB and 41 KB, against 13 KB and 9 KB gzipped) with a
   five-minute cache, so every returning visitor paid a full round trip per
   file after five minutes.

   - frame.<hash>.js/.css are immutable. The build fingerprints them, so a new
     deploy is a new URL and a year-long cache is safe.
   - index.html and widget.js keep a short cache (their URLs never change —
     widget.js is in every customer's snippet) with stale-while-revalidate, so
     a return visit paints from cache and refreshes in the background.
   - The build writes .br and .gz siblings; the browser's Accept-Encoding picks
     one. nginx passes a Content-Encoding it did not add straight through.
   - A page holding an older index.html can ask for a fingerprint this deploy
     no longer has. It gets the current build under no-cache, not a 404 that
     leaves the messenger blank. */
const WIDGET_TYPES = {
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
};
const HASHED_FRAME_ASSET = /^\/frame\.[0-9a-f]{10}\.(js|css)$/;
function widgetCacheControl(rel) {
    if (HASHED_FRAME_ASSET.test(rel)) return "public, max-age=31536000, immutable";
    return "public, max-age=300, stale-while-revalidate=86400";
}
function sendWidgetAsset(req, res, next, root, rel) {
    const fs = require("fs");
    const resolvedRoot = path.resolve(root);
    let file = path.resolve(resolvedRoot, `.${rel}`);
    if (!file.startsWith(resolvedRoot + path.sep)) return next();
    let cacheControl = widgetCacheControl(rel);
    if (res.locals.widgetFramePolicy && rel === "/index.html") cacheControl = "private, no-store";
    if (!fs.existsSync(file) && HASHED_FRAME_ASSET.test(rel)) {
        file = path.join(resolvedRoot, `frame.${rel.match(HASHED_FRAME_ASSET)[1]}`);
        cacheControl = "no-cache";
    }
    let stat;
    try {
        stat = fs.statSync(file);
    } catch (error) {
        return next();
    }
    const type = WIDGET_TYPES[path.extname(file)];
    if (!stat.isFile() || !type) return next();

    const accept = String(req.headers["accept-encoding"] || "");
    let chosen = file;
    let encoding = null;
    if (/\bbr\b/.test(accept) && fs.existsSync(`${file}.br`)) {
        chosen = `${file}.br`;
        encoding = "br";
    } else if (/\bgzip\b/.test(accept) && fs.existsSync(`${file}.gz`)) {
        chosen = `${file}.gz`;
        encoding = "gzip";
    }
    // Set before sendFile: it keeps a Content-Type that is already present,
    // which matters because the file on disk may be frame.js.br.
    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", cacheControl);
    res.setHeader("Vary", "Accept-Encoding");
    if (encoding) res.setHeader("Content-Encoding", encoding);
    return res.sendFile(chosen, { cacheControl: false, dotfiles: "deny" }, (error) => {
        if (error && !res.headersSent) next(error);
    });
}

app.get("/widget.js", widgetCors, embeddable, requireWidgetBuild, (req, res, next) =>
    sendWidgetAsset(req, res, next, widgetDist, "/widget.js")
);
app.get("/widget/demo", demoPage, (req, res) => {
    res.sendFile(path.join(widgetDist, "demo.html"));
});
// Side-by-side comparison against Intercom — internal demo page, not customer-facing.
app.get("/widget/compare", demoPage, (req, res) => {
    res.sendFile(path.join(widgetDist, "compare.html"));
});
// Theme derivation lab — renders the server's token derivation across test brand colors.
app.get("/widget/sdk-demo", demoPage, (req, res) => {
    res.sendFile(path.join(widgetDist, "sdk-demo.html"));
});
app.get("/widget/theme-lab", demoPage, (req, res) => {
    res.sendFile(path.join(widgetDist, "theme-lab.html"));
});
app.get("/widget/theme-lab.js", demoPage, (req, res) => {
    res.sendFile(path.join(widgetDist, "theme-lab.js"));
});
app.use(
    "/widget/frame",
    embeddable,
    requireWidgetBuild,
    widgetFramePolicy,
    (req, res, next) => {
        if (req.method !== "GET" && req.method !== "HEAD") return next();
        let rel;
        try {
            rel = decodeURIComponent(req.path);
        } catch (error) {
            return next();
        }
        if (rel === "/") {
            // /widget/frame without the slash must redirect first, or the
            // page's relative ./frame.<hash>.js resolves one directory too high.
            if (!req.originalUrl.split("?")[0].endsWith("/")) return next();
            rel = "/index.html";
        }
        return sendWidgetAsset(req, res, next, path.join(widgetDist, "frame"), rel);
    },
    express.static(path.join(widgetDist, "frame"), { maxAge: "5m" })
);
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
app.use("/api/org", dashboardCors, mcpRoutes.management);
app.use("/api/org", dashboardCors, mcpOAuthRoutes.management);
app.use("/api/auth", dashboardCors, mcpOAuthRoutes.session);
app.use(mcpOAuthRoutes.publicRoutes);
app.use("/mcp", mcpRoutes.endpoint);
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
        const readiness = await indexReadiness.ensureCriticalIndexes();
        if (!readiness.success) throw new Error("Critical uniqueness constraints are not ready");
        indexesReady = true;
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

// The realtime hub shares this http server rather than opening a second
// port: one origin, one TLS certificate, and no extra firewall rule for a
// customer's network to block.
const httpServer = http.createServer(app);
realtimeHub.attach(httpServer);

httpServer.listen(config.PORT, () => {
    console.log(`Server: Zealoop backend listening on port ${config.PORT}`);
});

connectWithRetry();

// Run cron on one designated scheduler instance. API replicas can opt out;
// awaiting each job also lets node-cron prevent overlap within that instance.
function scheduleJob(name, expression, task) {
    if (!config.SCHEDULED_JOBS_ENABLED) return;
    cron.schedule(expression, async () => {
        if (!indexesReady || mongoose.connection.readyState !== 1) return;
        try { await task(); }
        catch (error) { console.error(`Scheduled job ${name} failed`, error.message); generalFunctions.captureException(error); }
    }, { name, noOverlap: true, timezone: "UTC" });
}
// Autonomous resolution is computed by cron, never at write time (§11).
scheduleJob("resolutions", config.RESOLUTION_CRON, () => analyticsFunctions.computeResolutions());

// Retention purge (§8.1). Disabled unless RETENTION_DAYS is set — a workspace
// that has not chosen a window keeps its data, and an unset variable must never
// read as "delete everything".
if (config.RETENTION_DAYS > 0) {
    scheduleJob("retention", config.RETENTION_CRON, () => complianceFunctions.purgeExpired());
    console.log(`Server: retention purge scheduled (${config.RETENTION_DAYS} days, ${config.RETENTION_CRON})`);
}

// Attribution counters (§2.5). Computed from TurnTrace rather than incremented
// at write time — see attributionFunctions for why.
scheduleJob("attribution", config.ATTRIBUTION_CRON, () => attributionFunctions.computeAttribution({}));

// Answer quality grading (§3.4). Runs on 100% of conversations, unlike thumbs
// feedback which arrives on under 5%.
scheduleJob("quality", config.QUALITY_CRON, () => qualityFunctions.gradePending({}));

// Trial notices, dunning and suspension (§0.5). Idempotent end to end, which is
// what makes it safe on a schedule that will occasionally fire twice.
scheduleJob("lifecycle", config.LIFECYCLE_CRON, () => subscriptionFunctions.runLifecycleSweep({}));

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
    scheduleJob("source-syncs", "*/15 * * * *", () => knowledgeFunctions.enqueueScheduledSyncs());
}
