const mongoose = require("mongoose");
const config = require("../../config/config");
const generalFunctions = require("../utilFunctions/generalFunctions");

// Deep health (§8.3). Deliberately NOT what the load balancer checks: / and
// /health stay liveness-only, because a health check that queries Mongo turns a
// database blip into every instance being pulled out of service at once, which
// converts a partial outage into a total one.
//
// This endpoint answers a different question — "is this deployment actually
// able to do its job" — and is for humans and uptime monitors.

const CHECK_TIMEOUT_MS = 5000;

const Status = {
    OK: "ok",
    DEGRADED: "degraded",
    FAILING: "failing",
    UNKNOWN: "unknown",
};

// A check that hangs is a check that never reports. Everything here is raced
// against a timeout so one dead provider cannot hold the whole response.
function withTimeout(promise, label) {
    return Promise.race([
        promise,
        new Promise((resolve) =>
            setTimeout(() => resolve({ status: Status.FAILING, detail: `${label} timed out after ${CHECK_TIMEOUT_MS}ms` }), CHECK_TIMEOUT_MS)
        ),
    ]);
}

class HealthFunctions {
    // ── Public Functions ─────────────────────────────────────────────

    async deepCheck() {
        console.log("HealthFunctions:deepCheck");
        try {
            const [database, search, chat, embedding] = await Promise.all([
                withTimeout(this._checkDatabase(), "database"),
                withTimeout(this._checkSearchIndexes(), "search indexes"),
                withTimeout(this._checkChatProvider(), "chat provider"),
                withTimeout(this._checkEmbeddingProvider(), "embedding provider"),
            ]);

            const checks = { database, search, chat, embedding };

            // The database failing means nothing works. Everything else
            // degrades the product without stopping it, so it reports degraded
            // rather than failing — an uptime monitor should page differently
            // for "cannot serve" than for "answers are worse".
            let status = Status.OK;
            if (database.status === Status.FAILING) status = Status.FAILING;
            else if (Object.values(checks).some((check) => check.status === Status.FAILING)) status = Status.DEGRADED;
            else if (Object.values(checks).some((check) => check.status === Status.DEGRADED)) status = Status.DEGRADED;

            return {
                status: status === Status.FAILING ? 503 : 200,
                json: { success: status !== Status.FAILING, status, checks, checkedAt: new Date().toISOString() },
            };
        } catch (error) {
            console.error("HealthFunctions:deepCheck: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 503, json: { success: false, status: Status.FAILING, error: "Health check failed" } };
        }
    }

    // Run once at boot. Hybrid search silently returns empty without the Atlas
    // search indexes — the product looks like it has no knowledge rather than
    // like it is broken, which is the worst possible failure mode and exactly
    // what the PRD calls out. Logged loudly rather than thrown: a dashboard-only
    // deployment is legitimate, and refusing to boot would be worse.
    async assertSearchIndexes() {
        const result = await this._checkSearchIndexes();
        if (result.status === Status.OK) {
            console.log("Server: Atlas search indexes present —", result.detail);
            return { success: true };
        }

        console.error("");
        console.error("  ┌───────────────────────────────────────────────────────────────┐");
        console.error("  │  HYBRID SEARCH IS DISABLED                                    │");
        console.error("  └───────────────────────────────────────────────────────────────┘");
        console.error(`  ${result.detail}`);
        console.error("");
        console.error("  Retrieval will return NO results. The agent will abstain from");
        console.error("  every question rather than reporting an error, so this looks");
        console.error("  like an empty knowledge base rather than a broken deployment.");
        console.error("");
        console.error(`  Required on the chunks collection: ${config.VECTOR_INDEX_NAME}, ${config.TEXT_INDEX_NAME}`);
        console.error("  See backend/README.md for the index definitions.");
        console.error("");
        return { success: false };
    }

    // ── Private Helper Functions ─────────────────────────────────────

    async _checkDatabase() {
        try {
            // 1 = connected. Anything else and a ping would just hang.
            if (mongoose.connection.readyState !== 1) {
                return { status: Status.FAILING, detail: `mongoose readyState ${mongoose.connection.readyState}` };
            }
            const started = Date.now();
            await mongoose.connection.db.admin().ping();
            return { status: Status.OK, latencyMs: Date.now() - started };
        } catch (error) {
            return { status: Status.FAILING, detail: error.message };
        }
    }

    async _checkSearchIndexes() {
        try {
            if (mongoose.connection.readyState !== 1) {
                return { status: Status.UNKNOWN, detail: "database not connected" };
            }

            // listSearchIndexes exists only on Atlas. On a local or self-hosted
            // Mongo it throws, which is itself the answer.
            const indexes = await mongoose.connection.db.collection("chunks").listSearchIndexes().toArray();
            const names = indexes.map((index) => index.name);

            const missing = [config.VECTOR_INDEX_NAME, config.TEXT_INDEX_NAME].filter((name) => !names.includes(name));
            if (missing.length > 0) {
                return { status: Status.FAILING, detail: `missing search indexes: ${missing.join(", ")}`, present: names };
            }
            return { status: Status.OK, detail: names.join(", ") };
        } catch (error) {
            return {
                status: Status.FAILING,
                detail: "this deployment is not on Atlas, or search indexes are unavailable — hybrid search returns empty",
            };
        }
    }

    async _checkChatProvider() {
        if (!config.OPENROUTER_API_KEY) {
            return { status: Status.FAILING, detail: "OPENROUTER_API_KEY is not set" };
        }
        try {
            // A models list rather than a completion: cheap, and it proves the
            // key is live without spending tokens on every health check.
            const response = await fetch(`${config.OPENROUTER_BASE_URL}/models`, {
                headers: { Authorization: `Bearer ${config.OPENROUTER_API_KEY}` },
            });
            if (!response.ok) {
                return { status: Status.FAILING, detail: `provider returned ${response.status}` };
            }
            return { status: Status.OK };
        } catch (error) {
            return { status: Status.FAILING, detail: error.message };
        }
    }

    // Checked separately from chat because they fail independently — as they
    // are doing right now, with completions healthy and embeddings 403.
    async _checkEmbeddingProvider() {
        if (!config.OPENROUTER_API_KEY) {
            return { status: Status.FAILING, detail: "OPENROUTER_API_KEY is not set" };
        }
        try {
            const response = await fetch(`${config.OPENROUTER_BASE_URL}/embeddings`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    model: config.EMBED_MODEL,
                    input: "health",
                    dimensions: config.EMBEDDING_DIM,
                }),
            });
            if (!response.ok) {
                const body = await response.text().catch(() => "");
                return {
                    status: Status.FAILING,
                    detail: `${config.EMBED_MODEL} returned ${response.status}`,
                    // Truncated: the upstream body can be large, and this is
                    // rendered in a monitor.
                    upstream: body.slice(0, 200),
                };
            }
            return { status: Status.OK, model: config.EMBED_MODEL };
        } catch (error) {
            return { status: Status.FAILING, detail: error.message };
        }
    }
}

module.exports = new HealthFunctions();
module.exports.Status = Status;
