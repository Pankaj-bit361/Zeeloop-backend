"use strict";
const { test, describe, before } = require("node:test");
const assert = require("node:assert/strict");
const { get, devLogin, authHeader, SEED_ORG_ID } = require("./helpers/client");

let AUTH_A;

before(async () => {
    AUTH_A = authHeader(await devLogin(SEED_ORG_ID));
});

/* §1.6 step 5 — the install snippet.
   
   This pins the one contract that matters most here: the global the snippet
   sets and the global the widget loader reads have to be the SAME name. They
   drifted once — the snippet set `window.zealoopSettings`, the loader read
   `window.zealoop` — and nothing caught it, because the loader's own
   missing-publicKey guard swallows the mismatch with a console.warn instead of
   a thrown error. A customer who pasted the generated snippet exactly as given
   would get a widget that silently never appears. */
describe("GET /api/org/:orgId/wizard/install — the snippet must match what the loader reads", () => {
    test("sets window.zealoop, not window.zealoopSettings", async () => {
        const result = await get(`/api/org/${SEED_ORG_ID}/wizard/install`, { headers: AUTH_A });
        assert.equal(result.status, 200);

        const { snippet } = result.json.data;
        assert.match(snippet, /window\.zealoop\s*=/, "the snippet must set window.zealoop — that's what widget/src/loader.ts and the npm SDK both read");
        assert.doesNotMatch(snippet, /zealoopSettings/, "window.zealoopSettings is not read by anything — a snippet setting it silently never boots the widget");
    });

    test("the snippet's publicKey is the org's real key, not a placeholder", async () => {
        const result = await get(`/api/org/${SEED_ORG_ID}/wizard/install`, { headers: AUTH_A });
        const { snippet, publicKey } = result.json.data;
        assert.ok(publicKey, "publicKey must be present so the dashboard can compose framework-specific variants without regexing the HTML string");
        assert.match(snippet, new RegExp(publicKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    });

    test("apiUrl is returned so every framework variant points at the same origin as the snippet's <script src>", async () => {
        const result = await get(`/api/org/${SEED_ORG_ID}/wizard/install`, { headers: AUTH_A });
        const { snippet, apiUrl } = result.json.data;
        assert.ok(apiUrl, "apiUrl must be present");
        assert.ok(snippet.includes(apiUrl), "the composed snippet's script src must be built from the same apiUrl returned alongside it");
    });

    test("requires auth", async () => {
        const result = await get(`/api/org/${SEED_ORG_ID}/wizard/install`);
        assert.equal(result.status, 401);
    });
});
