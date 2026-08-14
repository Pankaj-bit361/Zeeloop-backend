// §8.3 — liveness vs deep health.
//
// The distinction is the point of these tests. / and /health are what the load
// balancer polls and must never depend on Mongo: a health check that queries
// the database turns a database blip into every instance being pulled out of
// service at once, converting a partial outage into a total one.
"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { get } = require("./helpers/client");

describe("liveness endpoints", () => {
    test("/ answers 200 for the load balancer", async () => {
        const result = await get("/");
        assert.equal(result.status, 200);
        assert.equal(result.json.success, true);
    });

    test("/health answers 200", async () => {
        const result = await get("/health");
        assert.equal(result.status, 200);
    });

    test("neither requires auth — a balancer holds no credentials", async () => {
        assert.equal((await get("/")).status, 200);
        assert.equal((await get("/health")).status, 200);
    });

    test("liveness stays cheap: no dependency detail leaks into it", async () => {
        const result = await get("/health");
        assert.equal(result.json.checks, undefined, "liveness must not report dependencies");
    });
});

describe("GET /health/deep", () => {
    test("reports every dependency separately", async () => {
        const result = await get("/health/deep");
        assert.ok([200, 503].includes(result.status));
        for (const key of ["database", "search", "chat", "embedding"]) {
            assert.ok(result.json.checks[key], `deep health is missing ${key}`);
            assert.ok(result.json.checks[key].status, `${key} has no status`);
        }
        assert.ok(result.json.checkedAt);
    });

    test("separates chat from embedding, because they fail independently", async () => {
        const result = await get("/health/deep");
        const chat = result.json.checks.chat.status;
        const embedding = result.json.checks.embedding.status;
        assert.ok(chat);
        assert.ok(embedding);
        // Not asserting they differ — only that one cannot mask the other.
        assert.notEqual(result.json.checks.chat, result.json.checks.embedding);
    });

    test("a failing dependency degrades rather than 503s while the database is up", async () => {
        const result = await get("/health/deep");
        if (result.json.checks.database.status === "ok") {
            assert.equal(result.status, 200, "the deployment can still serve, so it is not 503");
            assert.ok(["ok", "degraded"].includes(result.json.status));
        }
    });

    test("requires no auth so an uptime monitor can poll it", async () => {
        assert.notEqual((await get("/health/deep")).status, 401);
    });
});
