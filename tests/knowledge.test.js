"use strict";
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { get, post, patch, del, request, devLogin, authHeader, SEED_ORG_ID, randomSuffix } = require("./helpers/client");

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

    // SITEMAP is implemented (§1.1) and, as of §1.3, QUEUED rather than crawled
    // inline — a hundred-page crawl no longer holds a request thread open and
    // no longer dies with a deploy. So the response is a job id and a PENDING
    // source, not a finished ingest.
    //
    // Parsing and the include/exclude heuristics are covered exhaustively in
    // sitemap.test.js without touching the network; the queue's own semantics
    // are in crawlWorker.test.js.
    test("SITEMAP is accepted and queued to the crawl worker rather than run inline", async () => {
        const result = await post(`/api/knowledge/${SEED_ORG_ID}/sources`, {
            headers: AUTH_A,
            body: {
                type: "SITEMAP",
                name: `probe-sitemap-${randomSuffix()}`,
                // Reserved by RFC 2606 and guaranteed never to resolve, so this
                // exercises the path without depending on a real site.
                url: "https://sitemap-probe.invalid/sitemap.xml",
            },
        });

        assert.notEqual(result.status, 501, "SITEMAP is implemented now");
        assert.equal(result.json.queued, true, "a sitemap crawl must not run on the request thread");
        assert.ok(result.json.crawlJobId, "and must come back with a job to poll");
        createdSourceIds.push(result.json.data.sourceId);

        // PENDING, not FAILED: nothing has been attempted yet. The worker will
        // attempt it, retry with backoff, and dead-letter it — which is the
        // behaviour crawlWorker.test.js asserts directly.
        const listed = await get(`/api/knowledge/${SEED_ORG_ID}/sources`, { headers: AUTH_A });
        const persisted = listed.json.data.find((s) => s.sourceId === result.json.data.sourceId);
        assert.equal(persisted.status, "PENDING", "a queued crawl starts PENDING, not FAILED");

        // And the job is pollable from the source.
        const job = await get(`/api/org/${SEED_ORG_ID}/knowledge/sources/${result.json.data.sourceId}/crawl`, {
            headers: AUTH_A,
        });
        assert.equal(job.status, 200);
        assert.ok(job.json.data, "the crawl job must be readable from its source");
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

    // FILE ingestion is implemented (§1.2) and goes through its own upload
    // endpoint, because the file has to be validated and extracted before a
    // source exists. Extraction itself is covered format by format in
    // fileIngest.test.js.
    test("FILE upload extracts, indexes and reports its extraction quality", async () => {
        const markdown = `# Refund policy\n\nRefunds are issued within 30 days of purchase.\n\n## Exceptions\n\nDigital goods are non-refundable once downloaded.`;
        const result = await post(`/api/org/${SEED_ORG_ID}/knowledge/upload`, {
            headers: AUTH_A,
            body: {
                filename: `probe-${randomSuffix()}.md`,
                mimeType: "text/markdown",
                base64: Buffer.from(markdown).toString("base64"),
            },
        });

        assert.equal(result.status, 201);
        assert.equal(result.json.data.status, "READY");
        assert.ok(result.json.data.chunkCount > 0, "an uploaded file must produce chunks");
        // Surfaced rather than buried: a partially-extracted PDF retrieves badly
        // and the customer should learn that now, not from a bad answer later.
        assert.equal(result.json.extractionQuality, "full");
        createdSourceIds.push(result.json.data.sourceId);
    });

    test("FILE upload refuses a file whose bytes contradict its extension", async () => {
        const result = await post(`/api/org/${SEED_ORG_ID}/knowledge/upload`, {
            headers: AUTH_A,
            body: {
                filename: `probe-${randomSuffix()}.pdf`,
                mimeType: "application/pdf",
                base64: Buffer.from("this is definitely not a pdf").toString("base64"),
            },
        });
        assert.equal(result.status, 400);
        assert.match(result.json.error, /does not look like a PDF/);
    });

    test("re-uploading to the same source replaces rather than duplicating", async () => {
        // Otherwise a workspace ends up with "Handbook", "Handbook (1)" and
        // "Handbook final" all in the retrieval index at once.
        const first = await post(`/api/org/${SEED_ORG_ID}/knowledge/upload`, {
            headers: AUTH_A,
            body: {
                filename: `handbook-${randomSuffix()}.md`,
                base64: Buffer.from("# Handbook\n\nVersion one content.").toString("base64"),
            },
        });
        assert.equal(first.status, 201);
        const sourceId = first.json.data.sourceId;
        createdSourceIds.push(sourceId);

        const second = await request("PUT", `/api/org/${SEED_ORG_ID}/knowledge/sources/${sourceId}/file`, {
            headers: AUTH_A,
            body: {
                filename: "handbook-v2.md",
                base64: Buffer.from("# Handbook\n\nCompletely different version two content.").toString("base64"),
            },
        });

        assert.equal(second.status, 200, "a re-upload updates in place");
        assert.equal(second.json.data.sourceId, sourceId, "and keeps the same source id");

        const chunks = await get(`/api/knowledge/${SEED_ORG_ID}/chunks?sourceId=${sourceId}`, { headers: AUTH_A });
        const text = chunks.json.data.map((chunk) => chunk.text).join(" ");
        assert.match(text, /version two/i);
        assert.doesNotMatch(text, /Version one/i, "the old file's chunks must be gone, not merely joined");
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

describe("PATCH /api/knowledge/:orgId/sources/:sourceId — editing a source's text", () => {
    /* The Knowledge drawer offers an edit box, and it must only offer one where
       the edit survives. A SNIPPET's text is stored on the source and is the
       thing ingest reads. Every other type is re-derived on sync, so an edit
       accepted there would be deleted by the next crawl with no warning. */

    test("a SNIPPET's text can be edited, and the new text is what gets embedded", async () => {
        const created = await post(`/api/knowledge/${SEED_ORG_ID}/sources`, {
            headers: AUTH_A,
            body: { type: "SNIPPET", name: `edit-probe-${randomSuffix()}`, content: "Refunds take ninety days." },
        });
        assert.equal(created.status, 201);
        const sourceId = created.json.data.sourceId;
        createdSourceIds.push(sourceId);

        const edited = await patch(`/api/knowledge/${SEED_ORG_ID}/sources/${sourceId}`, {
            headers: AUTH_A,
            body: { content: "Refunds are issued within five working days." },
        });
        assert.equal(edited.status, 200);
        assert.equal(edited.json.data.sourceId, sourceId, "editing must not create a second source");
        assert.equal(edited.json.data.status, "READY", "the edit must finish embedding before it returns");

        const chunks = await get(`/api/knowledge/${SEED_ORG_ID}/chunks?sourceId=${sourceId}`, { headers: AUTH_A });
        const text = chunks.json.data.map((chunk) => chunk.text).join(" ");
        assert.match(text, /five working days/i, "the edited text must be what the retriever sees");
        assert.doesNotMatch(text, /ninety days/i, "the old text must be gone, not sitting alongside the new");
    });

    test("a SNIPPET can be renamed on its own", async () => {
        const created = await post(`/api/knowledge/${SEED_ORG_ID}/sources`, {
            headers: AUTH_A,
            body: { type: "SNIPPET", name: `rename-probe-${randomSuffix()}`, content: "Shipping is free over $50." },
        });
        const sourceId = created.json.data.sourceId;
        createdSourceIds.push(sourceId);

        const renamed = await patch(`/api/knowledge/${SEED_ORG_ID}/sources/${sourceId}`, {
            headers: AUTH_A,
            body: { name: "Shipping policy" },
        });
        assert.equal(renamed.status, 200);
        assert.equal(renamed.json.data.name, "Shipping policy");
        assert.equal(renamed.json.data.content, "Shipping is free over $50.", "a rename must not touch the text");
    });

    test("editing the text of a FILE source is refused, and says where to edit instead", async () => {
        // A dead end that does not name the real lever reads as a bug. The
        // message has to point at the file, because that is what a re-sync
        // re-reads.
        const uploaded = await post(`/api/org/${SEED_ORG_ID}/knowledge/upload`, {
            headers: AUTH_A,
            body: {
                filename: `derived-${randomSuffix()}.md`,
                base64: Buffer.from("# Policy\n\nDerived text that a sync owns.").toString("base64"),
            },
        });
        assert.equal(uploaded.status, 201);
        const sourceId = uploaded.json.data.sourceId;
        createdSourceIds.push(sourceId);

        const refused = await patch(`/api/knowledge/${SEED_ORG_ID}/sources/${sourceId}`, {
            headers: AUTH_A,
            body: { content: "Text I typed that a re-sync would silently delete." },
        });
        assert.equal(refused.status, 409);
        assert.match(refused.json.error, /file that was uploaded/i);
        assert.match(refused.json.error, /overwritten/i);

        const chunks = await get(`/api/knowledge/${SEED_ORG_ID}/chunks?sourceId=${sourceId}`, { headers: AUTH_A });
        const text = chunks.json.data.map((chunk) => chunk.text).join(" ");
        assert.doesNotMatch(text, /silently delete/i, "a refused edit must not have been partially applied");
    });

    test("a FILE source can still be renamed — the name is ours, not the document's", async () => {
        const uploaded = await post(`/api/org/${SEED_ORG_ID}/knowledge/upload`, {
            headers: AUTH_A,
            body: {
                filename: `renameable-${randomSuffix()}.md`,
                base64: Buffer.from("# Handbook\n\nSome content.").toString("base64"),
            },
        });
        const sourceId = uploaded.json.data.sourceId;
        createdSourceIds.push(sourceId);

        const renamed = await patch(`/api/knowledge/${SEED_ORG_ID}/sources/${sourceId}`, {
            headers: AUTH_A,
            body: { name: "Employee handbook" },
        });
        assert.equal(renamed.status, 200);
        assert.equal(renamed.json.data.name, "Employee handbook");
    });

    test("an empty edit is refused rather than blanking the source", async () => {
        const created = await post(`/api/knowledge/${SEED_ORG_ID}/sources`, {
            headers: AUTH_A,
            body: { type: "SNIPPET", name: `blank-probe-${randomSuffix()}`, content: "Original text." },
        });
        const sourceId = created.json.data.sourceId;
        createdSourceIds.push(sourceId);

        const blanked = await patch(`/api/knowledge/${SEED_ORG_ID}/sources/${sourceId}`, {
            headers: AUTH_A,
            body: { content: "   " },
        });
        assert.equal(blanked.status, 400);

        const still = await get(`/api/knowledge/${SEED_ORG_ID}/chunks?sourceId=${sourceId}`, { headers: AUTH_A });
        assert.ok(still.json.data.length >= 1, "the source must still have its chunks");
    });

    test("a request that changes nothing is refused", async () => {
        const created = await post(`/api/knowledge/${SEED_ORG_ID}/sources`, {
            headers: AUTH_A,
            body: { type: "SNIPPET", name: `noop-probe-${randomSuffix()}`, content: "Text." },
        });
        createdSourceIds.push(created.json.data.sourceId);

        const result = await patch(`/api/knowledge/${SEED_ORG_ID}/sources/${created.json.data.sourceId}`, {
            headers: AUTH_A,
            body: {},
        });
        assert.equal(result.status, 400);
    });

    test("editing a nonexistent source returns 404", async () => {
        const result = await patch(`/api/knowledge/${SEED_ORG_ID}/sources/src_bogus`, {
            headers: AUTH_A,
            body: { name: "x" },
        });
        assert.equal(result.status, 404);
    });

    test("requires auth", async () => {
        const result = await patch(`/api/knowledge/${SEED_ORG_ID}/sources/src_bogus`, { body: { name: "x" } });
        assert.equal(result.status, 401);
    });
});

describe("GET /api/knowledge/:orgId/chunks — the field names the dashboard reads", () => {
    /* The chunk drawer rendered 790 empty boxes in production because it read
       `chunk.content` and `chunk.heading`, and the API sends `text` and
       `headingPath`. TypeScript could not catch it: the response is an
       unchecked cast over JSON. Nothing on either side asserted the contract,
       so this is where it gets asserted. Renaming a field here fails here. */
    test("every chunk carries text and headingPath under those exact names", async () => {
        const result = await get(`/api/knowledge/${SEED_ORG_ID}/chunks?limit=10`, { headers: AUTH_A });
        assert.equal(result.status, 200);
        assert.ok(result.json.data.length >= 1, "the seed must have chunks for this to prove anything");

        for (const chunk of result.json.data) {
            assert.equal(typeof chunk.text, "string", "the drawer renders `text` — not `content`");
            assert.ok(chunk.text.length > 0, "a chunk with no text would render as an empty box");
            assert.ok(Array.isArray(chunk.headingPath), "the drawer renders `headingPath` — not `heading`");
            assert.equal(typeof chunk.tokenCount, "number");
            assert.equal(typeof chunk.position, "number");
        }
    });
});
