"use strict";
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { get, post, patch, del, devLogin, authHeader, SEED_ORG_ID, randomSuffix } = require("./helpers/client");

let AUTH_A;
const createdTableIds = [];

before(async () => {
    AUTH_A = authHeader(await devLogin(SEED_ORG_ID));
});

after(async () => {
    // best-effort cleanup of any tables this file created
    for (const tableId of createdTableIds) {
        await del(`/api/org/${SEED_ORG_ID}/tables/${tableId}`, { headers: AUTH_A }).catch(() => {});
    }
});

describe("GET /api/org/:orgId/tables", () => {
    test("happy path lists seeded tables (Customers, Orders)", async () => {
        const result = await get(`/api/org/${SEED_ORG_ID}/tables`, { headers: AUTH_A });
        assert.equal(result.status, 200);
        assert.ok(result.json.data.some((t) => t.name === "Customers"));
        assert.ok(result.json.data.some((t) => t.name === "Orders"));
    });

    test("requires auth", async () => {
        const result = await get(`/api/org/${SEED_ORG_ID}/tables`);
        assert.equal(result.status, 401);
    });
});

describe("POST /api/org/:orgId/tables (create + column validation)", () => {
    test("rejects a table with no columns", async () => {
        const result = await post(`/api/org/${SEED_ORG_ID}/tables`, { headers: AUTH_A, body: { name: "Empty", columns: [] } });
        assert.equal(result.status, 400);
    });

    test("rejects case-insensitive duplicate column names", async () => {
        const result = await post(`/api/org/${SEED_ORG_ID}/tables`, {
            headers: AUTH_A,
            body: { name: `Dup ${randomSuffix()}`, columns: [{ name: "email" }, { name: "Email" }] },
        });
        assert.equal(result.status, 400);
    });

    test("rejects more than one identity-key column", async () => {
        const result = await post(`/api/org/${SEED_ORG_ID}/tables`, {
            headers: AUTH_A,
            body: {
                name: `TwoKeys ${randomSuffix()}`,
                columns: [
                    { name: "email", isIdentityKey: true },
                    { name: "phone", isIdentityKey: true },
                ],
            },
        });
        assert.equal(result.status, 400);
    });

    test("when no column is marked identity key, the first column becomes it automatically", async () => {
        const result = await post(`/api/org/${SEED_ORG_ID}/tables`, {
            headers: AUTH_A,
            body: { name: `AutoIdentity ${randomSuffix()}`, columns: [{ name: "sku" }, { name: "qty", type: "number" }] },
        });
        assert.equal(result.status, 201);
        assert.equal(result.json.data.columns[0].isIdentityKey, true);
        assert.equal(result.json.data.columns[1].isIdentityKey, false);
        createdTableIds.push(result.json.data.tableId);
    });
});

