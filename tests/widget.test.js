"use strict";
const crypto = require("crypto");
const { test, describe, before } = require("node:test");
const assert = require("node:assert/strict");
const {
    get,
    post,
    devLogin,
    authHeader,
    SEED_ORG_ID,
    SEED_PUBLIC_KEY,
    SEED_VERIFIED_EMAIL,
} = require("./helpers/client");

let AUTH_A;
let WIDGET_SECRET;

before(async () => {
    AUTH_A = authHeader(await devLogin(SEED_ORG_ID));
    // Fetch the CURRENT secret dynamically rather than hardcoding the seed
    // value — org.test.js's rotate test may have changed it, and reveal is
    // the source of truth regardless of test file run order.
    const reveal = await post(`/api/org/${SEED_ORG_ID}/widget-secret/reveal`, { headers: AUTH_A });
    WIDGET_SECRET = reveal.json.data.widgetSecret;
});

function sign(email, secret = WIDGET_SECRET) {
    return crypto.createHmac("sha256", secret).update(email).digest("hex");
}

describe("POST /api/widget/bootstrap", () => {
    test("happy path with a valid publicKey, no identity", async () => {
        const result = await post("/api/widget/bootstrap", { body: { publicKey: SEED_PUBLIC_KEY } });
        assert.equal(result.status, 200);
        assert.equal(result.json.data.orgId, SEED_ORG_ID);
        assert.equal(result.json.data.identityVerified, false);
        assert.equal(result.json.data.conversationId, null, "no conversation should be created on a bare bootstrap");
    });

    test("unknown publicKey returns 404", async () => {
        const result = await post("/api/widget/bootstrap", { body: { publicKey: "pk_live_totally_bogus" } });
        assert.equal(result.status, 404);
    });

    test("missing publicKey returns 400", async () => {
        const result = await post("/api/widget/bootstrap", { body: {} });
        assert.equal(result.status, 400);
    });
});

describe("Identity HMAC verification — the security boundary between a claim and a fact", () => {
    test("a correctly signed identity is verified", async () => {
        const result = await post("/api/widget/bootstrap", {
            body: { publicKey: SEED_PUBLIC_KEY, identity: { email: SEED_VERIFIED_EMAIL, signature: sign(SEED_VERIFIED_EMAIL) } },
        });
        assert.equal(result.status, 200);
        assert.equal(result.json.data.identityVerified, true);
    });

    test("an unsigned identity claim (no signature) is NOT verified", async () => {
        const result = await post("/api/widget/bootstrap", {
            body: { publicKey: SEED_PUBLIC_KEY, identity: { email: SEED_VERIFIED_EMAIL } },
        });
        assert.equal(result.json.data.identityVerified, false);
    });

    test("a tampered signature (single bit flipped) is rejected", async () => {
        const validSig = sign(SEED_VERIFIED_EMAIL);
        const tampered = validSig.slice(0, -2) + (validSig.slice(-2) === "00" ? "11" : "00");
        const result = await post("/api/widget/bootstrap", {
            body: { publicKey: SEED_PUBLIC_KEY, identity: { email: SEED_VERIFIED_EMAIL, signature: tampered } },
        });
        assert.equal(result.json.data.identityVerified, false);
    });

    test("a signature computed with the WRONG secret is rejected", async () => {
        const wrongSig = sign(SEED_VERIFIED_EMAIL, "attacker-guessed-secret-not-the-real-one");
        const result = await post("/api/widget/bootstrap", {
            body: { publicKey: SEED_PUBLIC_KEY, identity: { email: SEED_VERIFIED_EMAIL, signature: wrongSig } },
        });
        assert.equal(result.json.data.identityVerified, false);
    });

    test("replaying one user's valid signature against a DIFFERENT email is rejected", async () => {
        const validSigForMaya = sign(SEED_VERIFIED_EMAIL);
        const result = await post("/api/widget/bootstrap", {
            body: { publicKey: SEED_PUBLIC_KEY, identity: { email: "dan@corvid.app", signature: validSigForMaya } },
        });
        assert.equal(result.json.data.identityVerified, false);
    });

    test("malformed / short / empty / null signatures are all rejected, never crash the request", async () => {
        for (const signature of ["abcd", "", null, "not-hex-at-all-zzzz"]) {
            const result = await post("/api/widget/bootstrap", {
                body: { publicKey: SEED_PUBLIC_KEY, identity: { email: SEED_VERIFIED_EMAIL, signature } },
            });
            assert.equal(result.status, 200, `signature ${JSON.stringify(signature)} must not crash the request`);
            assert.equal(result.json.data.identityVerified, false);
        }
    });
});

