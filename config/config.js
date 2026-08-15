require("dotenv").config();

const PORT = process.env.PORT || 4000;
const DEFAULT_SESSION_SECRET = "zealoop-dev-session-secret-change-in-production";
const SESSION_SECRET = process.env.SESSION_SECRET || DEFAULT_SESSION_SECRET;

// A guessable HMAC secret means anyone can mint a session cookie for any
// account. Refuse to boot rather than run silently forgeable.
if (process.env.NODE_ENV === "production" && SESSION_SECRET === DEFAULT_SESSION_SECRET) {
    throw new Error("SESSION_SECRET must be set to a non-default value in production.");
}

module.exports = {
    PORT,
    MONGODB_URI: process.env.MONGODB_URI || "mongodb://localhost:27017/zealoop",
    JWT_SECRET: process.env.JWT_SECRET || "change-me-in-production",

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
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || "0000000000000000000000000000000000000000000000000000000000000000",
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

    CORS_DASHBOARD_ORIGINS: (process.env.CORS_DASHBOARD_ORIGINS || "http://localhost:5173").split(","),
    JSON_BODY_LIMIT: "1mb",
    RESOLUTION_CRON: "*/15 * * * *",
    RESOLUTION_WINDOW_HOURS: 24,
};
