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
    async complete({ model, system, messages, maxTokens }) {
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

    async embed({ texts }) {
        console.log("LlmFunctions:embed: count:", texts.length);
        const response = await fetch(`${config.OPENROUTER_BASE_URL}/embeddings`, {
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
