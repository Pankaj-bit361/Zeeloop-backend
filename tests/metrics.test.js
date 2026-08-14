// §3.3 — three-tier metrics and the documented resolution definition.
//
// The reason this split exists: a single autonomous-resolution rate cannot
// distinguish "the agent never got involved" from "the agent got involved and
// failed". Those are opposite problems with opposite fixes, and shipping one
// number hides which one you have.
"use strict";
const { test, describe, before } = require("node:test");
const assert = require("node:assert/strict");
const { get, devLogin, authHeader, SEED_ORG_ID } = require("./helpers/client");
const analyticsFunctions = require("../functions/analytics/analyticsFunctions");

let AUTH_A;

before(async () => {
    AUTH_A = authHeader(await devLogin(SEED_ORG_ID));
});

describe("GET /api/analytics/:orgId/overview — three-tier metrics", () => {
    test("reports automation, involvement and resolution separately", async () => {
        const result = await get(`/api/analytics/${SEED_ORG_ID}/overview?days=30`, { headers: AUTH_A });
        assert.equal(result.status, 200);
        const data = result.json.data;
        assert.equal(typeof data.automationRate, "number");
        assert.equal(typeof data.involvementRate, "number");
        assert.ok(data.resolutionRate === null || typeof data.resolutionRate === "number");
        assert.equal(typeof data.agentInvolvedConversations, "number");
    });

    test("every rate is a proportion, never a percentage or a count", async () => {
        const result = await get(`/api/analytics/${SEED_ORG_ID}/overview?days=30`, { headers: AUTH_A });
        const data = result.json.data;
        for (const key of ["automationRate", "involvementRate", "resolutionRate"]) {
            if (data[key] === null) continue;
            assert.ok(data[key] >= 0 && data[key] <= 1, `${key} should be in [0,1], got ${data[key]}`);
        }
    });

    test("automation = involvement × resolution, which is what makes the split meaningful", async () => {
        const result = await get(`/api/analytics/${SEED_ORG_ID}/overview?days=30`, { headers: AUTH_A });
        const { automationRate, involvementRate, resolutionRate } = result.json.data;
        if (resolutionRate === null) return;
        assert.ok(
            Math.abs(automationRate - involvementRate * resolutionRate) < 1e-9,
            `identity broken: ${automationRate} !== ${involvementRate} * ${resolutionRate}`
        );
    });

    test("resolution rate is null rather than zero when the agent was never involved", async () => {
        // Dividing by zero involvement and reporting 0% would read as "the agent
        // is terrible" when the truth is "the agent was never asked".
        const result = await get(`/api/analytics/${SEED_ORG_ID}/overview?days=1`, { headers: AUTH_A });
        const data = result.json.data;
        if (data.agentInvolvedConversations === 0) {
            assert.equal(data.resolutionRate, null);
        }
    });

    test("keeps autonomousResolutionRate so existing dashboard callers do not break", async () => {
        const result = await get(`/api/analytics/${SEED_ORG_ID}/overview?days=30`, { headers: AUTH_A });
        assert.equal(result.json.data.autonomousResolutionRate, result.json.data.automationRate);
    });

    test("ships the resolution definition alongside the number", async () => {
        const result = await get(`/api/analytics/${SEED_ORG_ID}/overview?days=30`, { headers: AUTH_A });
        assert.equal(result.json.data.resolutionDefinition, analyticsFunctions.RESOLUTION_DEFINITION);
    });

    test("requires auth", async () => {
        const result = await get(`/api/analytics/${SEED_ORG_ID}/overview`);
        assert.equal(result.status, 401);
    });
});

describe("resolution definition", () => {
    test("names every condition the cron actually enforces", () => {
        const definition = analyticsFunctions.RESOLUTION_DEFINITION.toLowerCase();
        for (const condition of ["escalation", "human", "24 hours", "unhelpful"]) {
            assert.ok(definition.includes(condition), `definition omits "${condition}"`);
        }
    });

    test("is a single exported constant, so docs and dashboard cannot drift from code", () => {
        assert.equal(typeof analyticsFunctions.RESOLUTION_DEFINITION, "string");
        assert.ok(analyticsFunctions.RESOLUTION_DEFINITION.length > 60);
    });
});
