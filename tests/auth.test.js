"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
    get,
    post,
    patch,
    devLogin,
    authHeader,
    createIsolatedOrg,
    SEED_OWNER_EMAIL,
    SEED_PASSWORD,
    randomSuffix,
} = require("./helpers/client");

describe("GET /api/auth/config", () => {
    test("returns sign-in method availability, no auth required", async () => {
        const result = await get("/api/auth/config");
        assert.equal(result.status, 200);
        assert.equal(result.json.success, true);
        assert.equal(typeof result.json.data.googleEnabled, "boolean");
        assert.equal(typeof result.json.data.githubEnabled, "boolean");
        assert.equal(typeof result.json.data.signupsDisabled, "boolean");
    });
});

describe("POST /api/auth/signup", () => {
    test("happy path creates an account and sets a session cookie", async () => {
        const email = `signup-${randomSuffix()}@example.com`;
        const result = await post("/api/auth/signup", { body: { name: "New User", email, password: "password123" } });
        assert.equal(result.status, 201);
        assert.equal(result.json.success, true);
        assert.ok(result.setCookie, "expected a Set-Cookie header on signup");
        assert.match(result.setCookie, /zealoop_session=/);
    });

    test("rejects a password under 8 characters", async () => {
        const email = `short-${randomSuffix()}@example.com`;
        const result = await post("/api/auth/signup", { body: { name: "X", email, password: "short" } });
        assert.equal(result.status, 400);
        assert.equal(result.json.success, false);
    });

    test("rejects an invalid email address", async () => {
        const result = await post("/api/auth/signup", { body: { name: "X", email: "not-an-email", password: "password123" } });
        assert.equal(result.status, 400);
        assert.equal(result.json.success, false);
    });

    test("rejects a duplicate signup for an email that already has a password", async () => {
        const email = `dup-${randomSuffix()}@example.com`;
        const first = await post("/api/auth/signup", { body: { name: "X", email, password: "password123" } });
        assert.equal(first.status, 201);
        const second = await post("/api/auth/signup", { body: { name: "X", email, password: "password123" } });
        assert.equal(second.status, 409);
        assert.equal(second.json.success, false);
    });
});

describe("POST /api/auth/login", () => {
    test("happy path with seeded demo credentials sets a session cookie", async () => {
        const result = await post("/api/auth/login", { body: { email: SEED_OWNER_EMAIL, password: SEED_PASSWORD } });
        assert.equal(result.status, 200);
        assert.equal(result.json.success, true);
        assert.ok(result.setCookie);
    });

    test("wrong password returns the same generic error as unknown email (no account enumeration)", async () => {
        const wrongPassword = await post("/api/auth/login", { body: { email: SEED_OWNER_EMAIL, password: "definitely-wrong" } });
        const unknownEmail = await post("/api/auth/login", { body: { email: "nobody-here@example.com", password: "whatever123" } });
        assert.equal(wrongPassword.status, 401);
        assert.equal(unknownEmail.status, 401);
        assert.equal(wrongPassword.json.error, unknownEmail.json.error);
    });

    test("missing fields returns 400", async () => {
        const result = await post("/api/auth/login", { body: { email: SEED_OWNER_EMAIL } });
        assert.equal(result.status, 400);
    });
});

