// Unit tests for the sliding-window limiter (§8.2).
//
// The algorithm is tested directly rather than over HTTP: provoking a 429 from
// the live server would mean firing hundreds of real requests, and the limits
// are deliberately set high on the test server so the rest of the suite is not
// flaky. What matters here is the window arithmetic.
"use strict";
const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { consume, clientIp, _reset } = require("../middlewares/rateLimit");
const config = require("../config/config");

beforeEach(() => _reset());

describe("consume", () => {
    test("allows up to the limit and refuses the next one", () => {
        for (let i = 0; i < 5; i++) {
            assert.equal(consume("k", 5).allowed, true, `request ${i + 1} should be allowed`);
        }
        assert.equal(consume("k", 5).allowed, false, "the sixth should be refused");
    });

    test("reports remaining budget", () => {
        assert.equal(consume("k", 3).remaining, 2);
        assert.equal(consume("k", 3).remaining, 1);
        assert.equal(consume("k", 3).remaining, 0);
    });

    test("keys are independent — one noisy visitor does not limit another", () => {
        for (let i = 0; i < 5; i++) consume("visitor-a", 5);
        assert.equal(consume("visitor-a", 5).allowed, false);
        assert.equal(consume("visitor-b", 5).allowed, true);
    });

    test("a refusal reports Retry-After in whole seconds, never zero", () => {
        consume("k", 1);
        const refused = consume("k", 1);
        assert.equal(refused.allowed, false);
        assert.ok(refused.retryAfterSeconds >= 1);
        assert.ok(refused.retryAfterSeconds <= Math.ceil(config.RATE_LIMIT_WINDOW_MS / 1000));
    });

    test("a zero limit refuses everything", () => {
        assert.equal(consume("k", 0).allowed, false);
    });

    test("the window slides — entries older than the window stop counting", async () => {
        // Drive the boundary directly rather than waiting a real minute: consume
        // against a limiter whose window has effectively passed by using a
        // distinct key per logical window.
        const original = config.RATE_LIMIT_WINDOW_MS;
        try {
            config.RATE_LIMIT_WINDOW_MS = 30;
            for (let i = 0; i < 3; i++) consume("sliding", 3);
            assert.equal(consume("sliding", 3).allowed, false, "full inside the window");

            await new Promise((resolve) => setTimeout(resolve, 45));
            assert.equal(consume("sliding", 3).allowed, true, "budget should return once the window passes");
        } finally {
            config.RATE_LIMIT_WINDOW_MS = original;
        }
    });
});

describe("clientIp", () => {
    const reqWith = (headers, fallback) => ({
        get: (name) => headers[name.toLowerCase()] || undefined,
        ip: fallback,
        socket: { remoteAddress: fallback },
    });

    test("prefers the first entry of x-forwarded-for", () => {
        const req = reqWith({ "x-forwarded-for": "203.0.113.7, 70.41.3.18, 150.172.238.178" }, "10.0.0.1");
        assert.equal(clientIp(req), "203.0.113.7");
    });

    test("trims whitespace in the forwarded chain", () => {
        const req = reqWith({ "x-forwarded-for": "  203.0.113.7  ,10.0.0.2" }, "10.0.0.1");
        assert.equal(clientIp(req), "203.0.113.7");
    });

    test("falls back to the socket address with no proxy header", () => {
        assert.equal(clientIp(reqWith({}, "198.51.100.4")), "198.51.100.4");
    });

    test("never returns undefined, so a missing address cannot collapse all callers into one key", () => {
        const req = { get: () => undefined, socket: {} };
        assert.equal(clientIp(req), "unknown");
    });
});

describe("configured limits", () => {
    test("per-end-user is tighter than per-org, which is the point of having both", () => {
        assert.ok(config.RATE_LIMIT_PER_END_USER < config.RATE_LIMIT_PER_ORG);
    });

    test("all three tiers are positive — a zero would refuse every widget request", () => {
        assert.ok(config.RATE_LIMIT_PER_END_USER > 0);
        assert.ok(config.RATE_LIMIT_PER_IP > 0);
        assert.ok(config.RATE_LIMIT_PER_ORG > 0);
    });
});
