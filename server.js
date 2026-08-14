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
const { requestContext } = require("./middlewares/requestContext");
const { widgetRateLimit } = require("./middlewares/rateLimit");

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

// OAuth round-trip. Root-mounted and CORS-free: the provider redirect URIs are
// registered as ${API_URL}/auth/<provider>/callback and every hop is a top-level
// navigation, never a cross-origin fetch.
app.use("/auth", oauthRoutes);

// Provider webhooks. Root-mounted and CORS-free for the same reason as OAuth:
// these are server-to-server posts whose URL is registered with the provider,
// and the signature is the credential.
app.use("/webhooks", webhookRoutes);

// Rate limiting sits on the widget mount rather than inside the router, so a
// route added later is covered by default instead of by remembering.
app.use("/api/widget", widgetCors, widgetRateLimit, widgetRoutes);

// ── Widget static assets ─────────────────────────────────────
// widget.js is embedded by customer sites; the frame is loaded in an iframe on
// those same sites. helmet's defaults (frame-ancestors 'self' + X-Frame-Options
// SAMEORIGIN) would block exactly that, so these routes override both. That is
// safe: the frame holds no session — every request inside it re-authenticates
// with the org publicKey.
const widgetDist = path.join(__dirname, "../widget/dist");
const embeddable = (req, res, next) => {
    res.removeHeader("X-Frame-Options");
    res.setHeader("Content-Security-Policy", "frame-ancestors *");
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
app.use("/api/analytics", dashboardCors, analyticsRoutes);

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
