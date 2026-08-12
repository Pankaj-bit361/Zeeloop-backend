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
const widgetRoutes = require("./routes/widgetRoutes");
const knowledgeRoutes = require("./routes/knowledgeRoutes");
const actionRoutes = require("./routes/actionRoutes");
const conversationRoutes = require("./routes/conversationRoutes");
const analyticsRoutes = require("./routes/analyticsRoutes");
const authRoutes = require("./routes/authRoutes");
const oauthRoutes = require("./routes/oauthRoutes");
const orgRoutes = require("./routes/orgRoutes");
const tableRoutes = require("./routes/tableRoutes");

const app = express();

app.use(helmet());
app.use(express.json({ limit: config.JSON_BODY_LIMIT }));
app.use(cookieParser());

// Widget routes are public and CORS * — the whole point is running on customer sites.
const widgetCors = cors({ origin: "*" });
// Dashboard routes are restricted to known origins. `credentials` is what lets
// the session cookie ride along; it is also why the origin list can never
// become "*" — browsers reject that pairing outright.
const dashboardCors = cors({ origin: config.CORS_DASHBOARD_ORIGINS, credentials: true });

app.get("/health", (req, res) => res.status(200).json({ success: true, status: "ok" }));

// OAuth round-trip. Root-mounted and CORS-free: the provider redirect URIs are
// registered as ${API_URL}/auth/<provider>/callback and every hop is a top-level
// navigation, never a cross-origin fetch.
app.use("/auth", oauthRoutes);

app.use("/api/widget", widgetCors, widgetRoutes);

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
app.use("/api/analytics", dashboardCors, analyticsRoutes);

app.use((req, res) => {
    return res.status(404).json({ success: false, error: "Not found" });
});

// Global error handler — the last line of defense.
app.use((error, req, res, next) => {
    console.log("Server: global error handler");
    console.log(error);
    generalFunctions.captureSentryException(error);
    return res.status(500).json({ success: false, error: "Internal server error, please contact support" });
});

// Mongo connect with retry — a database blip is a logged retry, not a crash.
async function connectWithRetry() {
    try {
        await mongoose.connect(config.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
        console.log("Server: connected to MongoDB");
    } catch (error) {
        console.log("Server: MongoDB connection failed, retrying in 5s");
        console.log(error.message);
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
