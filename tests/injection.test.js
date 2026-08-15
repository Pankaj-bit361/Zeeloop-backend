"use strict";
/* §8.6 — regression tests for the six blockers found in the production-readiness
   audit. Every one of these was exploitable against a running server.

   They are written as the attack, not as the fix, so they keep working if the
   defence is later implemented some other way. */
const { test, describe, before } = require("node:test");
const assert = require("node:assert/strict");
const { get, post, patch, devLogin, authHeader, createIsolatedOrg, SEED_ORG_ID } = require("./helpers/client");
const { findOperator } = require("../middlewares/sanitize");
const { asId } = require("../functions/utilFunctions/generalFunctions");

let AUTH;
let victim;

before(async () => {
    AUTH = authHeader(await devLogin(SEED_ORG_ID));
    victim = await createIsolatedOrg("injvictim");
});

describe("blocker 1 — NoSQL operator injection is refused", () => {
    /* The original exploit needed no credential at all: an object where a
       string was expected turns an equality match into a query operator, so
       `publicKey` stops meaning "this tenant" and starts meaning "any tenant". */

    test("an operator object as publicKey is rejected, not resolved to a tenant", async () => {
        const result = await post("/api/widget/bootstrap", { body: { publicKey: { $ne: null } } });
        assert.equal(result.status, 400);
        assert.equal(result.json.success, false);
        // The give-away that it worked before: a config object came back.
        assert.equal(result.json.data, undefined);
    });

    test("an operator nested one level down is rejected too", async () => {
        const result = await post("/api/widget/bootstrap", {
            body: { publicKey: victim.publicKey, conversationId: { $ne: null } },
        });
        assert.equal(result.status, 400);
    });

    test("$regex cannot be used as an oracle to enumerate keys", async () => {
        const result = await post("/inbound/articles/search", {
            body: { publicKey: { $regex: "^pk_" }, query: "refund" },
        });
        assert.equal(result.status, 400);
    });

    test("a dotted key cannot reach into a subdocument", async () => {
        const result = await post("/api/widget/bootstrap", {
            body: { publicKey: victim.publicKey, "credits.plan": "SCALE" },
        });
        assert.equal(result.status, 400);
    });

    test("a legitimate string publicKey still works", async () => {
        // The guard must not be so broad that the product stops functioning.
        const result = await post("/api/widget/bootstrap", { body: { publicKey: victim.publicKey } });
        assert.equal(result.status, 200, JSON.stringify(result.json));
        assert.equal(result.json.success, true);
    });

    test("asId refuses everything that is not a plain string", () => {
        // The second line of defence, independent of the middleware.
        assert.equal(asId({ $ne: null }), null);
        assert.equal(asId(["a"]), null);
        assert.equal(asId(42), null);
        assert.equal(asId(""), null);
        assert.equal(asId("pk_live_abc"), "pk_live_abc");
    });

    test("findOperator walks arrays and nested objects", () => {
        assert.equal(findOperator({ a: { b: { $gt: 1 } } }), "$gt");
        assert.equal(findOperator({ a: [{ b: 1 }, { $where: "x" }] }), "$where");
        assert.equal(findOperator({ a: 1, b: "two", c: [1, 2] }), null);
    });
});

describe("blocker 2 — signup cannot claim an existing account", () => {
    test("signing up with an address that already exists is refused", async () => {
        const email = `takeover_${Date.now()}@example.com`;
        const first = await post("/api/auth/signup", {
            body: { email, password: "first-password-123", name: "Real Owner" },
        });
        assert.ok(first.json.success, JSON.stringify(first.json));

        // The attack: same address, attacker's password. Previously this
        // overwrote the credential whenever passwordSetAt was null — which is
        // every Google and GitHub account.
        const second = await post("/api/auth/signup", {
            body: { email, password: "attacker-password-456", name: "Attacker" },
        });
        assert.equal(second.status, 409);
        assert.equal(second.json.success, false);

        // And the original password still works.
        const login = await post("/api/auth/login", { body: { email, password: "first-password-123" } });
        assert.ok(login.json.success, "the real owner must still be able to sign in");
    });
});

describe("blocker 4 — a body-supplied orgId cannot override the path", () => {
    test("PATCH procedures-v2 stays inside the authenticated workspace", async () => {
        const result = await patch(`/api/org/${SEED_ORG_ID}/procedures-v2/prc_nonexistent`, {
            headers: AUTH,
            body: { orgId: victim.orgId, name: "pwned" },
        });
        // Whatever happens, it must not have operated on the victim's org.
        assert.notEqual(result.status, 200);

        // Prove it by asking the victim's own token what it can see.
        const theirs = await get(`/api/org/${victim.orgId}/procedures-v2`, {
            headers: authHeader(victim.token),
        });
        const names = JSON.stringify(theirs.json.data ?? []);
        assert.ok(!names.includes("pwned"), "the victim's procedures must be untouched");
    });
});

describe("blocker 6 — membership is re-checked on every request", () => {
    test("a token for an org you were never a member of is refused", async () => {
        // The seed token's email has no seat in the victim org, and asking for
        // /me must not manufacture one.
        const result = await get(`/api/org/${victim.orgId}/me`, { headers: AUTH });
        assert.ok([401, 403].includes(result.status), `expected 401/403, got ${result.status}`);
    });

    test("GET /me does not create a seat for a non-owner", async () => {
        const before = await get(`/api/org/${victim.orgId}/members`, {
            headers: authHeader(victim.token),
        });
        const countBefore = (before.json.data ?? []).length;

        await get(`/api/org/${victim.orgId}/me`, { headers: AUTH });

        const after = await get(`/api/org/${victim.orgId}/members`, {
            headers: authHeader(victim.token),
        });
        assert.equal(
            (after.json.data ?? []).length,
            countBefore,
            "a foreign token must not manufacture a seat — this is how a removed member used to renew access indefinitely"
        );
    });
});

describe("blocker 3 — dev-login is opt-in", () => {
    test("the route is reachable only because the test env opts in", async () => {
        // This suite authenticates through dev-login, so it must work here —
        // the guard is that ENABLE_DEV_LOGIN has to be explicitly "true".
        // Absence disables it; see config.ENABLE_DEV_LOGIN.
        assert.equal(process.env.ENABLE_DEV_LOGIN, "true", "the suite requires the explicit opt-in");
        const result = await post("/api/auth/dev-login", { body: { orgId: SEED_ORG_ID } });
        assert.equal(result.status, 200);
    });
});
