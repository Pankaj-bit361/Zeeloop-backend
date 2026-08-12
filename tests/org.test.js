"use strict";
const { test, describe, before } = require("node:test");
const assert = require("node:assert/strict");
const { get, post, patch, del, devLogin, authHeader, SEED_ORG_ID, randomSuffix } = require("./helpers/client");

let AUTH_A;

before(async () => {
    AUTH_A = authHeader(await devLogin(SEED_ORG_ID));
});

describe("GET /api/org/:orgId/settings", () => {
    test("happy path never leaks the raw widgetSecret", async () => {
        const result = await get(`/api/org/${SEED_ORG_ID}/settings`, { headers: AUTH_A });
        assert.equal(result.status, 200);
        assert.equal(result.json.data.name, "AcmeShip");
        assert.equal("widgetSecret" in result.json.data, false, "widgetSecret must never leave the backend");
        assert.match(result.json.data.widgetSecretMasked, /^ws_live_/);
    });

    test("requires auth", async () => {
        const result = await get(`/api/org/${SEED_ORG_ID}/settings`);
        assert.equal(result.status, 401);
    });
});

describe("PATCH /api/org/:orgId/settings", () => {
    test("rejects an unknown escalation mode", async () => {
        const result = await patch(`/api/org/${SEED_ORG_ID}/settings`, { headers: AUTH_A, body: { escalationMode: "CARRIER_PIGEON" } });
        assert.equal(result.status, 400);
    });

    test("rejects EMAIL escalation mode without a valid address", async () => {
        const result = await patch(`/api/org/${SEED_ORG_ID}/settings`, {
            headers: AUTH_A,
            body: { escalationMode: "EMAIL", escalationEmail: "not-an-email" },
        });
        assert.equal(result.status, 400);
    });

    test("rejects a non-hex accent color", async () => {
        const result = await patch(`/api/org/${SEED_ORG_ID}/settings`, { headers: AUTH_A, body: { widgetAccentColor: "purple" } });
        assert.equal(result.status, 400);
    });

    test("rejects an empty org name", async () => {
        const result = await patch(`/api/org/${SEED_ORG_ID}/settings`, { headers: AUTH_A, body: { name: "" } });
        assert.equal(result.status, 400);
    });

    test("happy path updates the greeting and bumps widget.configVersion", async () => {
        const before = await get(`/api/org/${SEED_ORG_ID}/settings`, { headers: AUTH_A });
        const versionBefore = before.json.data.widget.configVersion;

        const marker = `Test greeting ${randomSuffix()}`;
        const result = await patch(`/api/org/${SEED_ORG_ID}/settings`, {
            headers: AUTH_A,
            body: { greeting: marker, widgetAccentColor: "#336699" },
        });
        assert.equal(result.status, 200);
        assert.equal(result.json.data.agent.greeting, marker);
        assert.equal(result.json.data.widget.accentColor, "#336699");
        assert.ok(result.json.data.widget.configVersion > versionBefore, "widget-affecting change must bump configVersion");
        assert.ok(result.json.data.widget.themeTokens, "accent color change must derive theme tokens server-side");
    });
});

describe("widget-secret reveal / rotate", () => {
    test("reveal returns the real plaintext secret", async () => {
        const result = await post(`/api/org/${SEED_ORG_ID}/widget-secret/reveal`, { headers: AUTH_A });
        assert.equal(result.status, 200);
        assert.match(result.json.data.widgetSecret, /^ws_live_/);
    });

    test("rotate invalidates the previous secret and returns a new plaintext once", async () => {
        const before = await post(`/api/org/${SEED_ORG_ID}/widget-secret/reveal`, { headers: AUTH_A });
        const oldSecret = before.json.data.widgetSecret;

        const rotated = await post(`/api/org/${SEED_ORG_ID}/widget-secret/rotate`, { headers: AUTH_A });
        assert.equal(rotated.status, 200);
        assert.notEqual(rotated.json.data.widgetSecret, oldSecret);

        const after = await post(`/api/org/${SEED_ORG_ID}/widget-secret/reveal`, { headers: AUTH_A });
        assert.equal(after.json.data.widgetSecret, rotated.json.data.widgetSecret);

        // IMPORTANT: re-seed afterward if isolation across test files depends on
        // the well-known demo secret. We restore explicitly via reveal->no-op:
        // rotation is one-way by design (spec: "invalidates every existing
        // signature"), so we leave the new secret in place and other suites
        // that need the well-known seed secret must re-derive it dynamically
        // via reveal rather than hardcoding it.
    });

    test("requires auth", async () => {
        const result = await post(`/api/org/${SEED_ORG_ID}/widget-secret/reveal`);
        assert.equal(result.status, 401);
    });
});

