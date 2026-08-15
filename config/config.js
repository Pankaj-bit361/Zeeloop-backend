require("dotenv").config();

const PORT = process.env.PORT || 4000;
const DEFAULT_SESSION_SECRET = "zealoop-dev-session-secret-change-in-production";
const SESSION_SECRET = process.env.SESSION_SECRET || DEFAULT_SESSION_SECRET;

const DEFAULT_JWT_SECRET = "change-me-in-production";
const DEFAULT_ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000000";

/* §8.6 — every secret that is load-bearing fails CLOSED.

   Only SESSION_SECRET used to be checked, and only when NODE_ENV was
   "production" — a variable this repo sets nowhere, so in practice the check
   never ran at all. The other two had defaults that are published verbatim in
   .env.example and ci.yml:

     JWT_SECRET is the entire tenancy boundary. Every /api/org route trusts the
     orgId inside a token signed with it. Known secret means anyone mints a
     token for any workspace, and nothing anywhere logs that it happened.

     ENCRYPTION_KEY is 64 zeros, which parses as a perfectly valid AES-256 key
     — so it fails silently rather than loudly. Widget secrets, action
     credentials and webhook secrets encrypted under it are readable by anyone
     with a copy of this repo, and RUNBOOK §8 states there is no recovery path
     for data encrypted under a lost or wrong key.

   The gate is now inverted: insecure defaults are refused UNLESS an operator
   has explicitly said this is a development machine. An unset variable is the
   dangerous case, so an unset variable is the one that stops the boot. */
const ALLOW_INSECURE = process.env.ALLOW_INSECURE_DEFAULTS === "true";

const INSECURE = [
    ["SESSION_SECRET", SESSION_SECRET, DEFAULT_SESSION_SECRET],
    ["JWT_SECRET", process.env.JWT_SECRET || DEFAULT_JWT_SECRET, DEFAULT_JWT_SECRET],
    ["ENCRYPTION_KEY", process.env.ENCRYPTION_KEY || DEFAULT_ENCRYPTION_KEY, DEFAULT_ENCRYPTION_KEY],
].filter(([, value, fallback]) => value === fallback);

if (INSECURE.length && !ALLOW_INSECURE) {
    throw new Error(
        `Refusing to boot: ${INSECURE.map(([name]) => name).join(", ")} ` +
            `${INSECURE.length === 1 ? "is" : "are"} unset or still the published default value. ` +
            "Set them, or set ALLOW_INSECURE_DEFAULTS=true if this is a development machine."
    );
}

if (INSECURE.length) {
    console.warn(
        `config: running with insecure default ${INSECURE.map(([name]) => name).join(", ")} ` +
            "— ALLOW_INSECURE_DEFAULTS is set. Never do this on a deployment that holds real data."
    );
}