describe("Table row CRUD, type coercion and identity-key uniqueness", () => {
    let tableId;

    before(async () => {
        const created = await post(`/api/org/${SEED_ORG_ID}/tables`, {
            headers: AUTH_A,
            body: {
                name: `RowProbe ${randomSuffix()}`,
                columns: [
                    { name: "orderId", isIdentityKey: true },
                    { name: "qty", type: "number" },
                    { name: "active", type: "boolean" },
                ],
            },
        });
        tableId = created.json.data.tableId;
        createdTableIds.push(tableId);
    });

    test("rejects a non-numeric value for a number column", async () => {
        const result = await post(`/api/org/${SEED_ORG_ID}/tables/${tableId}/rows`, {
            headers: AUTH_A,
            body: { data: { orderId: "A-1", qty: "not-a-number" } },
        });
        assert.equal(result.status, 400);
    });

    test("happy path creates a row with correct type coercion", async () => {
        const result = await post(`/api/org/${SEED_ORG_ID}/tables/${tableId}/rows`, {
            headers: AUTH_A,
            body: { data: { orderId: "A-1", qty: "5", active: "true" } },
        });
        assert.equal(result.status, 201);
        assert.equal(result.json.data.data.qty, 5);
        assert.equal(result.json.data.data.active, true);
        assert.equal(result.json.data.identityValue, "a-1");
    });

    test("rejects a duplicate identity-key value (409)", async () => {
        const result = await post(`/api/org/${SEED_ORG_ID}/tables/${tableId}/rows`, {
            headers: AUTH_A,
            body: { data: { orderId: "A-1", qty: 9 } },
        });
        assert.equal(result.status, 409);
    });

    test("updateRow rejects editing into another row's identity value", async () => {
        const second = await post(`/api/org/${SEED_ORG_ID}/tables/${tableId}/rows`, {
            headers: AUTH_A,
            body: { data: { orderId: "A-2", qty: 1 } },
        });
        const clash = await patch(`/api/org/${SEED_ORG_ID}/tables/${tableId}/rows/${second.json.data.rowId}`, {
            headers: AUTH_A,
            body: { data: { orderId: "A-1" } },
        });
        assert.equal(clash.status, 409);
    });

    test("CSV import upserts on identity key and reports skipped invalid rows", async () => {
        const result = await post(`/api/org/${SEED_ORG_ID}/tables/${tableId}/import`, {
            headers: AUTH_A,
            body: { csv: "orderId,qty,active\nA-1,20,false\nA-3,7,true\nA-4,notanumber,true" },
        });
        assert.equal(result.status, 200);
        assert.equal(result.json.data.updated, 1); // A-1 updated
        assert.equal(result.json.data.imported, 1); // A-3 new
        assert.equal(result.json.data.skippedCount, 1); // A-4 invalid
    });

    test("CSV import rejects a file with no data rows", async () => {
        const result = await post(`/api/org/${SEED_ORG_ID}/tables/${tableId}/import`, {
            headers: AUTH_A,
            body: { csv: "just,a,header" },
        });
        assert.equal(result.status, 400);
    });

    test("deleteRow returns 404 for an already-deleted / unknown rowId", async () => {
        const result = await del(`/api/org/${SEED_ORG_ID}/tables/${tableId}/rows/row_bogus`, { headers: AUTH_A });
        assert.equal(result.status, 404);
    });

    test("rowCount on the table is kept in sync (denormalized, recounted not incremented)", async () => {
        const table = await get(`/api/org/${SEED_ORG_ID}/tables/${tableId}`, { headers: AUTH_A });
        const rows = await get(`/api/org/${SEED_ORG_ID}/tables/${tableId}/rows`, { headers: AUTH_A });
        assert.equal(table.json.data.rowCount, rows.json.total);
    });
});

describe("DELETE /api/org/:orgId/tables/:tableId", () => {
    test("deleting a table also deletes its rows", async () => {
        const created = await post(`/api/org/${SEED_ORG_ID}/tables`, {
            headers: AUTH_A,
            body: { name: `DeleteMe ${randomSuffix()}`, columns: [{ name: "k", isIdentityKey: true }] },
        });
        const tableId = created.json.data.tableId;
        await post(`/api/org/${SEED_ORG_ID}/tables/${tableId}/rows`, { headers: AUTH_A, body: { data: { k: "x" } } });

        const result = await del(`/api/org/${SEED_ORG_ID}/tables/${tableId}`, { headers: AUTH_A });
        assert.equal(result.status, 200);
        assert.equal(result.json.data.removedRows, 1);

        const getAfter = await get(`/api/org/${SEED_ORG_ID}/tables/${tableId}`, { headers: AUTH_A });
        assert.equal(getAfter.status, 404);
    });

    test("deleting a nonexistent table returns 404", async () => {
        const result = await del(`/api/org/${SEED_ORG_ID}/tables/tbl_bogus`, { headers: AUTH_A });
        assert.equal(result.status, 404);
    });
});