describe("GET /api/org/:orgId/onboarding", () => {
    test("happy path returns a derived checklist, never stored state", async () => {
        const result = await get(`/api/org/${SEED_ORG_ID}/onboarding`, { headers: AUTH_A });
        assert.equal(result.status, 200);
        assert.equal(result.json.data.steps.length, 4);
        assert.equal(result.json.data.total, 4);
        assert.ok(result.json.data.completed >= 0 && result.json.data.completed <= 4);
    });
});

describe("GET/PATCH /api/org/:orgId/me (member self)", () => {
    test("happy path returns the caller's own seat, self-healing if absent", async () => {
        const result = await get(`/api/org/${SEED_ORG_ID}/me`, { headers: AUTH_A });
        assert.equal(result.status, 200);
        assert.equal(result.json.data.email, "ops@acmeship.com");
        assert.equal(result.json.data.role, "OWNER");
    });

    test("PATCH updates designation", async () => {
        const result = await patch(`/api/org/${SEED_ORG_ID}/me`, { headers: AUTH_A, body: { designation: "Probe Tester" } });
        assert.equal(result.status, 200);
        assert.equal(result.json.data.designation, "Probe Tester");
    });
});

describe("GET/POST /api/org/:orgId/members", () => {
    test("happy path lists seeded seats", async () => {
        const result = await get(`/api/org/${SEED_ORG_ID}/members`, { headers: AUTH_A });
        assert.equal(result.status, 200);
        assert.ok(result.json.data.length >= 3);
        assert.ok(result.json.data.some((m) => m.role === "OWNER"));
    });

    test("cannot invite a second OWNER — an org has exactly one", async () => {
        const result = await post(`/api/org/${SEED_ORG_ID}/members`, {
            headers: AUTH_A,
            body: { email: `second-owner-${randomSuffix()}@acmeship.com`, role: "OWNER" },
        });
        assert.equal(result.status, 400);
    });

    test("cannot invite an email that already has a seat", async () => {
        const result = await post(`/api/org/${SEED_ORG_ID}/members`, { headers: AUTH_A, body: { email: "ops@acmeship.com", role: "AGENT" } });
        assert.equal(result.status, 409);
    });

    test("full lifecycle: invite, verify INVITED status, remove", async () => {
        const email = `probe-member-${randomSuffix()}@acmeship.com`;
        const invite = await post(`/api/org/${SEED_ORG_ID}/members`, { headers: AUTH_A, body: { email, role: "AGENT" } });
        assert.equal(invite.status, 201);
        assert.equal(invite.json.data.status, "INVITED");

        const removed = await del(`/api/org/${SEED_ORG_ID}/members/${invite.json.data.memberId}`, { headers: AUTH_A });
        assert.equal(removed.status, 200);
    });

    test("the OWNER seat cannot be removed", async () => {
        const members = await get(`/api/org/${SEED_ORG_ID}/members`, { headers: AUTH_A });
        const owner = members.json.data.find((m) => m.role === "OWNER");
        const result = await del(`/api/org/${SEED_ORG_ID}/members/${owner.memberId}`, { headers: AUTH_A });
        assert.equal(result.status, 409);
    });

    test("removing a nonexistent member returns 404", async () => {
        const result = await del(`/api/org/${SEED_ORG_ID}/members/mem_bogus_id`, { headers: AUTH_A });
        assert.equal(result.status, 404);
    });
});

describe("GET /api/org/:orgId/users (end users / customers)", () => {
    test("happy path lists seeded end users with verified/temp counts", async () => {
        const result = await get(`/api/org/${SEED_ORG_ID}/users`, { headers: AUTH_A });
        assert.equal(result.status, 200);
        assert.ok(result.json.total >= 1);
        assert.equal(result.json.identifiedCount + result.json.temporaryCount, result.json.total);
    });

    test("verified=true filter only returns verified users", async () => {
        const result = await get(`/api/org/${SEED_ORG_ID}/users?verified=true`, { headers: AUTH_A });
        assert.equal(result.status, 200);
        for (const user of result.json.data) {
            assert.equal(user.verified, true);
        }
    });

    test("nonexistent end user returns 404", async () => {
        const result = await get(`/api/org/${SEED_ORG_ID}/users/usr_bogus`, { headers: AUTH_A });
        assert.equal(result.status, 404);
    });
});
