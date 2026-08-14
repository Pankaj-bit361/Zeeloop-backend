"use strict";

// New Relic agent config. The agent looks for this file by name in the app root
// and reads it before instrumenting anything, so keep it dependency-free —
// requiring config/config.js here would pull in dotenv after the agent has
// already decided whether it is enabled.
//
// Every value falls back to an env var, so the deployed box can override
// without editing this file.
exports.config = {
    app_name: [process.env.NEW_RELIC_APP_NAME || "zealoop-backend"],
    license_key: process.env.NEW_RELIC_LICENSE_KEY || "",

    // Agent's own diagnostic log, not application logs. stdout keeps it inside
    // whatever the process manager already captures instead of writing a
    // newrelic_agent.log that nothing rotates.
    logging: {
        level: process.env.NEW_RELIC_LOG_LEVEL || "warn",
        filepath: "stdout",
    },

    distributed_tracing: { enabled: true },

    // Ships console/stdout output to New Relic and stamps each line with the
    // trace id, which is what makes "this 500 → these log lines" work.
    application_logging: {
        enabled: true,
        forwarding: { enabled: true, max_samples_stored: 10000 },
        metrics: { enabled: true },
        // The forwarder already carries the trace id; decorating stdout too
        // would just make local `pm2 logs` output noisier to read.
        local_decorating: { enabled: false },
    },

    error_collector: {
        enabled: true,
        // These are client mistakes, not defects. Collecting them buries the
        // real errors and burns ingest quota.
        ignore_status_codes: [400, 401, 403, 404, 409, 429],
    },

    transaction_tracer: {
        enabled: true,
        record_sql: "obfuscated",
    },

    // ── PII ──────────────────────────────────────────────────────────
    // Zealoop handles end-user conversations from customer sites, plus org API
    // keys and widget secrets. Anything listed here never leaves the process.
    attributes: {
        exclude: [
            "request.headers.cookie",
            "request.headers.authorization",
            "request.headers.x-api-key",
            "request.headers.setCookie*",
            "response.headers.setCookie*",
            "request.body.*",
            "*.apiKey",
            "*.widgetSecret",
            "*.clientSecret",
            "*.publicKey",
            "*.identity",
            "*.content",
            "*.email",
        ],
    },

    // Widget traffic runs on customer sites and is high-volume; / and /health
    // are pinged by the load balancer every 5s — roughly 17k requests a day
    // that would otherwise dominate both the throughput chart and the 100 GB
    // ingest allowance while saying nothing.
    rules: {
        ignore: ["^/$", "^/health$", "^/widget.js$", "^/widget/frame"],
    },
};
