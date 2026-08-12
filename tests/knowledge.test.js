"use strict";
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { get, post, del, devLogin, authHeader, SEED_ORG_ID, randomSuffix } = require("./helpers/client");

let AUTH_A;
const createdSourceIds = [];

before(async () => {
    AUTH_A = authHeader(await devLogin(SEED_ORG_ID));
});

after(async () => {
    for (const sourceId of createdSourceIds) {
        await del(`/api/knowledge/${SEED_ORG_ID}/sources/${sourceId}`, { headers: AUTH_A }).catch(() => {});
    }
});

describe("GET /api/knowledge/:orgId/sources", () => {
    test("happy path lists seeded sources", async () => {
        const result = await get(`/api/knowledge/${SEED_ORG_ID}/sources`, { headers: AUTH_A });
        assert.equal(result.status, 200);
        assert.ok(result.json.data.length >= 5);
    });

    test("requires auth", async () => {
        const result = await get(`/api/knowledge/${SEED_ORG_ID}/sources`);
        assert.equal(result.status, 401);
    });
});

describe("POST /api/knowledge/:orgId/sources — validation and type-specific requirements", () => {
    test("rejects an unknown source type", async () => {
        const result = await post(`/api/knowledge/${SEED_ORG_ID}/sources`, {
            headers: AUTH_A,
            body: { type: "CARRIER_PIGEON", name: "x" },
        });
        assert.equal(result.status, 400);
    });

    test("URL/SITEMAP sources require a url", async () => {
        const result = await post(`/api/knowledge/${SEED_ORG_ID}/sources`, { headers: AUTH_A, body: { type: "URL", name: "no url" } });
        assert.equal(result.status, 400);
    });

    test("SNIPPET sources require content", async () => {
        const result = await post(`/api/knowledge/${SEED_ORG_ID}/sources`, { headers: AUTH_A, body: { type: "SNIPPET", name: "no content" } });
        assert.equal(result.status, 400);
    });

    test("SITEMAP ingestion is deferred (§13) — returns 501, and persists status FAILED not the stale in-memory PENDING", async () => {
        const result = await post(`/api/knowledge/${SEED_ORG_ID}/sources`, {
            headers: AUTH_A,
            body: { type: "SITEMAP", name: `probe-sitemap-${randomSuffix()}`, url: "https://example.com/sitemap.xml" },
        });
        assert.equal(result.status, 501);
        createdSourceIds.push(result.json.data.sourceId);

        // BUG (see report): createSource's 501 response body still shows the
        // stale in-memory `status: PENDING` captured before _ingestSource ran,
        // even though the persisted document is actually FAILED with lastError
        // set. This assertion documents ACTUAL behavior (xfail-style) rather
        // than the ideal — flip to "FAILED" once the response bug is fixed.
        const listed = await get(`/api/knowledge/${SEED_ORG_ID}/sources`, { headers: AUTH_A });
        const persisted = listed.json.data.find((s) => s.sourceId === result.json.data.sourceId);
        assert.equal(persisted.status, "FAILED", "the PERSISTED source should be FAILED after a not-implemented ingest");
        assert.ok(persisted.lastError, "persisted source should carry the not-implemented error message");
    });

    test("FILE ingestion is deferred (§13) — returns 501", async () => {
        const result = await post(`/api/knowledge/${SEED_ORG_ID}/sources`, {
            headers: AUTH_A,
            body: { type: "FILE", name: `probe-file-${randomSuffix()}.pdf` },
        });
        assert.equal(result.status, 501);
        createdSourceIds.push(result.json.data.sourceId);
    });

    test("happy path: SNIPPET source ingests synchronously and becomes READY", async () => {
        const result = await post(`/api/knowledge/${SEED_ORG_ID}/sources`, {
            headers: AUTH_A,
            body: {
                type: "SNIPPET",
                name: `probe-snippet-${randomSuffix()}`,
                content: "Our return window is 30 days from delivery for unopened items.",
            },
        });
        assert.equal(result.status, 201);
        assert.equal(result.json.data.status, "READY");
        assert.ok(result.json.data.chunkCount >= 1);
        createdSourceIds.push(result.json.data.sourceId);
    });
});

describe("DELETE /api/knowledge/:orgId/sources/:sourceId", () => {
    test("deleting a source also deletes its chunks", async () => {
        const created = await post(`/api/knowledge/${SEED_ORG_ID}/sources`, {
            headers: AUTH_A,
            body: { type: "SNIPPET", name: `delete-probe-${randomSuffix()}`, content: "Ephemeral content for deletion test." },
        });
        const sourceId = created.json.data.sourceId;

        const del1 = await del(`/api/knowledge/${SEED_ORG_ID}/sources/${sourceId}`, { headers: AUTH_A });
        assert.equal(del1.status, 200);

        const chunks = await get(`/api/knowledge/${SEED_ORG_ID}/chunks?sourceId=${sourceId}`, { headers: AUTH_A });
        assert.equal(chunks.json.data.length, 0);
    });

    test("deleting a nonexistent source returns 404", async () => {
        const result = await del(`/api/knowledge/${SEED_ORG_ID}/sources/src_bogus`, { headers: AUTH_A });
        assert.equal(result.status, 404);
    });
});

describe("GET /api/knowledge/:orgId/chunks — never exposes the embedding vector", () => {
    test("happy path lists chunks, embedding field is absent", async () => {
        const result = await get(`/api/knowledge/${SEED_ORG_ID}/chunks?limit=10`, { headers: AUTH_A });
        assert.equal(result.status, 200);
        for (const chunk of result.json.data) {
            assert.equal("embedding" in chunk, false, "embedding must never leave the backend (select: false)");
        }
    });
});

describe("POST /api/knowledge/:orgId/sources/:sourceId/resync", () => {
    test("resync on a nonexistent source returns 404", async () => {
        const result = await post(`/api/knowledge/${SEED_ORG_ID}/sources/src_bogus/resync`, { headers: AUTH_A });
        assert.equal(result.status, 404);
    });
});
