"use strict";
const { test, describe, before } = require("node:test");
const assert = require("node:assert/strict");
const { get, devLogin, authHeader, SEED_ORG_ID } = require("./helpers/client");

let AUTH_A;

before(async () => {
    AUTH_A = authHeader(await devLogin(SEED_ORG_ID));
});

describe("GET /api/analytics/:orgId/overview", () => {
    test("happy path returns the north-star metrics shape", async () => {
        const result = await get(`/api/analytics/${SEED_ORG_ID}/overview?days=7`, { headers: AUTH_A });
        assert.equal(result.status, 200);
        assert.equal(result.json.data.windowDays, 7);
        assert.ok(typeof result.json.data.conversations === "number");
        assert.ok(result.json.data.autonomousResolutionRate >= 0 && result.json.data.autonomousResolutionRate <= 1);
        assert.ok(result.json.data.outcomes, "outcomes breakdown must be present");
        assert.ok(Array.isArray(result.json.data.dailyResolution));
        assert.ok(Array.isArray(result.json.data.dailyTokens));
    });

    test("days is clamped to [1, 90]", async () => {
        const tooMany = await get(`/api/analytics/${SEED_ORG_ID}/overview?days=99999`, { headers: AUTH_A });
        assert.equal(tooMany.json.data.windowDays, 90);

        // KNOWN BUG (see test report): analyticsFunctions.getOverview computes
        // `parseInt(days, 10) || 7` before clamping. parseInt("0", 10) is the
        // number 0, which is falsy in JS, so `0 || 7` evaluates to 7 — days=0
        // silently becomes the default of 7 instead of clamping to the
        // documented floor of 1. Same bug in getContentGaps (default 30).
        // Left RED deliberately per instructions rather than weakened to match
        // the bug. Fix: use `Number.isFinite(parsed) ? parsed : default` or
        // guard explicitly for 0 before the `||` fallback.
        const tooFew = await get(`/api/analytics/${SEED_ORG_ID}/overview?days=0`, { headers: AUTH_A });
        assert.equal(tooFew.json.data.windowDays, 1);

        const nonsense = await get(`/api/analytics/${SEED_ORG_ID}/overview?days=notanumber`, { headers: AUTH_A });
        assert.equal(nonsense.json.data.windowDays, 7, "invalid days falls back to the default of 7");
    });

    test("requires auth", async () => {
        const result = await get(`/api/analytics/${SEED_ORG_ID}/overview`);
        assert.equal(result.status, 401);
    });

    test("dailyTokens always has one entry per day in the window, even quiet days", async () => {
        const result = await get(`/api/analytics/${SEED_ORG_ID}/overview?days=14`, { headers: AUTH_A });
        assert.equal(result.json.data.dailyTokens.length, 14, "a quiet day must render as a zero row, not vanish");
    });
});

describe("GET /api/analytics/:orgId/content-gaps", () => {
    test("happy path returns belowThreshold queries grouped and sorted by occurrence", async () => {
        const result = await get(`/api/analytics/${SEED_ORG_ID}/content-gaps?days=30`, { headers: AUTH_A });
        assert.equal(result.status, 200);
        assert.ok(Array.isArray(result.json.data));
        for (let i = 1; i < result.json.data.length; i++) {
            assert.ok(
                result.json.data[i - 1].occurrences >= result.json.data[i].occurrences,
                "content gaps must be sorted by occurrences descending"
            );
        }
    });

    test("requires auth", async () => {
        const result = await get(`/api/analytics/${SEED_ORG_ID}/content-gaps`);
        assert.equal(result.status, 401);
    });
});
