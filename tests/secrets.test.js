// Production settings come from one Secrets Manager secret, loaded by boot.js
// before server.js reads any of them. These pin the merge rules: an existing
// environment value wins, empty values are skipped, a non-JSON secret is an
// error rather than a silently empty config, and no secret id means no call.
"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { loadSecrets } = require("../config/secrets");

const fakeClient = (secretString) => {
    const calls = [];
    return { calls, send: async (command) => { calls.push(command.input); return { SecretString: secretString }; } };
};

describe("loadSecrets", () => {
    test("copies the secret's values into the environment", async () => {
        const env = {};
        const client = fakeClient(JSON.stringify({ MONGODB_URI: "mongodb://db", PORT: 8080 }));
        const set = await loadSecrets({ id: "zealoop/api", env, client });
        assert.equal(set, 2);
        assert.deepEqual(env, { MONGODB_URI: "mongodb://db", PORT: "8080" });
        assert.deepEqual(client.calls, [{ SecretId: "zealoop/api" }]);
    });

    test("an environment value wins over the secret, and empty values are skipped", async () => {
        const env = { NODE_ENV: "production" };
        const client = fakeClient(JSON.stringify({ NODE_ENV: "staging", EMPTY: "", NULLED: null, JWT_SECRET: "s" }));
        const set = await loadSecrets({ id: "zealoop/api", env, client });
        assert.equal(set, 1);
        assert.deepEqual(env, { NODE_ENV: "production", JWT_SECRET: "s" });
    });

    test("a secret that is not JSON is an error", async () => {
        await assert.rejects(loadSecrets({ id: "zealoop/api", env: {}, client: fakeClient("MONGODB_URI=x") }), /not JSON/);
    });

    test("without a secret id nothing is fetched", async () => {
        const client = fakeClient("{}");
        assert.equal(await loadSecrets({ id: "", env: {}, client }), 0);
        assert.equal(client.calls.length, 0);
    });
});
