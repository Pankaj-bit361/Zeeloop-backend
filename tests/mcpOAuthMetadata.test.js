"use strict";
const { test, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const outbound = require("../functions/utilFunctions/outboundRequest");
const load = () => { delete require.cache[require.resolve("../functions/mcp/oauthFunctions")]; return require("../functions/mcp/oauthFunctions"); };
afterEach(() => mock.restoreAll());
test("CIMD validates identity, callback metadata and safe bounded fetching", async () => {
    const id = "https://metadata.example/codex/client.json";
    let document = { client_id: id, client_name: "Codex", redirect_uris: ["http://127.0.0.1/callback"], token_endpoint_auth_method: "none" };
    const fetch = mock.method(outbound, "outboundRequest", async () => ({ ok: true, headers: new Headers({ "content-type": "application/json", "cache-control": "no-store" }), json: async () => document }));
    const oauth = load(); const client = await oauth.clientById(id);
    assert.equal(client.name, "Codex"); assert.equal(fetch.mock.calls[0].arguments[1].maxBytes, 65_536);
    assert.equal(fetch.mock.calls[0].arguments[1].maxRedirects, 0); assert.equal(fetch.mock.calls[0].arguments[1].timeoutMs, 5000);
    assert.equal(oauth.matchesRedirect(client.redirectUris[0], "http://127.0.0.1:54321/callback"), true);
    for (const callback of ["http://localhost:54321/callback", "http://127.0.0.1:54321/other", "http://127.0.0.1:54321/callback?extra=1", "https://127.0.0.1/callback"]) assert.equal(oauth.matchesRedirect(client.redirectUris[0], callback), false);
    document = { ...document, client_id: "https://attacker.example/client.json" }; assert.equal(await oauth.clientById(id), null);
    document = { ...document, client_id: id, redirect_uris: ["http://private.example/callback"] }; assert.equal(await oauth.clientById(id), null);
    document = { ...document, redirect_uris: ["https://client.example/callback"], token_endpoint_auth_method: "client_secret_post" }; assert.equal(await oauth.clientById(id), null);
});
test("CIMD cannot fetch private or reserved hosts through the real pinned transport", async () => {
    const oauth = load();
    for (const id of ["https://127.0.0.1/client.json", "https://169.254.169.254/client.json", "https://[::1]/client.json", "https://user:password@example.com/client.json", "https://example.com/"]) assert.equal(await oauth.clientById(id), null);
});
test("OAuth redirect matching only permits variable ports on registered HTTP loopback callbacks", () => {
    const oauth = load();
    assert.equal(oauth.matchesRedirect("https://client.example/callback", "https://client.example:8443/callback"), false);
    assert.equal(oauth.matchesRedirect("http://127.0.0.1:4321/callback", "http://127.0.0.1:54321/callback"), false);
    assert.equal(oauth.matchesRedirect("http://localhost/callback", "http://localhost:54321/callback"), true);
});