describe("POST /api/widget/actions/confirm — validation paths (no pending action)", () => {
    test("missing conversationId returns 400", async () => {
        const result = await post("/api/widget/actions/confirm", { body: { publicKey: SEED_PUBLIC_KEY } });
        assert.equal(result.status, 400);
    });

    test("nonexistent conversation returns 404", async () => {
        const result = await post("/api/widget/actions/confirm", {
            body: { publicKey: SEED_PUBLIC_KEY, conversationId: "conv_bogus", confirmed: true },
        });
        assert.equal(result.status, 404);
    });

    test("unknown publicKey returns 404", async () => {
        const result = await post("/api/widget/actions/confirm", {
            body: { publicKey: "pk_bogus", conversationId: "conv_whatever", confirmed: true },
        });
        assert.equal(result.status, 404);
    });

    test("confirming on a real conversation with NO pending action returns 409, never silently executes", async () => {
        // bootstrap doesn't create a conversation; creating one via a message
        // would cost an LLM call, so instead we find a seeded conversation known
        // to have no pendingAction and confirm against it.
        const conversations = await get(`/api/org/${SEED_ORG_ID}/conversations?limit=25`, { headers: AUTH_A });
        const noPending = conversations.json.data.find((c) => !c.pendingAction || !c.pendingAction.actionId);
        assert.ok(noPending, "expected at least one seeded conversation with no pending action");

        const result = await post("/api/widget/actions/confirm", {
            body: { publicKey: SEED_PUBLIC_KEY, conversationId: noPending.conversationId, confirmed: true },
        });
        assert.equal(result.status, 409);
    });
});

describe("POST /api/widget/feedback", () => {
    test("rejects an invalid rating value", async () => {
        const result = await post("/api/widget/feedback", { body: { publicKey: SEED_PUBLIC_KEY, conversationId: "conv_x", rating: "MEH" } });
        assert.equal(result.status, 400);
    });

    test("missing fields returns 400", async () => {
        const result = await post("/api/widget/feedback", { body: { publicKey: SEED_PUBLIC_KEY } });
        assert.equal(result.status, 400);
    });

    test("happy path records UP/DOWN feedback on a real conversation", async () => {
        const conversations = await get(`/api/org/${SEED_ORG_ID}/conversations?limit=1`, { headers: AUTH_A });
        const conversationId = conversations.json.data[0].conversationId;
        const result = await post("/api/widget/feedback", { body: { publicKey: SEED_PUBLIC_KEY, conversationId, rating: "UP" } });
        assert.equal(result.status, 200);
    });

    test("nonexistent conversation returns 404", async () => {
        const result = await post("/api/widget/feedback", { body: { publicKey: SEED_PUBLIC_KEY, conversationId: "conv_bogus", rating: "UP" } });
        assert.equal(result.status, 404);
    });
});

describe("POST /api/widget/messages — validation only (does not exercise the paid LLM pipeline)", () => {
    test("missing content returns 400", async () => {
        const result = await post("/api/widget/messages", { body: { publicKey: SEED_PUBLIC_KEY } });
        assert.equal(result.status, 400);
    });

    test("nonexistent conversationId returns 404 rather than silently creating one", async () => {
        const result = await post("/api/widget/messages", {
            body: { publicKey: SEED_PUBLIC_KEY, conversationId: "conv_bogus", content: "hello" },
        });
        assert.equal(result.status, 404);
    });

    test("unknown publicKey returns 404", async () => {
        const result = await post("/api/widget/messages", { body: { publicKey: "pk_bogus", content: "hi" } });
        assert.equal(result.status, 404);
    });
});

describe("POST /api/widget/conversations — client-supplied ids are the auth boundary", () => {
    test("unknown ids resolve to an empty array, not an error", async () => {
        const result = await post("/api/widget/conversations", {
            body: { publicKey: SEED_PUBLIC_KEY, conversationIds: ["conv_bogus1", "conv_bogus2"] },
        });
        assert.equal(result.status, 200);
        assert.deepEqual(result.json.data, []);
    });

    test("non-array conversationIds returns 400", async () => {
        const result = await post("/api/widget/conversations", { body: { publicKey: SEED_PUBLIC_KEY, conversationIds: "not-an-array" } });
        assert.equal(result.status, 400);
    });
});

describe("POST /api/widget/help — help center (pure DB reads, no LLM)", () => {
    test("no args returns the collections overview, only READY sources", async () => {
        const result = await post("/api/widget/help", { body: { publicKey: SEED_PUBLIC_KEY } });
        assert.equal(result.status, 200);
        assert.ok(Array.isArray(result.json.data.collections));
    });

    test("query returns search hits", async () => {
        const result = await post("/api/widget/help", { body: { publicKey: SEED_PUBLIC_KEY, query: "refund" } });
        assert.equal(result.status, 200);
        assert.ok(Array.isArray(result.json.data.hits));
    });

    test("unknown chunkId returns 404", async () => {
        const result = await post("/api/widget/help", { body: { publicKey: SEED_PUBLIC_KEY, chunkId: "chk_bogus" } });
        assert.equal(result.status, 404);
    });

    test("missing publicKey returns 400", async () => {
        const result = await post("/api/widget/help", { body: {} });
        assert.equal(result.status, 400);
    });
});