module.exports = {
    PORT,
    MONGODB_URI: process.env.MONGODB_URI || "mongodb://localhost:27017/zealoop",
    JWT_SECRET: process.env.JWT_SECRET || DEFAULT_JWT_SECRET,
    // Explicit opt-in for the dev-login route. Anything but the exact string
    // "true" — including absence — leaves it off. See authFunctions.devLogin.
    ENABLE_DEV_LOGIN: process.env.ENABLE_DEV_LOGIN === "true",

    // ── dashboard sign-in ──
    SESSION_SECRET,
    SESSION_COOKIE: "zealoop_session",
    OAUTH_STATE_COOKIE: "zealoop_oauth_state",
    // Cookies can only carry the Secure flag where there is TLS; local dev is
    // plain http, so forcing it on would mean the browser silently drops every
    // session cookie and sign-in appears to do nothing.
    COOKIE_SECURE: process.env.COOKIE_SECURE === "true" || process.env.NODE_ENV === "production",
    // Where the dashboard lives — every post-auth redirect lands here.
    APP_URL: process.env.APP_URL || "http://localhost:5173",
    // Where this API answers. Must match the redirect URI registered with each
    // OAuth provider exactly, port included.
    API_URL: process.env.API_URL || `http://localhost:${PORT}`,
    DISABLE_SIGNUPS: process.env.DISABLE_SIGNUPS === "true",

    // ── OAuth providers (optional — the buttons hide themselves when unset) ──
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || "",
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || "",
    GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID || "",
    GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET || "",

    // 32-byte hex key for AES-256-GCM
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || DEFAULT_ENCRYPTION_KEY,
    SENTRY_DSN: process.env.SENTRY_DSN || "",
    // Read directly from process.env in server.js and requestContext.js — the
    // agent has to load before this module does. Mirrored here for visibility.
    NEW_RELIC_LICENSE_KEY: process.env.NEW_RELIC_LICENSE_KEY || "",
    NEW_RELIC_APP_NAME: process.env.NEW_RELIC_APP_NAME || "zealoop-backend",
    // Lets the test run opt out even when a key is present in .env. Without
    // this every `npm test` boots the agent, spends six seconds probing cloud
    // metadata endpoints, and reports test traffic as production data.
    NEW_RELIC_ENABLED: process.env.NEW_RELIC_ENABLED !== "false",

    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || "",
    OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
    // OpenRouter is OpenAI-compatible, so these can be any slug it serves
    SMALL_MODEL: process.env.SMALL_MODEL || "anthropic/claude-haiku-4.5",
    LARGE_MODEL: process.env.LARGE_MODEL || "anthropic/claude-sonnet-5",
    // Retried once when the primary model 5xxes or the request fails outright
    // (§8.3). Chat only — see the note on LlmFunctions.complete for why
    // embeddings must never fall back.
    FALLBACK_MODEL: process.env.FALLBACK_MODEL || "openai/gpt-5-mini",
    // Must produce vectors matching EMBEDDING_DIM. Gemini Embedding 2 has
    // flexible output dims (128–3072); we request EMBEDDING_DIM explicitly.
    EMBED_MODEL: process.env.EMBED_MODEL || "google/gemini-embedding-2",

    // Direct Google embeddings. When set, embeddings go straight to Google
    // instead of through OpenRouter — same model, so the vectors land in the
    // same space and nothing needs re-embedding. This exists because routing
    // Gemini through OpenRouter's BYOK path depends on a Google Cloud project
    // whose billing can block the whole pipeline, which is exactly what
    // happened on 15 August 2026.
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
    GEMINI_BASE_URL: process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta",
    // The bare model id, without the OpenRouter "google/" vendor prefix.
    GEMINI_EMBED_MODEL: process.env.GEMINI_EMBED_MODEL || "gemini-embedding-2",
    // batchEmbedContents caps how many inputs one request may carry.
    GEMINI_EMBED_BATCH_SIZE: Number(process.env.GEMINI_EMBED_BATCH_SIZE || 100),
    // Optional. No key → rerank throws → pipeline degrades to fusion order.
    VOYAGE_API_KEY: process.env.VOYAGE_API_KEY || "",
    RERANK_MODEL: "rerank-2.5",
    EMBEDDING_DIM: 1024,

    // Retrieval
    VECTOR_INDEX_NAME: "chunk_vector_index",
    TEXT_INDEX_NAME: "chunk_text_index",
    FUSION_K: 60,
    RETRIEVAL_CANDIDATES: 40,
    RERANK_TOP_N: 5,
    RERANK_THRESHOLD: 0.55,

    // Chunking
    CHUNK_TARGET_TOKENS: 600,
    CHUNK_OVERLAP_RATIO: 0.15,

    // Generation
    MAX_TOOL_ITERATIONS: 4,
    MAX_OUTPUT_TOKENS: 1024,

    // Pricing per million tokens, used by estimateCostUsd
    PRICE_PER_MTOK: {
        "anthropic/claude-haiku-4.5": { input: 1, output: 5 },
        "anthropic/claude-sonnet-5": { input: 3, output: 15 },
    },

    // ── Billing ──────────────────────────────────────────────────────
    // Which adapter functions/billing/providers resolves. NONE means checkout
    // returns 503 and everything stays on the free plan — the backend must run
    // without a payment provider, same as it runs without Sentry.
    BILLING_PROVIDER: process.env.BILLING_PROVIDER || "NONE",
    LEMON_SQUEEZY_API_KEY: process.env.LEMON_SQUEEZY_API_KEY || "",
    LEMON_SQUEEZY_STORE_ID: process.env.LEMON_SQUEEZY_STORE_ID || "",
    LEMON_SQUEEZY_WEBHOOK_SECRET: process.env.LEMON_SQUEEZY_WEBHOOK_SECRET || "",
    // One variant id per paid plan, from the provider dashboard. Keyed by PlanId
    // so plans.js stays provider-agnostic.
    BILLING_VARIANT_IDS: {
        STARTER: process.env.BILLING_VARIANT_STARTER || "",
        GROWTH: process.env.BILLING_VARIANT_GROWTH || "",
        SCALE: process.env.BILLING_VARIANT_SCALE || "",
    },

    // ── Abuse and cost control (§8.2) ────────────────────────────────
    // Widget endpoints are public by design, so these are the only thing
    // between a scraped publicKey and an unbounded model bill.
    RATE_LIMIT_WINDOW_MS: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
    RATE_LIMIT_PER_END_USER: Number(process.env.RATE_LIMIT_PER_END_USER || 20),
    RATE_LIMIT_PER_ORG: Number(process.env.RATE_LIMIT_PER_ORG || 300),
    RATE_LIMIT_PER_IP: Number(process.env.RATE_LIMIT_PER_IP || 60),

    // ── Data handling (§8.1) ─────────────────────────────────────────
    // Conversations and traces older than this are purged by cron. 0 disables.
    RETENTION_DAYS: Number(process.env.RETENTION_DAYS || 0),
    RETENTION_CRON: process.env.RETENTION_CRON || "0 3 * * *",
    // Redact emails, phone numbers and card-shaped digits before anything is
    // written to TurnTrace or sent to a model provider.
    PII_REDACTION_ENABLED: process.env.PII_REDACTION_ENABLED !== "false",
    // Emails are redacted from stored traces always, but only from model input
    // when this is on. "Check the order for maya@brightloop.io" loses its
    // subject otherwise — and identity is proven by a signed identify()
    // payload, not by an address typed into a message, so leaving it in does
    // not unlock anything.
    PII_REDACT_MODEL_EMAIL: process.env.PII_REDACT_MODEL_EMAIL === "true",

    // ── Transactional email (§0.5, §4.8) ─────────────────────────────
    // No key means every send is logged with delivered:false and the body
    // intact, rather than crashing or silently vanishing — same rule as Sentry.
    EMAIL_API_KEY: process.env.EMAIL_API_KEY || "",
    EMAIL_API_BASE_URL: process.env.EMAIL_API_BASE_URL || "https://api.resend.com",
    EMAIL_FROM: process.env.EMAIL_FROM || "Zealoop <notifications@zealoop.com>",
    // Inbound address pattern for the email channel. `{token}` is replaced with
    // the workspace's inbound token, so each workspace gets its own address on
    // one verified domain rather than needing a domain each.
    EMAIL_INBOUND_DOMAIN: process.env.EMAIL_INBOUND_DOMAIN || "in.zealoop.com",
    // Shared secret on the inbound parse endpoint. Without it that endpoint is
    // an unauthenticated way to inject messages into any workspace, so it
    // refuses to accept anything when unset.
    EMAIL_INBOUND_SECRET: process.env.EMAIL_INBOUND_SECRET || "",
    // Trial and dunning crons. Both are idempotent via EmailLog's unique index.
    LIFECYCLE_CRON: process.env.LIFECYCLE_CRON || "0 9 * * *",

    // ── Setup wizard and brand import (§1.6, §1.7) ───────────────────
    BRANDFETCH_API_KEY: process.env.BRANDFETCH_API_KEY || "",
    BRANDFETCH_BASE_URL: process.env.BRANDFETCH_BASE_URL || "https://api.brandfetch.io/v2",

    // ── File ingest (§1.2) ───────────────────────────────────────────
    // Bytes, before base64 expansion. Uploads arrive as base64 in a JSON body,
    // so JSON_BODY_LIMIT has to be comfortably above this — base64 costs ~33%.
    MAX_UPLOAD_BYTES: Number(process.env.MAX_UPLOAD_BYTES || 10 * 1024 * 1024),

    // ── Crawl worker (§1.3) ──────────────────────────────────────────
    // In-process worker, polled on this interval. Not BullMQ: Redis is not in
    // this stack, and adding an operational dependency to get a queue this
    // shape would be a bigger change than the feature.
    CRAWL_WORKER_ENABLED: process.env.CRAWL_WORKER_ENABLED !== "false",
    CRAWL_WORKER_INTERVAL_MS: Number(process.env.CRAWL_WORKER_INTERVAL_MS || 5000),
    CRAWL_MAX_ATTEMPTS: Number(process.env.CRAWL_MAX_ATTEMPTS || 3),
    // How long a job may be claimed before another worker may take it. Covers
    // the case where the instance holding it died mid-crawl.
    CRAWL_LEASE_MS: Number(process.env.CRAWL_LEASE_MS || 10 * 60 * 1000),

    // ── Evaluation (§3) ──────────────────────────────────────────────
    // Quality grading and recommendation clustering both run on cron so they
    // never touch a turn's latency.
    QUALITY_CRON: process.env.QUALITY_CRON || "*/30 * * * *",
    QUALITY_BATCH_SIZE: Number(process.env.QUALITY_BATCH_SIZE || 25),
    ATTRIBUTION_CRON: process.env.ATTRIBUTION_CRON || "*/20 * * * *",
    // Cosine distance below which two below-threshold queries are the same gap.
    GAP_CLUSTER_THRESHOLD: Number(process.env.GAP_CLUSTER_THRESHOLD || 0.18),
    // Simulations and batch tests run turns in parallel; this caps how many at
    // once so one run cannot saturate the model provider for live traffic.
    EVAL_CONCURRENCY: Number(process.env.EVAL_CONCURRENCY || 3),
    SIMULATION_MAX_TURNS: Number(process.env.SIMULATION_MAX_TURNS || 6),

    // ── Security (§8.4) ──────────────────────────────────────────────
    // How long a rotated widget secret keeps working, so a customer can deploy
    // their new signing code without a window where identify() fails.
    SECRET_ROTATION_GRACE_HOURS: Number(process.env.SECRET_ROTATION_GRACE_HOURS || 48),
    // Only ever true in local development: it disables the https-and-public-host
    // check on outbound webhook URLs, which otherwise makes them an SSRF
    // primitive pointed at our own network.
    ALLOW_INSECURE_WEBHOOKS: process.env.ALLOW_INSECURE_WEBHOOKS === "true",

    // ── Structured logging (§8.3) ────────────────────────────────────
    // "json" routes every console.* call through pino so New Relic's log
    // forwarder can see it — it forwards pino/winston/bunyan and ignores
    // console entirely. "pretty" leaves console alone, which is what local
    // development wants.
    LOG_FORMAT: process.env.LOG_FORMAT || (process.env.NODE_ENV === "production" ? "json" : "pretty"),
    LOG_LEVEL: process.env.LOG_LEVEL || "info",

    CORS_DASHBOARD_ORIGINS: (process.env.CORS_DASHBOARD_ORIGINS || "http://localhost:5173").split(","),
    JSON_BODY_LIMIT: "1mb",
    RESOLUTION_CRON: "*/15 * * * *",
    RESOLUTION_WINDOW_HOURS: 24,
};