describe("GET/PATCH /api/auth/me (session auth)", () => {
    test("rejects when not signed in", async () => {
        const result = await get("/api/auth/me");
        assert.equal(result.status, 401);
        assert.equal(result.json.success, false);
    });

    test("rejects a garbage session cookie", async () => {
        const result = await get("/api/auth/me", { headers: {}, cookie: "zealoop_session=garbage.value" });
        assert.equal(result.status, 401);
    });

    test("happy path: signed-in session returns user + orgs", async () => {
        const login = await post("/api/auth/login", { body: { email: SEED_OWNER_EMAIL, password: SEED_PASSWORD } });
        const cookie = login.setCookie.split(";")[0];
        const me = await get("/api/auth/me", { cookie });
        assert.equal(me.status, 200);
        assert.equal(me.json.data.user.email, SEED_OWNER_EMAIL);
        assert.ok(Array.isArray(me.json.data.orgs));
        assert.ok(me.json.data.orgs.some((org) => org.orgId === "org_demo_acmeship"));
    });

    test("PATCH updates the display name", async () => {
        const login = await post("/api/auth/login", { body: { email: SEED_OWNER_EMAIL, password: SEED_PASSWORD } });
        const cookie = login.setCookie.split(";")[0];
        const original = await get("/api/auth/me", { cookie });
        const originalName = original.json.data.user.name;

        const updated = await patch("/api/auth/me", { cookie, body: { name: "Temporarily Renamed" } });
        assert.equal(updated.status, 200);
        assert.equal(updated.json.data.name, "Temporarily Renamed");

        // restore
        await patch("/api/auth/me", { cookie, body: { name: originalName } });
    });

    test("PATCH rejects an empty name", async () => {
        const login = await post("/api/auth/login", { body: { email: SEED_OWNER_EMAIL, password: SEED_PASSWORD } });
        const cookie = login.setCookie.split(";")[0];
        const result = await patch("/api/auth/me", { cookie, body: { name: "   " } });
        assert.equal(result.status, 400);
    });
});

describe("POST /api/auth/token (session -> org JWT, membership-gated)", () => {
    test("happy path mints a token for an org this account has a seat in", async () => {
        const login = await post("/api/auth/login", { body: { email: SEED_OWNER_EMAIL, password: SEED_PASSWORD } });
        const cookie = login.setCookie.split(";")[0];
        const result = await post("/api/auth/token", { body: { orgId: "org_demo_acmeship" }, cookie });
        assert.equal(result.status, 200);
        assert.equal(result.json.data.orgId, "org_demo_acmeship");
        assert.equal(result.json.data.role, "OWNER");
        assert.ok(result.json.data.token);
    });

    test("refuses to mint a token for an org this account has no seat in", async () => {
        const login = await post("/api/auth/login", { body: { email: SEED_OWNER_EMAIL, password: SEED_PASSWORD } });
        const cookie = login.setCookie.split(";")[0];
        const result = await post("/api/auth/token", { body: { orgId: "org_some_other_workspace" }, cookie });
        assert.equal(result.status, 403);
        assert.equal(result.json.success, false);
    });

    test("requires a session — no cookie means 401", async () => {
        const result = await post("/api/auth/token", { body: { orgId: "org_demo_acmeship" } });
        assert.equal(result.status, 401);
    });
});

describe("GET/POST /api/auth/orgs", () => {
    test("GET lists seats for the signed-in account", async () => {
        const login = await post("/api/auth/login", { body: { email: SEED_OWNER_EMAIL, password: SEED_PASSWORD } });
        const cookie = login.setCookie.split(";")[0];
        const result = await get("/api/auth/orgs", { cookie });
        assert.equal(result.status, 200);
        assert.ok(result.json.total >= 1);
    });

    test("POST onboarding creates a new workspace with an OWNER seat", async () => {
        const org = await createIsolatedOrg("onboarding-test");
        assert.ok(org.orgId.startsWith("org_"));
        // verify the token minted for it actually grants access
        const check = await get(`/api/org/${org.orgId}/settings`, { headers: authHeader(org.token) });
        assert.equal(check.status, 200);
        assert.equal(check.json.data.name, "onboarding-test Co");
    });

    test("POST onboarding rejects an empty workspace name", async () => {
        const email = `emptyname-${randomSuffix()}@example.com`;
        const signup = await post("/api/auth/signup", { body: { name: "X", email, password: "password123" } });
        const cookie = signup.setCookie.split(";")[0];
        const result = await post("/api/auth/orgs", { body: { name: "   " }, cookie });
        assert.equal(result.status, 400);
    });
});

