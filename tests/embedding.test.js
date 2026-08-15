// Embedding transport: Google direct with an OpenRouter fallback.
//
// The important property is that BOTH transports call the same model, so a
// fallback cannot silently mix vector spaces. A model fallback would be unsafe
// and deliberately does not exist; this is only a transport fallback.
//
// fetch is injected throughout, so none of this touches the network or spends
// money.
"use strict";
const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const llmFunctions = require("../functions/utilFunctions/llmFunctions");
const config = require("../config/config");

const DIM = config.EMBEDDING_DIM;
const vector = (seed) => Array.from({ length: DIM }, (_, i) => (seed + i) / 1000);

let saved;
beforeEach(() => {
    saved = {
        gemini: config.GEMINI_API_KEY,
        batch: config.GEMINI_EMBED_BATCH_SIZE,
    };
    config.GEMINI_API_KEY = "test-gemini-key";
    config.GEMINI_EMBED_BATCH_SIZE = 2;
});
afterEach(() => {
    config.GEMINI_API_KEY = saved.gemini;
    config.GEMINI_EMBED_BATCH_SIZE = saved.batch;
});

// Records every call so batching and ordering can be asserted.
function googleFetch({ failWith = null } = {}) {
    const calls = [];
    const impl = async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });
        if (failWith) return { ok: false, status: failWith, text: async () => `upstream ${failWith}` };
        const requests = JSON.parse(options.body).requests;
        return {
            ok: true,
            status: 200,
            json: async () => ({
                embeddings: requests.map((request, index) => ({
                    // Encode the input text's first char so ordering is checkable.
                    values: vector(request.content.parts[0].text.charCodeAt(0) + index * 0),
                })),
            }),
        };
    };
    impl.calls = calls;
    return impl;
}

describe("embed — Google direct", () => {
    test("uses Google when a key is set", async () => {
        const impl = googleFetch();
        await llmFunctions.embed({ texts: ["a"], fetchImpl: impl });
        assert.ok(impl.calls[0].url.includes("generativelanguage.googleapis.com"));
        assert.ok(impl.calls[0].url.includes("batchEmbedContents"));
    });

    test("requests the configured dimensionality, so vectors match the Atlas index", async () => {
        const impl = googleFetch();
        await llmFunctions.embed({ texts: ["a"], fetchImpl: impl });
        assert.equal(impl.calls[0].body.requests[0].outputDimensionality, DIM);
    });

    test("splits into batches at the configured size", async () => {
        const impl = googleFetch();
        await llmFunctions.embed({ texts: ["a", "b", "c", "d", "e"], fetchImpl: impl });
        assert.equal(impl.calls.length, 3, "5 texts at batch size 2 should be 3 requests");
        assert.deepEqual(impl.calls.map((call) => call.body.requests.length), [2, 2, 1]);
    });

    test("preserves order across batch boundaries", async () => {
        const impl = googleFetch();
        const texts = ["a", "b", "c", "d", "e"];
        const vectors = await llmFunctions.embed({ texts, fetchImpl: impl });
        assert.equal(vectors.length, 5);
        // Each stub vector encodes its input's char code in element 0.
        vectors.forEach((v, index) => {
            assert.equal(v[0], texts[index].charCodeAt(0) / 1000, `vector ${index} is misaligned with its text`);
        });
    });

    test("returns one vector per input", async () => {
        const impl = googleFetch();
        const vectors = await llmFunctions.embed({ texts: ["a", "b", "c"], fetchImpl: impl });
        assert.equal(vectors.length, 3);
        assert.ok(vectors.every((v) => v.length === DIM));
    });

    test("rejects a short response rather than silently misaligning chunks", async () => {
        const impl = async () => ({
            ok: true,
            status: 200,
            json: async () => ({ embeddings: [{ values: vector(1) }] }),
        });
        config.GEMINI_EMBED_BATCH_SIZE = 100;
        // Google failing this way falls through to OpenRouter, which also
        // fails here, so the call must reject rather than return junk.
        await assert.rejects(() => llmFunctions.embed({ texts: ["a", "b"], fetchImpl: impl }));
    });
});

describe("embed — transport fallback", () => {
    test("falls back to OpenRouter when Google fails", async () => {
        const seen = [];
        const impl = async (url, options) => {
            seen.push(url);
            if (url.includes("googleapis.com")) {
                return { ok: false, status: 403, text: async () => "dunning block" };
            }
            const body = JSON.parse(options.body);
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    data: body.input.map((text, index) => ({ index, embedding: vector(index) })),
                }),
            };
        };

        const vectors = await llmFunctions.embed({ texts: ["a", "b"], fetchImpl: impl });
        assert.equal(vectors.length, 2);
        assert.ok(seen.some((url) => url.includes("googleapis.com")), "Google should be tried first");
        assert.ok(seen.some((url) => url.includes("openrouter.ai")), "then OpenRouter");
    });

    test("goes straight to OpenRouter when no Google key is set", async () => {
        config.GEMINI_API_KEY = "";
        const seen = [];
        const impl = async (url, options) => {
            seen.push(url);
            const body = JSON.parse(options.body);
            return {
                ok: true,
                status: 200,
                json: async () => ({ data: body.input.map((text, index) => ({ index, embedding: vector(index) })) }),
            };
        };
        await llmFunctions.embed({ texts: ["a"], fetchImpl: impl });
        assert.equal(seen.length, 1);
        assert.ok(seen[0].includes("openrouter.ai"));
    });

    test("throws when both transports fail — no silent empty result", async () => {
        const impl = async () => ({ ok: false, status: 500, text: async () => "down" });
        await assert.rejects(() => llmFunctions.embed({ texts: ["a"], fetchImpl: impl }));
    });
});

describe("embed — dimension safety", () => {
    test("rejects vectors that do not match EMBEDDING_DIM", async () => {
        const impl = async (url) => {
            if (url.includes("googleapis.com")) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ embeddings: [{ values: new Array(512).fill(0.1) }] }),
                };
            }
            return { ok: false, status: 500, text: async () => "down" };
        };
        // A wrong dimension must never reach Atlas: the index is built for
        // EMBEDDING_DIM and a mismatch corrupts retrieval rather than erroring.
        await assert.rejects(
            () => llmFunctions.embed({ texts: ["a"], fetchImpl: impl }),
            /dimension|expected/i
        );
    });
});
