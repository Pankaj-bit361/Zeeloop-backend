// Shared HTTP client + fixture helpers for the integration test suite.
//
// These tests hit a REAL running server (node --watch server.js on
// BASE_URL, default http://localhost:4000) against a REAL MongoDB — no
// mocking, matching how this app is actually built and demoed. Run
// `npm run seed` first so the AcmeShip demo org exists with known data.
"use strict";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:4000";
const SEED_ORG_ID = "org_demo_acmeship";
const SEED_PUBLIC_KEY = "pk_live_zea_4Jw9TqXhK2mNvL8s";
const SEED_WIDGET_SECRET = "ws_live_demo_secret_do_not_use_in_production";
const SEED_VERIFIED_EMAIL = "maya@brightloop.io";
const SEED_OWNER_EMAIL = "ops@acmeship.com";
const SEED_PASSWORD = "zealoop-demo";

async function request(method, path, { body, headers = {}, cookie } = {}) {
    const finalHeaders = { "content-type": "application/json", ...headers };
    if (cookie) finalHeaders.cookie = cookie;
    const res = await fetch(BASE_URL + path, {
        method,
        headers: finalHeaders,
        ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    let json = null;
    try {
        json = await res.json();
    } catch (error) {
        json = null;
    }
    const setCookie = res.headers.get("set-cookie");
    return { status: res.status, json, setCookie, headers: res.headers };
}

const get = (path, opts) => request("GET", path, opts);
const post = (path, opts) => request("POST", path, opts);
const patch = (path, opts) => request("PATCH", path, opts);
const del = (path, opts) => request("DELETE", path, opts);

// Dev-login: no session, no membership check, refuses in production. Fast way
// to get a valid org-scoped Bearer token for the seeded demo org.
async function devLogin(orgId = SEED_ORG_ID) {
    const result = await post("/api/auth/dev-login", { body: { orgId } });
    if (!result.json || !result.json.success) {
        throw new Error(`devLogin failed for ${orgId}: ${JSON.stringify(result.json)}`);
    }
    return result.json.data.token; // { token, orgId, orgName, publicKey }
}

function authHeader(token) {
    return { authorization: `Bearer ${token}` };
}

// Creates a brand-new, fully independent org (signup + onboarding) for
// cross-tenant isolation tests. Returns { orgId, token, email, cookie, publicKey }.
async function createIsolatedOrg(label = "isolated") {
    const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const password = "password123-strong";
    const signup = await post("/api/auth/signup", { body: { name: "Isolated Owner", email, password } });
    if (!signup.json.success) throw new Error(`signup failed: ${JSON.stringify(signup.json)}`);
    const cookie = signup.setCookie.split(";")[0];

    const createOrg = await post("/api/auth/orgs", {
        body: { name: `${label} Co`, website: "https://example.com" },
        cookie,
    });
    if (!createOrg.json.success) throw new Error(`createOrg failed: ${JSON.stringify(createOrg.json)}`);
    const orgId = createOrg.json.data.orgId;

    const tokenResult = await post("/api/auth/token", { body: { orgId }, cookie });
    if (!tokenResult.json.success) throw new Error(`mint token failed: ${JSON.stringify(tokenResult.json)}`);

    return { orgId, token: tokenResult.json.data.token, email, cookie, publicKey: tokenResult.json.data.publicKey };
}

function randomSuffix() {
    return Math.random().toString(36).slice(2, 10);
}

module.exports = {
    BASE_URL,
    SEED_ORG_ID,
    SEED_PUBLIC_KEY,
    SEED_WIDGET_SECRET,
    SEED_VERIFIED_EMAIL,
    SEED_OWNER_EMAIL,
    SEED_PASSWORD,
    request,
    get,
    post,
    patch,
    del,
    devLogin,
    authHeader,
    createIsolatedOrg,
    randomSuffix,
};
