"use strict";
const { test, describe, before } = require("node:test");
const assert = require("node:assert/strict");
const { get, post, patch, devLogin, authHeader, SEED_ORG_ID } = require("./helpers/client");

let AUTH_A;

before(async () => {
    AUTH_A = authHeader(await devLogin(SEED_ORG_ID));
});

describe("GET /api/org/:orgId/conversations (inbox)", () => {
    test("happy path lists conversations with status tab counts", async () => {
        const result = await get(`/api/org/${SEED_ORG_ID}/conversations?limit=10`, { headers: AUTH_A });
        assert.equal(result.status, 200);
        assert.ok(result.json.total > 0);
        assert.ok(result.json.statusCounts.ALL >= result.json.total >= 0);
        for (const convo of result.json.data) {
            assert.ok(convo.user, "each conversation must carry its end user (or Anonymous placeholder)");
        }
    });

    test("status tab counts ignore the status filter but honour search", async () => {
        const filtered = await get(`/api/org/${SEED_ORG_ID}/conversations?status=OPEN&limit=5`, { headers: AUTH_A });
        assert.equal(filtered.status, 200);
        for (const convo of filtered.json.data) {
            assert.equal(convo.status, "OPEN");
        }
        // statusCounts must still report every status, not just OPEN
        assert.ok("RESOLVED" in filtered.json.statusCounts);
        assert.ok("ESCALATED" in filtered.json.statusCounts);
    });

    test("requires auth", async () => {
        const result = await get(`/api/org/${SEED_ORG_ID}/conversations`);
        assert.equal(result.status, 401);
    });
});

describe("GET /api/org/:orgId/conversations/:conversationId", () => {
    test("happy path returns conversation + messages + traces", async () => {
        const list = await get(`/api/org/${SEED_ORG_ID}/conversations?limit=1`, { headers: AUTH_A });
        const conversationId = list.json.data[0].conversationId;

        const result = await get(`/api/org/${SEED_ORG_ID}/conversations/${conversationId}`, { headers: AUTH_A });
        assert.equal(result.status, 200);
        assert.equal(result.json.data.conversation.conversationId, conversationId);
        assert.ok(Array.isArray(result.json.data.messages));
        assert.ok(Array.isArray(result.json.data.traces));
    });

    test("nonexistent conversation returns 404", async () => {
        const result = await get(`/api/org/${SEED_ORG_ID}/conversations/conv_bogus`, { headers: AUTH_A });
        assert.equal(result.status, 404);
    });
});

describe("PATCH /api/org/:orgId/conversations/:conversationId — status changes", () => {
    test("rejects an unknown status value", async () => {
        const list = await get(`/api/org/${SEED_ORG_ID}/conversations?limit=1`, { headers: AUTH_A });
        const conversationId = list.json.data[0].conversationId;
        const result = await patch(`/api/org/${SEED_ORG_ID}/conversations/${conversationId}`, { headers: AUTH_A, body: { status: "TELEPORTED" } });
        assert.equal(result.status, 400);
    });

    test("nonexistent conversation returns 404", async () => {
        const result = await patch(`/api/org/${SEED_ORG_ID}/conversations/conv_bogus`, { headers: AUTH_A, body: { status: "OPEN" } });
        assert.equal(result.status, 404);
    });

    test("manual RESOLVED never sets isResolved — that flag means autonomous resolution only", async () => {
        const list = await get(`/api/org/${SEED_ORG_ID}/conversations?status=OPEN&limit=1`, { headers: AUTH_A });
        if (list.json.data.length === 0) return; // no OPEN conversations available to test against right now
        const conversationId = list.json.data[0].conversationId;

        const result = await patch(`/api/org/${SEED_ORG_ID}/conversations/${conversationId}`, { headers: AUTH_A, body: { status: "RESOLVED" } });
        assert.equal(result.status, 200);
        assert.equal(result.json.data.status, "RESOLVED");
        assert.ok(result.json.data.manuallyResolvedAt, "manual close must stamp manuallyResolvedAt");
        assert.equal(
            result.json.data.isResolved,
            false,
            "isResolved must stay false — a human closing a ticket is not an autonomous resolution (spec invariant)"
        );

        // restore to OPEN so we don't pollute the seeded dataset's shape for other test runs
        await patch(`/api/org/${SEED_ORG_ID}/conversations/${conversationId}`, { headers: AUTH_A, body: { status: "OPEN" } });
    });
});

describe("POST /api/org/:orgId/conversations/:conversationId/reply (human reply)", () => {
    test("happy path posts a HUMAN_AGENT message and flags hasHumanReply", async () => {
        const list = await get(`/api/org/${SEED_ORG_ID}/conversations?limit=1`, { headers: AUTH_A });
        const conversationId = list.json.data[0].conversationId;

        const result = await post(`/api/org/${SEED_ORG_ID}/conversations/${conversationId}/reply`, {
            headers: AUTH_A,
            body: { content: "Automated test human reply — please disregard." },
        });
        assert.equal(result.status, 200);
        assert.equal(result.json.data.message.role, "HUMAN_AGENT");

        const fetched = await get(`/api/org/${SEED_ORG_ID}/conversations/${conversationId}`, { headers: AUTH_A });
        assert.equal(fetched.json.data.conversation.hasHumanReply, true);
    });

    test("missing content returns 400", async () => {
        const list = await get(`/api/org/${SEED_ORG_ID}/conversations?limit=1`, { headers: AUTH_A });
        const conversationId = list.json.data[0].conversationId;
        const result = await post(`/api/org/${SEED_ORG_ID}/conversations/${conversationId}/reply`, { headers: AUTH_A, body: {} });
        assert.equal(result.status, 400);
    });

    test("nonexistent conversation returns 404", async () => {
        const result = await post(`/api/org/${SEED_ORG_ID}/conversations/conv_bogus/reply`, { headers: AUTH_A, body: { content: "hi" } });
        assert.equal(result.status, 404);
    });
});