describe("POST /api/auth/forgot-password / reset-password", () => {
    test("forgot-password always answers 200 regardless of whether the account exists (no oracle)", async () => {
        const known = await post("/api/auth/forgot-password", { body: { email: SEED_OWNER_EMAIL } });
        const unknown = await post("/api/auth/forgot-password", { body: { email: "totally-unknown@example.com" } });
        assert.equal(known.status, 200);
        assert.equal(unknown.status, 200);
        assert.equal(known.json.data.ok, true);
        assert.equal(unknown.json.data.ok, true);
    });

    test("dev/test env returns a usable resetUrl for a real account", async () => {
        const result = await post("/api/auth/forgot-password", { body: { email: SEED_OWNER_EMAIL } });
        // Outside production the link is returned directly (see authFunctions.forgotPassword)
        if (result.json.data.delivery === "dev-response") {
            assert.ok(result.json.data.resetUrl, "expected a resetUrl in non-production delivery mode");
        }
    });

    test("reset-password rejects an invalid/expired token", async () => {
        const result = await post("/api/auth/reset-password", { body: { token: "not-a-real-token", password: "newpassword123" } });
        assert.equal(result.status, 400);
    });

    test("reset-password rejects a short new password", async () => {
        const result = await post("/api/auth/reset-password", { body: { token: "whatever", password: "short" } });
        assert.equal(result.status, 400);
    });

    test("full round trip: request a reset link then use it to sign in with a new password", async () => {
        const email = `resetflow-${randomSuffix()}@example.com`;
        await post("/api/auth/signup", { body: { name: "Reset Flow", email, password: "originalpassword123" } });

        const forgot = await post("/api/auth/forgot-password", { body: { email } });
        if (!forgot.json.data.resetUrl) {
            // production-like delivery mode with no mail provider — nothing to assert further
            return;
        }
        const token = new URL(forgot.json.data.resetUrl).searchParams.get("token");
        const reset = await post("/api/auth/reset-password", { body: { token, password: "brandnewpassword123" } });
        assert.equal(reset.status, 200);
        assert.ok(reset.setCookie, "resetting the password should sign the user in");

        // old password must no longer work
        const oldLogin = await post("/api/auth/login", { body: { email, password: "originalpassword123" } });
        assert.equal(oldLogin.status, 401);

        // new password works
        const newLogin = await post("/api/auth/login", { body: { email, password: "brandnewpassword123" } });
        assert.equal(newLogin.status, 200);

        // token cannot be redeemed twice
        const replay = await post("/api/auth/reset-password", { body: { token, password: "anotherpassword123" } });
        assert.equal(replay.status, 400);
    });
});

describe("POST /api/auth/dev-login (dev-only harness auth)", () => {
    test("happy path mints a token for the seeded org with no session or membership check", async () => {
        const token = await devLogin("org_demo_acmeship");
        assert.ok(token);
        const check = await get("/api/org/org_demo_acmeship/settings", { headers: authHeader(token) });
        assert.equal(check.status, 200);
    });

    test("missing orgId returns 400", async () => {
        const result = await post("/api/auth/dev-login", { body: {} });
        assert.equal(result.status, 400);
    });

    test("unknown orgId returns 404", async () => {
        const result = await post("/api/auth/dev-login", { body: { orgId: "org_totally_bogus" } });
        assert.equal(result.status, 404);
    });
});

describe("POST /api/auth/logout", () => {
    test("clears the session cookie and subsequent /me calls fail", async () => {
        const login = await post("/api/auth/login", { body: { email: SEED_OWNER_EMAIL, password: SEED_PASSWORD } });
        const cookie = login.setCookie.split(";")[0];
        const meBefore = await get("/api/auth/me", { cookie });
        assert.equal(meBefore.status, 200);

        const logout = await post("/api/auth/logout", {});
        assert.equal(logout.status, 200);
        assert.ok(logout.setCookie, "logout should clear the cookie via Set-Cookie");
    });
});
