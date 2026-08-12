"use strict";
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { get, post, patch, del, devLogin, authHeader, SEED_ORG_ID, randomSuffix } = require("./helpers/client");

let AUTH_A;
const createdActionIds = [];

before(async () => {
    AUTH_A = authHeader(await devLogin(SEED_ORG_ID));
});

after(async () => {
    for (const actionId of createdActionIds) {
        await del(`/api/org/${SEED_ORG_ID}/actions/${actionId}`, { headers: AUTH_A }).catch(() => {});
    }
});

describe("GET /api/org/:orgId/actions", () => {
    test("happy path lists seeded actions with the guard-relevant fields", async () => {
        const result = await get(`/api/org/${SEED_ORG_ID}/actions`, { headers: AUTH_A });
        assert.equal(result.status, 200);
        assert.ok(result.json.data.length >= 5);
        for (const action of result.json.data) {
            assert.ok(["READ", "WRITE"].includes(action.accessType));
            assert.equal("secret" in action, false, "encrypted secret must never leave the backend");
        }
    });

    test("requires auth", async () => {
        const result = await get(`/api/org/${SEED_ORG_ID}/actions`);
        assert.equal(result.status, 401);
    });
});

describe("POST /api/org/:orgId/actions — accessType is required, no default", () => {
    test("rejects action creation without accessType", async () => {
        const result = await post(`/api/org/${SEED_ORG_ID}/actions`, {
            headers: AUTH_A,
            body: { name: "No AccessType", description: "x", urlTemplate: "https://example.com" },
        });
        assert.equal(result.status, 400);
    });

    test("rejects an invalid accessType value", async () => {
        const result = await post(`/api/org/${SEED_ORG_ID}/actions`, {
            headers: AUTH_A,
            body: { name: "Bad AccessType", description: "x", accessType: "DELETE_EVERYTHING", urlTemplate: "https://example.com" },
        });
        assert.equal(result.status, 400);
    });

    test("rejects missing required fields (name/description/urlTemplate)", async () => {
        const result = await post(`/api/org/${SEED_ORG_ID}/actions`, { headers: AUTH_A, body: { accessType: "READ" } });
        assert.equal(result.status, 400);
    });

    test("happy path: a freshly created action is always disabled and untested", async () => {
        const result = await post(`/api/org/${SEED_ORG_ID}/actions`, {
            headers: AUTH_A,
            body: {
                name: `Probe Action ${randomSuffix()}`,
                description: "Created by automated test",
                accessType: "READ",
                urlTemplate: "https://httpbin.org/status/200",
                requiresIdentity: false,
                requiresConfirmation: false,
            },
        });
        assert.equal(result.status, 201);
        assert.equal(result.json.data.enabled, false, "new actions must start disabled");
        assert.equal(result.json.data.lastTestStatus, null, "new actions must start untested");
        createdActionIds.push(result.json.data.actionId);
    });
});

describe("The full action guard ladder: test-required -> enable -> visible; url change resets test", () => {
    let actionId;

    before(async () => {
        const created = await post(`/api/org/${SEED_ORG_ID}/actions`, {
            headers: AUTH_A,
            body: {
                name: `Guard Ladder ${randomSuffix()}`,
                description: "Exercises the guard ladder",
                accessType: "READ",
                urlTemplate: "https://httpbin.org/status/200",
                requiresIdentity: false,
                requiresConfirmation: false,
            },
        });
        actionId = created.json.data.actionId;
        createdActionIds.push(actionId);
    });

    test("enabling without testing still leaves lastTestStatus null (guard requires BOTH enabled AND PASS)", async () => {
        const result = await patch(`/api/org/${SEED_ORG_ID}/actions/${actionId}`, { headers: AUTH_A, body: { enabled: true } });
        assert.equal(result.status, 200);
        assert.equal(result.json.data.enabled, true);
        assert.equal(result.json.data.lastTestStatus, null);
    });

    test("a real test call flips lastTestStatus to PASS on a 2xx response", async () => {
        const result = await post(`/api/org/${SEED_ORG_ID}/actions/${actionId}/test`, { headers: AUTH_A, body: { args: {} } });
        assert.equal(result.status, 200);
        assert.equal(result.json.data.lastTestStatus, "PASS");
        assert.equal(result.json.data.httpStatus, 200);

        const fetched = await get(`/api/org/${SEED_ORG_ID}/actions`, { headers: AUTH_A });
        const action = fetched.json.data.find((a) => a.actionId === actionId);
        assert.equal(action.lastTestStatus, "PASS");
        assert.equal(action.enabled, true);
    });

    test("changing urlTemplate resets lastTestStatus to null — the action goes invisible again", async () => {
        const result = await patch(`/api/org/${SEED_ORG_ID}/actions/${actionId}`, {
            headers: AUTH_A,
            body: { urlTemplate: "https://httpbin.org/status/201" },
        });
        assert.equal(result.status, 200);
        assert.equal(result.json.data.lastTestStatus, null, "URL change must reset lastTestStatus");
        assert.equal(result.json.data.enabled, true, "enabled flag itself is untouched by a URL change");
    });

    test("a test call against a failing endpoint sets lastTestStatus to FAIL, not PASS", async () => {
        await patch(`/api/org/${SEED_ORG_ID}/actions/${actionId}`, { headers: AUTH_A, body: { urlTemplate: "https://httpbin.org/status/500" } });
        const result = await post(`/api/org/${SEED_ORG_ID}/actions/${actionId}/test`, { headers: AUTH_A, body: {} });
        assert.equal(result.status, 200);
        assert.equal(result.json.data.lastTestStatus, "FAIL");
    });

    test("disabling the action is independent of its test status", async () => {
        const result = await patch(`/api/org/${SEED_ORG_ID}/actions/${actionId}`, { headers: AUTH_A, body: { enabled: false } });
        assert.equal(result.status, 200);
        assert.equal(result.json.data.enabled, false);
    });
});

describe("PATCH/DELETE /api/org/:orgId/actions/:actionId — not found paths", () => {
    test("patching a nonexistent action returns 404", async () => {
        const result = await patch(`/api/org/${SEED_ORG_ID}/actions/act_bogus`, { headers: AUTH_A, body: { enabled: true } });
        assert.equal(result.status, 404);
    });

    test("testing a nonexistent action returns 404", async () => {
        const result = await post(`/api/org/${SEED_ORG_ID}/actions/act_bogus/test`, { headers: AUTH_A, body: {} });
        assert.equal(result.status, 404);
    });

    test("deleting a nonexistent action returns 404", async () => {
        const result = await del(`/api/org/${SEED_ORG_ID}/actions/act_bogus`, { headers: AUTH_A });
        assert.equal(result.status, 404);
    });

    test("happy path delete actually removes it", async () => {
        const created = await post(`/api/org/${SEED_ORG_ID}/actions`, {
            headers: AUTH_A,
            body: { name: `Delete Me ${randomSuffix()}`, description: "x", accessType: "READ", urlTemplate: "https://example.com" },
        });
        const result = await del(`/api/org/${SEED_ORG_ID}/actions/${created.json.data.actionId}`, { headers: AUTH_A });
        assert.equal(result.status, 200);
        const doubleDelete = await del(`/api/org/${SEED_ORG_ID}/actions/${created.json.data.actionId}`, { headers: AUTH_A });
        assert.equal(doubleDelete.status, 404);
    });
});
