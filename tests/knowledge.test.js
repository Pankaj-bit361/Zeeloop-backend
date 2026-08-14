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

    // SITEMAP is implemented as of §1.1. It is no longer a 501; a URL with no
    // reachable sitemap now fails on its merits, which is a different and
    // better failure. Parsing and the include/exclude heuristics are covered
    // exhaustively in sitemap.test.js without touching the network.
    test("SITEMAP is accepted, and a URL with no sitemap fails on its merits rather than as unimplemented", async () => {
        const result = await post(`/api/knowledge/${SEED_ORG_ID}/sources`, {
            headers: AUTH_A,
            body: {
                type: "SITEMAP",
                name: `probe-sitemap-${randomSuffix()}`,
                // Reserved by RFC 2606 and guaranteed never to resolve, so this
                // exercises the failure path without depending on a real site.
                url: "https://sitemap-probe.invalid/sitemap.xml",
            },
        });
        assert.notEqual(result.status, 501, "SITEMAP is implemented now");
        createdSourceIds.push(result.json.data.sourceId);

        const listed = await get(`/api/knowledge/${SEED_ORG_ID}/sources`, { headers: AUTH_A });
        const persisted = listed.json.data.find((s) => s.sourceId === result.json.data.sourceId);
        assert.equal(persisted.status, "FAILED", "an unreachable sitemap should persist as FAILED");
        assert.ok(persisted.lastError, "and should say why");
        assert.equal(
            /not implemented/i.test(persisted.lastError),
            false,
            "the failure should be about the sitemap, not about the feature missing"
        );
    });

    test("POST /api/knowledge/:orgId/sitemap/discover previews URLs without ingesting", async () => {
        const result = await post(`/api/knowledge/${SEED_ORG_ID}/sitemap/discover`, {
            headers: AUTH_A,
            body: { url: "https://sitemap-probe.invalid/sitemap.xml" },
        });
        // Unreachable host: a clean 422 explaining the problem, not a 500.
        assert.equal(result.status, 422);
        assert.ok(result.json.error);
    });

    test("sitemap discovery requires auth", async () => {
        const result = await post(`/api/knowledge/${SEED_ORG_ID}/sitemap/discover`, {
            body: { url: "https://acme.test/sitemap.xml" },
        });
        assert.equal(result.status, 401);
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
