const config = require("../../config/config");
const generalFunctions = require("./generalFunctions");
const redactionFunctions = require("./redactionFunctions");

// Typed error so every caller can decide fail-open vs fail-closed.
class LlmError extends Error {
    constructor(provider, message, status) {
        super(`${provider}: ${message}`);
        this.name = "LlmError";
        this.provider = provider;
        this.status = status;
    }
}

// The ONLY file that talks to model providers. Chat completions and embeddings
// go through OpenRouter (OpenAI-compatible, any slug it serves); reranking is
// Voyage because OpenRouter has no rerank API, and it is optional — no key
// means the pipeline falls back to fusion order. Swapping a provider means
// changing one method here.
class LlmFunctions {
    // Retries once against FALLBACK_MODEL on a 5xx or a network failure (§8.3).
    // Deliberately not on 4xx: a bad request or an exhausted key fails the same
    // way on any model, and retrying just doubles the latency before the same
    // error.
    //
    // There is no equivalent for embed(). Falling back to a different embedding
    // model would produce vectors in a different space from every chunk already
    // stored, so retrieval would silently return nonsense — strictly worse than
    // failing. Changing EMBED_MODEL means re-embedding the corpus.
    async complete(params) {
        try {
            return await this._completeOnce(params);
        } catch (error) {
            const retryable = !error.status || error.status >= 500;
            const fallback = config.FALLBACK_MODEL;
            const alreadyFallback = (params.model || config.SMALL_MODEL) === fallback;

            if (!retryable || !fallback || alreadyFallback) throw error;

            console.error(
                "LlmFunctions:complete: primary model failed, retrying on fallback:",
                fallback,
                "status:",
                error.status
            );
            return await this._completeOnce({ ...params, model: fallback });
        }
    }

