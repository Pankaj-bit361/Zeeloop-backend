"use strict";
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { get, post, SEED_PUBLIC_KEY } = require("./helpers/client");

// The dashboard's own support chat identifies the signed-in user: the API signs
// their email with the support workspace's widget secret, so the browser never
// holds it. runTests.js points SUPPORT_WIDGET_PUBLIC_KEY at the seeded demo
// workspace.

const TEST_URI = process.env.TEST_MONGODB_URI || "mongodb://127.0.0.1:27017/zealoop_test";

async function signUp({ verify }) {
    const email = `support-id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const signup = await post("/api/auth/signup", { body: { name: "Chat Person", email, password: "password123-strong" } });
    assert.equal(signup.json.success, true, JSON.stringify(signup.json));
    const cookie = signup.setCookie.split(";")[0];
    if (verify) {
        const token = new URL(signup.json.data.verificationUrl).searchParams.get("token");
        assert.equal((await post("/api/auth/verify-email", { cookie, body: { token } })).json.success, true);
    }
    return { email, cookie };
}

before(async () => {
    await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 3000 });
});

after(async () => {
    await mongoose.disconnect();
});

describe("GET /api/auth/support-identity", () => {
    test("signs a verified user's email so the support workspace verifies it", async () => {
        const { email, cookie } = await signUp({ verify: true });
        const result = await get("/api/auth/support-identity", { cookie });
        assert.equal(result.status, 200);
        assert.equal(result.json.data.email, email);
        assert.equal(result.json.data.name, "Chat Person");
        assert.match(result.json.data.signature, /^[0-9a-f]{64}$/);
        // The widget accepts it as a verified identity. (Checked through the widget rather than
        // against SEED_WIDGET_SECRET: org.test.js rotates the seeded secret.)
        const bootstrap = (identity) => post("/api/widget/bootstrap", { body: { publicKey: SEED_PUBLIC_KEY, identity } });
        const widget = await bootstrap(result.json.data);
        assert.equal(widget.status, 200);
        assert.equal(widget.json.data.identityVerified, true);
        // and the signature covers that email only
        const other = await bootstrap({ ...result.json.data, email: `x${email}` });
        assert.equal(other.json.data.identityVerified, false);
    });

    test("an unverified address gets no signature: the chat stays anonymous", async () => {
        const { cookie } = await signUp({ verify: false });
        const result = await get("/api/auth/support-identity", { cookie });
        assert.equal(result.status, 200);
        assert.equal(result.json.data.signature, null);
    });

    test("a signed-out request is refused", async () => {
        assert.equal((await get("/api/auth/support-identity")).status, 401);
    });
});
