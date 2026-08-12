"use strict";
// Multi-tenant isolation is the single most important class of bug in this
// app: does org A's token ever leak org B's data, or vice versa. Every
// /api/org/:orgId/* and /api/knowledge/:orgId/* and /api/analytics/:orgId/*
// route uses reqOrgOwnerAuth, which checks the JWT's orgId against the path
// orgId — this suite verifies that check actually holds across every route
// family, plus checks the publicKey-scoped widget surface separately.
const { test, describe, before } = require("node:test");
const assert = require("node:assert/strict");
const { get, post, devLogin, authHeader, createIsolatedOrg, SEED_ORG_ID } = require("./helpers/client");

let AUTH_A;
let orgB;

before(async () => {
    AUTH_A = authHeader(await devLogin(SEED_ORG_ID));
    orgB = await createIsolatedOrg("crosstenant");
});

describe("JWT orgId must match the path orgId on every dashboard route family", () => {
    const routesUnderOrgA = () => [
        ["GET", `/api/org/${SEED_ORG_ID}/actions`],
        ["GET", `/api/org/${SEED_ORG_ID}/tables`],
        ["GET", `/api/org/${SEED_ORG_ID}/settings`],
        ["GET", `/api/org/${SEED_ORG_ID}/members`],
        ["GET", `/api/org/${SEED_ORG_ID}/users`],
        ["GET", `/api/org/${SEED_ORG_ID}/conversations`],
        ["GET", `/api/org/${SEED_ORG_ID}/onboarding`],
        ["GET", `/api/knowledge/${SEED_ORG_ID}/sources`],
        ["GET", `/api/knowledge/${SEED_ORG_ID}/chunks`],
        ["GET", `/api/analytics/${SEED_ORG_ID}/overview`],
        ["GET", `/api/analytics/${SEED_ORG_ID}/content-gaps`],
    ];

    test("org B's token can never read org A's data under org A's path", async () => {
        for (const [method, path] of routesUnderOrgA()) {
            const result = method === "GET" ? await get(path, { headers: authHeader(orgB.token) }) : null;
            assert.equal(result.status, 403, `${method} ${path} with org B's token must be 403, got ${result.status}`);
            assert.equal(result.json.success, false);
        }
    });

    test("org A's token can never read org B's (empty) workspace under org B's path", async () => {
        const routesUnderOrgB = [
            `/api/org/${orgB.orgId}/actions`,
            `/api/org/${orgB.orgId}/tables`,
            `/api/org/${orgB.orgId}/settings`,
            `/api/knowledge/${orgB.orgId}/sources`,
            `/api/analytics/${orgB.orgId}/overview`,
        ];
        for (const path of routesUnderOrgB) {
            const result = await get(path, { headers: AUTH_A });
            assert.equal(result.status, 403, `${path} with org A's token must be 403, got ${result.status}`);
        }
    });
});

describe("A resource id from org A is invisible under org B's own valid token + path", () => {
    test("org A's tableId 404s when queried under org B's own orgId path with org B's own valid token", async () => {
        const tablesA = await get(`/api/org/${SEED_ORG_ID}/tables`, { headers: AUTH_A });
        const someTableId = tablesA.json.data[0].tableId;

        // org B uses ITS OWN token and ITS OWN orgId in the path (passes
        // reqOrgOwnerAuth cleanly) but references org A's tableId — the route's
        // own {orgId, tableId} query filter must be what stops this, not just
        // the JWT check.
        const result = await get(`/api/org/${orgB.orgId}/tables/${someTableId}`, { headers: authHeader(orgB.token) });
        assert.equal(result.status, 404, "a table scoped to org A must not resolve under org B's own valid path+token");
    });

    test("org A's actionId 404s the same way under org B's path+token", async () => {
        const actionsA = await get(`/api/org/${SEED_ORG_ID}/actions`, { headers: AUTH_A });
        const someActionId = actionsA.json.data[0].actionId;
        const result = await post(`/api/org/${orgB.orgId}/actions/${someActionId}/test`, { headers: authHeader(orgB.token), body: {} });
        assert.equal(result.status, 404);
    });

    test("org A's conversationId 404s the same way under org B's path+token", async () => {
        const conversationsA = await get(`/api/org/${SEED_ORG_ID}/conversations?limit=1`, { headers: AUTH_A });
        const someConversationId = conversationsA.json.data[0].conversationId;
        const result = await get(`/api/org/${orgB.orgId}/conversations/${someConversationId}`, { headers: authHeader(orgB.token) });
        assert.equal(result.status, 404);
    });
});

describe("Widget surface isolation (publicKey-scoped, no JWT at all)", () => {
    test("org A's widget publicKey never surfaces org B's conversations, and vice versa", async () => {
        // Each org's publicKey only ever resolves that org's own Org document —
        // sendMessage/bootstrap look up `Org.findOne({ publicKey })`, so a
        // cross-org data leak here would mean the wrong org's agent/knowledge
        // config gets served.
        const bootstrapA = await post("/api/widget/bootstrap", { body: { publicKey: (await devLoginData()).publicKey } });
        assert.equal(bootstrapA.json.data.orgId, SEED_ORG_ID);

        const bootstrapB = await post("/api/widget/bootstrap", { body: { publicKey: orgB.publicKey } });
        assert.equal(bootstrapB.json.data.orgId, orgB.orgId);
        assert.notEqual(bootstrapB.json.data.orgId, SEED_ORG_ID);
    });

    async function devLoginData() {
        const result = await post("/api/auth/dev-login", { body: { orgId: SEED_ORG_ID } });
        return result.json.data;
    }
});

describe("Session cookie alone (no org JWT) reaches no workspace data — spec invariant", () => {
    test("a signed-in session with zero org JWT cannot read /api/org/* directly", async () => {
        // /api/auth/me works with just the cookie, but /api/org/:orgId/* always
        // requires reqOrgOwnerAuth's Bearer JWT — the cookie is identity only.
        const result = await get(`/api/org/${SEED_ORG_ID}/settings`, { cookie: orgB.cookie });
        assert.equal(result.status, 401, "a session cookie alone (no Bearer token) must not grant org data access");
    });
});
