// Rerank routing: OpenRouter on the chat key by default, Voyage directly only
// when VOYAGE_API_KEY is set. The network is stood in for.
"use strict";
const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");

process.env.NEW_RELIC_ENABLED = "false";
const config = require("../config/config");
const llmFunctions = require("../functions/utilFunctions/llmFunctions");

const realFetch = global.fetch;
const saved = { voyage: config.VOYAGE_API_KEY, openrouter: config.OPENROUTER_API_KEY };
afterEach(() => {
    global.fetch = realFetch;
    config.VOYAGE_API_KEY = saved.voyage;
    config.OPENROUTER_API_KEY = saved.openrouter;
});

test("without a Voyage key, rerank goes to OpenRouter's /rerank with the configured model", async () => {
    config.VOYAGE_API_KEY = "";
    config.OPENROUTER_API_KEY = "sk-or-test";
    let seen = null;
    global.fetch = async (url, init) => {
        seen = { url, body: JSON.parse(init.body), auth: init.headers.Authorization };
        return { ok: true, json: async () => ({ results: [{ index: 1, relevance_score: 0.86 }, { index: 0, relevance_score: 0.25 }] }) };
    };
    const ranked = await llmFunctions.rerank({ query: "pro price", documents: ["a", "b"], topN: 2 });
    assert.equal(seen.url, `${config.OPENROUTER_BASE_URL}/rerank`);
    assert.equal(seen.body.model, config.OPENROUTER_RERANK_MODEL);
    assert.equal(seen.body.top_n, 2);
    assert.equal(seen.auth, "Bearer sk-or-test");
    assert.deepEqual(ranked, [{ index: 1, score: 0.86 }, { index: 0, score: 0.25 }]);
});

test("a Voyage key keeps the direct Voyage path", async () => {
    config.VOYAGE_API_KEY = "pa-test";
    let url = null;
    global.fetch = async (u) => { url = u; return { ok: true, json: async () => ({ data: [{ index: 0, relevance_score: 0.7 }] }) }; };
    const ranked = await llmFunctions.rerank({ query: "q", documents: ["a"], topN: 1 });
    assert.equal(url, "https://api.voyageai.com/v1/rerank");
    assert.deepEqual(ranked, [{ index: 0, score: 0.7 }]);
});

test("an OpenRouter error throws, so the pipeline falls back to fusion order", async () => {
    config.VOYAGE_API_KEY = "";
    config.OPENROUTER_API_KEY = "sk-or-test";
    global.fetch = async () => ({ ok: false, status: 503, text: async () => "upstream down" });
    await assert.rejects(llmFunctions.rerank({ query: "q", documents: ["a"] }), /rerank failed/);
});

test("decide posts to OpenRouter's alpha decisions endpoint and returns the answers", async () => {
    config.OPENROUTER_API_KEY = "sk-or-test";
    let seen = null;
    global.fetch = async (url, init) => {
        seen = { url, body: JSON.parse(init.body) };
        return { ok: true, json: async () => ({ answers: { intent: { choice: "QUESTION" } }, usage: { input_tokens: 359, output_tokens: 43 } }) };
    };
    const result = await llmFunctions.decide({ model: "typesafe/jev-1.13", state: { customer_message: "hi" }, questions: { intent: { type: "choice" } } });
    assert.equal(seen.url, config.OPENROUTER_BASE_URL.replace(/\/v1\/?$/, "") + "/alpha/decisions");
    assert.equal(seen.body.model, "typesafe/jev-1.13");
    assert.deepEqual(result, { answers: { intent: { choice: "QUESTION" } }, inputTokens: 359, outputTokens: 43 });
});