    async _completeOnce({ model, system, messages, maxTokens }) {
        console.log("LlmFunctions:complete: model:", model);
        // Card and phone numbers never need to reach a third-party model to
        // answer a support question, so they are scrubbed here — the one place
        // every completion passes through. Emails are left in by default
        // because they are frequently what the question is about; see
        // PII_REDACT_MODEL_EMAIL.
        messages = (messages || []).map((message) =>
            typeof message.content === "string"
                ? { ...message, content: redactionFunctions.redactForModel(message.content) }
                : message
        );
        const response = await fetch(`${config.OPENROUTER_BASE_URL}/chat/completions`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
                "content-type": "application/json",
                "HTTP-Referer": "https://zealoop.com",
                "X-Title": "Zealoop",
            },
            body: JSON.stringify({
                model: model || config.SMALL_MODEL,
                max_tokens: maxTokens || config.MAX_OUTPUT_TOKENS,
                messages: [...(system ? [{ role: "system", content: system }] : []), ...messages],
            }),
        });

        if (!response.ok) {
            const body = await response.text();
            throw new LlmError("openrouter", `complete failed: ${body}`, response.status);
        }

        const data = await response.json();
        const choice = data.choices && data.choices[0];
        if (!choice || !choice.message) {
            throw new LlmError("openrouter", "complete failed: empty choices in response", 502);
        }
        const text = choice.message.content || "";
        return {
            text,
            inputTokens: data.usage ? data.usage.prompt_tokens : generalFunctions.estimateTokens(JSON.stringify(messages)),
            outputTokens: data.usage ? data.usage.completion_tokens : generalFunctions.estimateTokens(text),
        };
    }

    // complete() that must return JSON matching the caller's shape. Retries once
    // on unparseable output, then throws.
    async completeJson({ model, system, messages, maxTokens, schemaHint }) {
        console.log("LlmFunctions:completeJson: model:", model);
        const jsonSystem = `${system || ""}\n\nRespond with ONLY a valid JSON object${schemaHint ? ` of shape: ${schemaHint}` : ""}. No prose, no markdown fences.`;

        let lastError = null;
        let totals = { inputTokens: 0, outputTokens: 0 };
        for (let attempt = 0; attempt < 2; attempt++) {
            const result = await this.complete({ model, system: jsonSystem, messages, maxTokens });
            totals.inputTokens += result.inputTokens;
            totals.outputTokens += result.outputTokens;
            try {
                const cleaned = result.text.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
                return { json: JSON.parse(cleaned), ...totals };
            } catch (error) {
                lastError = error;
            }
        }
        throw new LlmError("openrouter", `completeJson: model returned invalid JSON twice: ${lastError.message}`, 502);
    }

    // Two transports, ONE model. Google direct is preferred when a key is set;
    // OpenRouter is the fallback. Falling back is safe here in a way a model
    // fallback never is — both routes call gemini-embedding-2, so the vectors
    // land in the same space as every chunk already stored. Changing the model
    // would not be safe, which is why there is still no model fallback.
    async embed({ texts, fetchImpl = fetch }) {
        console.log("LlmFunctions:embed: count:", texts.length);

        if (config.GEMINI_API_KEY) {
            try {
                return await this._embedGoogle({ texts, fetchImpl });
            } catch (error) {
                // A wrong dimension is a configuration error, not a transport
                // failure. Retrying it on OpenRouter would replace the real
                // cause with whatever OpenRouter happens to say, which is how a
                // five-minute fix becomes an afternoon.
                if (error.fatal) throw error;
                console.error("LlmFunctions:embed: Google direct failed, falling back to OpenRouter:", error.message);
            }
        }

        return await this._embedOpenRouter({ texts, fetchImpl });
    }

    // Google caps how many inputs one batchEmbedContents call may carry, so
    // long ingests are split. Batches run sequentially: a source with a
    // thousand chunks should not open ten concurrent connections to the
    // embedding API and get itself rate limited.
    async _embedGoogle({ texts, fetchImpl = fetch }) {
        const model = config.GEMINI_EMBED_MODEL;
        const size = Math.max(1, config.GEMINI_EMBED_BATCH_SIZE);
        const embeddings = [];

        for (let start = 0; start < texts.length; start += size) {
            const batch = texts.slice(start, start + size);
            const response = await fetchImpl(
                `${config.GEMINI_BASE_URL}/models/${model}:batchEmbedContents?key=${config.GEMINI_API_KEY}`,
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        requests: batch.map((text) => ({
                            model: `models/${model}`,
                            content: { parts: [{ text }]},
                            outputDimensionality: config.EMBEDDING_DIM,
                        })),
                    }),
                }
            );

            if (!response.ok) {
                const body = await response.text();
                throw new LlmError("google", `embed failed: ${body}`, response.status);
            }

            const data = await response.json();
            if (!data.embeddings || data.embeddings.length !== batch.length) {
                throw new LlmError(
                    "google",
                    `embed failed: asked for ${batch.length} vectors, got ${(data.embeddings || []).length}`,
                    502
                );
            }
            // batchEmbedContents preserves request order, so a positional push
            // keeps chunk N aligned with vector N.
            embeddings.push(...data.embeddings.map((item) => item.values));
        }

        if (embeddings[0] && embeddings[0].length !== config.EMBEDDING_DIM) {
            const error = new LlmError(
                "google",
                `embed failed: ${model} returned ${embeddings[0].length}-dim vectors, expected ${config.EMBEDDING_DIM}. Model and Atlas index dimensions must match.`,
                502
            );
            // Not worth retrying on another transport — the same misconfigured
            // dimension would come back.
            error.fatal = true;
            throw error;
        }
        return embeddings;
    }

    async _embedOpenRouter({ texts, fetchImpl = fetch }) {
        const response = await fetchImpl(`${config.OPENROUTER_BASE_URL}/embeddings`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
                "content-type": "application/json",
                "HTTP-Referer": "https://zealoop.com",
                "X-Title": "Zealoop",
            },
            body: JSON.stringify({
                model: config.EMBED_MODEL,
                input: texts,
                dimensions: config.EMBEDDING_DIM,
                encoding_format: "float",
            }),
        });

        if (!response.ok) {
            const body = await response.text();
            throw new LlmError("openrouter", `embed failed: ${body}`, response.status);
        }

        const data = await response.json();
        const embeddings = data.data
            .slice()
            .sort((a, b) => a.index - b.index)
            .map((item) => item.embedding);
        if (embeddings[0] && embeddings[0].length !== config.EMBEDDING_DIM) {
            throw new LlmError(
                "openrouter",
                `embed failed: ${config.EMBED_MODEL} returned ${embeddings[0].length}-dim vectors, expected ${config.EMBEDDING_DIM}. Model and Atlas index dimensions must match.`,
                502
            );
        }
        return embeddings;
    }

    // OpenRouter has no rerank API yet, so this stays on Voyage. Without a
    // VOYAGE_API_KEY it throws immediately and the pipeline degrades to fusion
    // order — rerank is an upgrade, not a dependency.
    async rerank({ query, documents, topN }) {
        console.log("LlmFunctions:rerank: docs:", documents.length);
        if (!config.VOYAGE_API_KEY) {
            throw new LlmError("voyage", "rerank skipped: VOYAGE_API_KEY not set", 503);
        }
        const response = await fetch("https://api.voyageai.com/v1/rerank", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${config.VOYAGE_API_KEY}`,
                "content-type": "application/json",
            },
            body: JSON.stringify({
                model: config.RERANK_MODEL,
                query,
                documents,
                top_k: topN || config.RERANK_TOP_N,
            }),
        });

        if (!response.ok) {
            const body = await response.text();
            throw new LlmError("voyage", `rerank failed: ${body}`, response.status);
        }

        const data = await response.json();
        // [{ index, relevance_score }] sorted best-first
        return data.data.map((item) => ({ index: item.index, score: item.relevance_score }));
    }
}

module.exports = new LlmFunctions();
module.exports.LlmError = LlmError;
