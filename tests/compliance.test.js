// §8.1 — workspace export, end-user erasure, retention purge.
//
// The DPA published on zealoop.com already promises export and erasure, so
// these are contractual obligations rather than nice-to-haves.
"use strict";
const { test, describe, before } = require("node:test");
const assert = require("node:assert/strict");
const { get, post, del, devLogin, authHeader, createIsolatedOrg, SEED_ORG_ID } = require("./helpers/client");
const complianceFunctions = require("../functions/compliance/complianceFunctions");

let AUTH_A;

before(async () => {
    AUTH_A = authHeader(await devLogin(SEED_ORG_ID));
});

describe("GET /api/org/:orgId/export", () => {
    test("returns every collection the workspace owns", async () => {
        const result = await get(`/api/org/${SEED_ORG_ID}/export`, { headers: AUTH_A });
        assert.equal(result.status, 200);
        const data = result.json.data;
        for (const key of [
            "org",
            "members",
            "endUsers",
            "knowledgeSources",
            "chunks",
            "tables",
            "tableRows",
            "actions",
            "procedures",
            "conversations",
            "messages",
            "turnTraces",
        ]) {
            assert.ok(data[key] !== undefined, `export is missing ${key}`);
        }
        assert.ok(data.conversations.length > 0, "the seeded workspace has conversations");
        assert.ok(data.exportedAt);
    });

    test("never exports the widget secret", async () => {
        const result = await get(`/api/org/${SEED_ORG_ID}/export`, { headers: AUTH_A });
        assert.equal(result.json.data.org.widgetSecret, undefined);
        // Belt and braces: the encrypted form must not appear anywhere either.
        assert.equal(JSON.stringify(result.json.data).includes("widgetSecret"), false);
    });

    test("excludes embeddings — derived data, enormous, meaningless elsewhere", async () => {
        const result = await get(`/api/org/${SEED_ORG_ID}/export`, { headers: AUTH_A });
        const chunk = result.json.data.chunks[0];
        if (chunk) {
            assert.equal(chunk.embedding, undefined);
            assert.ok(chunk.text, "the text the embedding came from is included instead");
        }
    });

    test("requires auth", async () => {
        const result = await get(`/api/org/${SEED_ORG_ID}/export`);
        assert.equal(result.status, 401);
    });

    test("a token for one workspace cannot export another", async () => {
        const result = await get(`/api/org/org_someone_else/export`, { headers: AUTH_A });
        assert.equal(result.status, 403);
    });
});

describe("DELETE /api/org/:orgId/end-users/:endUserId", () => {
    test("erases an end user and reports what it removed", async () => {
        const org = await createIsolatedOrg("erasure");
        const auth = authHeader(org.token);

        // Bootstrap the widget with an identity so an EndUser exists to erase.
        const bootstrap = await post("/api/widget/bootstrap", {
            body: { publicKey: org.publicKey, identity: { email: "forgetme@example.com" } },
        });
        assert.equal(bootstrap.status, 200);

        const users = await get(`/api/org/${org.orgId}/users`, { headers: auth });
        assert.equal(users.status, 200);
        const target = users.json.data.find((user) => user.email === "forgetme@example.com");
        assert.ok(target, "the identified visitor should exist as an end user");

        const erased = await del(`/api/org/${org.orgId}/end-users/${target.endUserId}`, { headers: auth });
        assert.equal(erased.status, 200);
        assert.equal(erased.json.data.deleted.endUsers, 1);

        const after = await get(`/api/org/${org.orgId}/users`, { headers: auth });
        assert.equal(
            after.json.data.some((user) => user.email === "forgetme@example.com"),
            false,
            "the end user should be gone, not anonymised"
        );
    });

    test("404s for an unknown end user rather than reporting a silent success", async () => {
        const result = await del(`/api/org/${SEED_ORG_ID}/end-users/usr_does_not_exist`, { headers: AUTH_A });
        assert.equal(result.status, 404);
    });

    test("requires auth", async () => {
        const result = await del(`/api/org/${SEED_ORG_ID}/end-users/usr_whatever`);
        assert.equal(result.status, 401);
    });

    test("a token for one workspace cannot erase another's end user", async () => {
        const result = await del(`/api/org/org_someone_else/end-users/usr_x`, { headers: AUTH_A });
        assert.equal(result.status, 403);
    });
});

// The guard below is the single most important assertion in this file. An unset
// RETENTION_DAYS reading as "delete everything older than now" would be the
// worst bug in the codebase, and it is one typo away at all times.
describe("retention purge safety", () => {
    test("does nothing when retention is disabled", async () => {
        const result = await complianceFunctions.purgeExpired({ retentionDays: 0 });
        assert.equal(result.success, true);
        assert.equal(result.skipped, true);
    });

    test("does nothing when retention is undefined", async () => {
        const result = await complianceFunctions.purgeExpired({ retentionDays: undefined });
        assert.equal(result.skipped, true);
    });

    test("does nothing for a negative window", async () => {
        const result = await complianceFunctions.purgeExpired({ retentionDays: -30 });
        assert.equal(result.skipped, true);
    });

    // Deliberately not tested here: the path where a positive window actually
    // deletes. It needs a live mongoose connection inside the test process, and
    // this repo's .env points at production Atlas — a purge test that picked up
    // the wrong connection string would be unrecoverable. The guard above is
    // what protects the dangerous case; the deleting path is exercised by
    // running the cron against a local database.
});
