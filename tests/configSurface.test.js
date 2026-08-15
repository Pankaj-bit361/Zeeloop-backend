// Integration tests for the configuration surface (§2.1–§2.6) against a real
// database.
//
// The two properties everything else rests on, stated as tests:
//   1. A DRAFT object never reaches production traffic.
//   2. Editing a LIVE object drops it back to DRAFT, so "Save" cannot silently
//      ship to customers.
"use strict";
const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const configFunctions = require("../functions/config/configFunctions");
const segmentFunctions = require("../functions/config/segmentFunctions");
const attributeFunctions = require("../functions/config/attributeFunctions");
const guidanceFunctions = require("../functions/config/guidanceFunctions");
const GuidanceRule = require("../models/config/guidanceRule");
const EscalationRule = require("../models/config/escalationRule");
const Attribute = require("../models/config/attribute");
const Segment = require("../models/config/segment");
const ConfigVersion = require("../models/config/configVersion");
const AuditLog = require("../models/org/auditLog");
const {
    ConfigObjectType,
    GuidanceCategory,
    PublishState,
    ConditionField,
    ConditionOperator,
    AttributeSource,
} = require("../config/enums");

const TEST_URI = process.env.TEST_MONGODB_URI || "mongodb://127.0.0.1:27017/zealoop_config_test";

let connection;
let orgId;

before(async () => {
    connection = await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 3000 });
});

after(async () => {
    await Promise.all([
        GuidanceRule.deleteMany({ orgId: { $regex: "^org_cfg_" } }),
        EscalationRule.deleteMany({ orgId: { $regex: "^org_cfg_" } }),
        Attribute.deleteMany({ orgId: { $regex: "^org_cfg_" } }),
        Segment.deleteMany({ orgId: { $regex: "^org_cfg_" } }),
        ConfigVersion.deleteMany({ orgId: { $regex: "^org_cfg_" } }),
        AuditLog.deleteMany({ orgId: { $regex: "^org_cfg_" } }),
    ]);
    if (connection) await mongoose.disconnect();
});

// A fresh org per test, so one test's rules cannot leak into another's prompt.
beforeEach(() => {
    orgId = `org_cfg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
});

const newRule = (overrides) => ({
    category: GuidanceCategory.SOURCES,
    title: "Never invent pricing",
    body: "Only state prices that appear in the knowledge base.",
    ...overrides,
});

async function createRule(overrides) {
    const result = await configFunctions.create({
        orgId,
        objectType: ConfigObjectType.GUIDANCE_RULE,
        body: newRule(overrides),
        actorEmail: "owner@acme.com",
    });
    assert.equal(result.status, 201, JSON.stringify(result.json));
    return result.json.data;
}

describe("draft / live separation (§2.4)", () => {
    test("a new object is always a DRAFT and disabled", async () => {
        // A rule that took effect the moment it was typed would mean there is
        // no way to write one without shipping it.
        const rule = await createRule();
        assert.equal(rule.publishState, PublishState.DRAFT);
        assert.equal(rule.enabled, false);
    });

    test("a draft never reaches the prompt", async () => {
        await createRule({ body: "DRAFT RULE MUST NOT SHIP" });
        const loaded = await guidanceFunctions.loadForTurn({ orgId, context: {} });
        assert.doesNotMatch(loaded.guidancePrompt || "", /DRAFT RULE MUST NOT SHIP/);
    });

    test("publishing puts it in the prompt", async () => {
        const rule = await createRule({ body: "Never guarantee delivery dates." });
        await configFunctions.publish({
            orgId,
            objectType: ConfigObjectType.GUIDANCE_RULE,
            objectId: rule.guidanceRuleId,
            actorEmail: "owner@acme.com",
        });

        const loaded = await guidanceFunctions.loadForTurn({ orgId, context: {} });
        assert.match(loaded.guidancePrompt, /Never guarantee delivery dates\./);
        assert.ok(loaded.appliedRuleIds.includes(rule.guidanceRuleId));
    });

    test("editing a live object un-publishes it, and says so", async () => {
        // Otherwise "Save" silently ships to customers, which is the exact
        // thing draft/live exists to stop.
        const rule = await createRule();
        await configFunctions.publish({ orgId, objectType: ConfigObjectType.GUIDANCE_RULE, objectId: rule.guidanceRuleId });

        const updated = await configFunctions.update({
            orgId,
            objectType: ConfigObjectType.GUIDANCE_RULE,
            objectId: rule.guidanceRuleId,
            body: { body: "Edited body." },
        });

        assert.equal(updated.json.data.publishState, PublishState.DRAFT);
        assert.equal(updated.json.unpublished, true, "the caller must be told the edit took it out of production");

        const loaded = await guidanceFunctions.loadForTurn({ orgId, context: {} });
        assert.doesNotMatch(loaded.guidancePrompt || "", /Edited body\./);
    });

    test("publish and enable are separate, so a live rule can be paused", async () => {
        const rule = await createRule();
        await configFunctions.publish({ orgId, objectType: ConfigObjectType.GUIDANCE_RULE, objectId: rule.guidanceRuleId });
        await configFunctions.publish({
            orgId,
            objectType: ConfigObjectType.GUIDANCE_RULE,
            objectId: rule.guidanceRuleId,
            enabled: false,
        });

        const fresh = await GuidanceRule.findOne({ orgId, guidanceRuleId: rule.guidanceRuleId }).lean();
        // Still published, just switched off — pausing for an afternoon must not
        // require re-publishing afterwards.
        assert.equal(fresh.publishState, PublishState.LIVE);
        assert.equal(fresh.enabled, false);

        const loaded = await guidanceFunctions.loadForTurn({ orgId, context: {} });
        assert.equal(loaded.guidancePrompt, "");
    });

    test("publishing writes an audit row", async () => {
        const rule = await createRule();
        await configFunctions.publish({
            orgId,
            objectType: ConfigObjectType.GUIDANCE_RULE,
            objectId: rule.guidanceRuleId,
            actorEmail: "owner@acme.com",
        });

        const entry = await AuditLog.findOne({ orgId, targetId: rule.guidanceRuleId }).lean();
        assert.ok(entry);
        assert.equal(entry.actorEmail, "owner@acme.com");
    });
});

describe("version history and restore (§2.5)", () => {
    test("every edit records the state BEFORE it", async () => {
        // Storing the prior body means restoring version N is a single write,
        // with no chain of diffs to replay.
        const rule = await createRule({ body: "Version one." });
        await configFunctions.update({
            orgId,
            objectType: ConfigObjectType.GUIDANCE_RULE,
            objectId: rule.guidanceRuleId,
            body: { body: "Version two." },
        });

        const versions = await configFunctions.listVersions({
            orgId,
            objectType: ConfigObjectType.GUIDANCE_RULE,
            objectId: rule.guidanceRuleId,
        });

        assert.ok(versions.json.data.length >= 1);
        assert.equal(versions.json.data[0].snapshot.body, "Version one.");
    });

    test("restore brings back the old body and bumps the version forward", async () => {
        // History stays append-only, so "restored to v1" is itself v3 and the
        // trail of what happened survives.
        const rule = await createRule({ body: "Original." });
        await configFunctions.update({
            orgId,
            objectType: ConfigObjectType.GUIDANCE_RULE,
            objectId: rule.guidanceRuleId,
            body: { body: "Regrettable rewrite." },
        });

        const restored = await configFunctions.restore({
            orgId,
            objectType: ConfigObjectType.GUIDANCE_RULE,
            objectId: rule.guidanceRuleId,
            version: 1,
            actorEmail: "owner@acme.com",
        });

        assert.equal(restored.json.data.body, "Original.");
        assert.ok(restored.json.data.version > 2, "restore must move the counter forward, never rewind it");
        // And it lands in DRAFT, for the same reason an edit does.
        assert.equal(restored.json.data.publishState, PublishState.DRAFT);
    });

    test("restoring a version that does not exist 404s", async () => {
        const rule = await createRule();
        const result = await configFunctions.restore({
            orgId,
            objectType: ConfigObjectType.GUIDANCE_RULE,
            objectId: rule.guidanceRuleId,
            version: 99,
        });
        assert.equal(result.status, 404);
    });

    test("a delete is snapshotted, because a delete is when someone wants it back", async () => {
        const rule = await createRule({ body: "About to be deleted." });
        await configFunctions.remove({ orgId, objectType: ConfigObjectType.GUIDANCE_RULE, objectId: rule.guidanceRuleId });

        const versions = await ConfigVersion.find({ orgId, objectId: rule.guidanceRuleId }).lean();
        assert.ok(versions.some((version) => version.note === "deleted"));
    });
});

describe("write-time validation", () => {
    test("a guidance rule needs a title, a body and a real category", async () => {
        const noBody = await configFunctions.create({
            orgId,
            objectType: ConfigObjectType.GUIDANCE_RULE,
            body: { title: "x", category: GuidanceCategory.OTHER },
        });
        assert.equal(noBody.status, 400);

        const badCategory = await configFunctions.create({
            orgId,
            objectType: ConfigObjectType.GUIDANCE_RULE,
            body: { title: "x", body: "y", category: "VIBES" },
        });
        assert.equal(badCategory.status, 400);
        assert.match(badCategory.json.error, /category must be one of/);
    });

    test("an escalation rule with no conditions is refused", async () => {
        // It would match every turn, and every conversation escalating is
        // expensive enough to refuse at write time.
        const result = await configFunctions.create({
            orgId,
            objectType: ConfigObjectType.ESCALATION_RULE,
            body: { title: "Escalate everything", conditions: [] },
        });

        assert.equal(result.status, 400);
        assert.match(result.json.error, /at least one condition/);
    });

    test("an escalation rule with a bad condition field is refused", async () => {
        const result = await configFunctions.create({
            orgId,
            objectType: ConfigObjectType.ESCALATION_RULE,
            body: {
                title: "Bad field",
                conditions: [{ field: "WIDGET_SECRET", operator: ConditionOperator.IS_SET }],
            },
        });
        assert.equal(result.status, 400);
    });

    test("a PATCH is validated against the merged object, not against itself", async () => {
        // Patching one field must not be able to produce an invalid whole.
        const rule = await createRule();
        const result = await configFunctions.update({
            orgId,
            objectType: ConfigObjectType.GUIDANCE_RULE,
            objectId: rule.guidanceRuleId,
            body: { title: "   " },
        });
        assert.equal(result.status, 400);
    });

    test("stats and publishState are not client-writable", async () => {
        // A client that could write these could fake its own attribution
        // numbers and publish without publishing.
        const rule = await configFunctions.create({
            orgId,
            objectType: ConfigObjectType.GUIDANCE_RULE,
            body: { ...newRule(), stats: { used: 9999 }, publishState: PublishState.LIVE },
        });

        assert.equal(rule.json.data.publishState, PublishState.DRAFT);
        assert.equal(rule.json.data.stats.used, 0);
    });
});

describe("deterministic escalation (§2.2)", () => {
    test("a matching rule fires before generation and names itself", async () => {
        const created = await configFunctions.create({
            orgId,
            objectType: ConfigObjectType.ESCALATION_RULE,
            body: {
                title: "Escalate after 3 turns",
                conditions: [{ field: ConditionField.TURN_COUNT, operator: ConditionOperator.GREATER_THAN, value: 3 }],
            },
        });
        await configFunctions.publish({
            orgId,
            objectType: ConfigObjectType.ESCALATION_RULE,
            objectId: created.json.data.escalationRuleId,
        });

        const fired = await guidanceFunctions.loadForTurn({ orgId, context: { turnCount: 5 } });
        assert.equal(fired.escalation.triggered, true);
        assert.equal(fired.escalation.rule.title, "Escalate after 3 turns");

        const quiet = await guidanceFunctions.loadForTurn({ orgId, context: { turnCount: 1 } });
        assert.equal(quiet.escalation.triggered, false);
    });
});

describe("segments (§2.6)", () => {
    test("a segment audience restricts which rules load", async () => {
        const segment = await segmentFunctions.createSegment({
            orgId,
            name: "Verified customers",
            conditions: [{ field: ConditionField.IDENTITY_VERIFIED, operator: ConditionOperator.EQUALS, value: true }],
        });
        const segmentId = segment.json.data.segmentId;

        const rule = await createRule({ body: "VERIFIED ONLY RULE" });
        await configFunctions.update({
            orgId,
            objectType: ConfigObjectType.GUIDANCE_RULE,
            objectId: rule.guidanceRuleId,
            body: { audience: { type: "segment", segmentId } },
        });
        await configFunctions.publish({ orgId, objectType: ConfigObjectType.GUIDANCE_RULE, objectId: rule.guidanceRuleId });

        const verified = await guidanceFunctions.loadForTurn({ orgId, context: { identityVerified: true } });
        assert.match(verified.guidancePrompt, /VERIFIED ONLY RULE/);

        const anonymous = await guidanceFunctions.loadForTurn({ orgId, context: { identityVerified: false } });
        assert.doesNotMatch(anonymous.guidancePrompt || "", /VERIFIED ONLY RULE/);
    });

    test("deleting a referenced segment is refused, and says what uses it", async () => {
        // Cascading would silently widen every rule from "paid customers" to
        // "everyone" — a behaviour change nobody asked for and nobody sees.
        const segment = await segmentFunctions.createSegment({ orgId, name: "In use", conditions: [] });
        const segmentId = segment.json.data.segmentId;

        const rule = await createRule();
        await configFunctions.update({
            orgId,
            objectType: ConfigObjectType.GUIDANCE_RULE,
            objectId: rule.guidanceRuleId,
            body: { audience: { type: "segment", segmentId } },
        });

        const result = await segmentFunctions.deleteSegment({ orgId, segmentId });
        assert.equal(result.status, 409);
        assert.equal(result.json.references.length, 1);
        assert.equal(result.json.references[0].objectId, rule.guidanceRuleId);
    });

    test("an unreferenced segment deletes cleanly", async () => {
        const segment = await segmentFunctions.createSegment({ orgId, name: "Unused", conditions: [] });
        const result = await segmentFunctions.deleteSegment({ orgId, segmentId: segment.json.data.segmentId });
        assert.equal(result.status, 200);
    });
});

describe("attributes (§2.3)", () => {
    test("seeding is idempotent and ships all four built-ins live", async () => {
        // A workspace whose inbox has four permanently empty columns until
        // someone finds a settings page has been given homework.
        const first = await attributeFunctions.seedBuiltIns({ orgId });
        const second = await attributeFunctions.seedBuiltIns({ orgId });

        assert.equal(first.created, 4);
        assert.equal(second.created, 0);

        const attributes = await Attribute.find({ orgId }).lean();
        assert.equal(attributes.length, 4);
        for (const attribute of attributes) {
            assert.equal(attribute.publishState, PublishState.LIVE);
            assert.equal(attribute.enabled, true);
        }
    });

    test("built-in value descriptions are real few-shot definitions, not labels", () => {
        // A value defined as "billing" classifies badly; one defined with
        // examples, common questions and keywords classifies well. That is the
        // entire difference between this feature working and not.
        for (const attribute of attributeFunctions.BUILT_IN_ATTRIBUTES) {
            for (const value of attribute.values) {
                assert.ok(value.description.length > 40, `${attribute.key}.${value.name} description is too thin`);
            }
        }
    });

    test("a built-in attribute cannot be deleted", async () => {
        await attributeFunctions.seedBuiltIns({ orgId });
        const sentiment = await Attribute.findOne({ orgId, key: attributeFunctions.BUILT_IN_KEYS.SENTIMENT }).lean();

        const result = await configFunctions.remove({
            orgId,
            objectType: ConfigObjectType.ATTRIBUTE,
            objectId: sentiment.attributeId,
        });

        assert.equal(result.status, 400);
        assert.match(result.json.error, /not deleted/);
    });

    test("attribute values must be unique and non-empty", async () => {
        const duplicate = await configFunctions.create({
            orgId,
            objectType: ConfigObjectType.ATTRIBUTE,
            body: { name: "Tier", values: [{ name: "gold" }, { name: "GOLD" }] },
        });
        assert.equal(duplicate.status, 400);
        assert.match(duplicate.json.error, /unique/);

        const empty = await configFunctions.create({
            orgId,
            objectType: ConfigObjectType.ATTRIBUTE,
            body: { name: "Tier", values: [] },
        });
        assert.equal(empty.status, 400);
    });

    test("a manual override refuses a value outside the defined set", async () => {
        // Free text here would make the inbox filters useless within a week.
        await attributeFunctions.seedBuiltIns({ orgId });
        const sentiment = await Attribute.findOne({ orgId, key: attributeFunctions.BUILT_IN_KEYS.SENTIMENT }).lean();

        const Conversation = require("../models/conversation/conversation");
        const conversationId = `conv_cfg_${Date.now()}`;
        await Conversation.create({ orgId, conversationId });

        const bad = await attributeFunctions.setValue({
            orgId,
            conversationId,
            attributeId: sentiment.attributeId,
            value: "VERY_CROSS",
            actorEmail: "agent@acme.com",
        });
        assert.equal(bad.status, 400);

        const good = await attributeFunctions.setValue({
            orgId,
            conversationId,
            attributeId: sentiment.attributeId,
            value: "ANGRY",
            actorEmail: "agent@acme.com",
        });
        assert.equal(good.status, 200);
        assert.equal(good.json.data.attributes[0].source, AttributeSource.MANUAL);

        await Conversation.deleteOne({ orgId, conversationId });
    });

    test("a manual value survives a later detection pass", async () => {
        // Losing a human's correction is not recoverable, so manual wins twice:
        // once in the filter, once in the merge.
        const merged = attributeFunctions._merge({
            existing: [{ attributeId: "atr_1", value: "BILLING", source: AttributeSource.MANUAL }],
            incoming: [{ attributeId: "atr_1", value: "HOW_TO", source: AttributeSource.DETECTED }],
        });

        assert.equal(merged.length, 1);
        assert.equal(merged[0].value, "BILLING");
        assert.equal(merged[0].source, AttributeSource.MANUAL);
    });

    test("a detected value replaces an earlier detected value", async () => {
        const merged = attributeFunctions._merge({
            existing: [{ attributeId: "atr_1", value: "NEUTRAL", source: AttributeSource.DETECTED }],
            incoming: [{ attributeId: "atr_1", value: "ANGRY", source: AttributeSource.DETECTED }],
        });
        assert.equal(merged[0].value, "ANGRY");
    });
});

describe("tenancy", () => {
    test("one workspace cannot read another's configuration", async () => {
        const rule = await createRule();
        const otherOrgId = `org_cfg_other_${Date.now()}`;

        const result = await configFunctions.get({
            orgId: otherOrgId,
            objectType: ConfigObjectType.GUIDANCE_RULE,
            objectId: rule.guidanceRuleId,
        });
        assert.equal(result.status, 404);
    });

    test("one workspace's published rules never reach another's prompt", async () => {
        const rule = await createRule({ body: "TENANT A ONLY" });
        await configFunctions.publish({ orgId, objectType: ConfigObjectType.GUIDANCE_RULE, objectId: rule.guidanceRuleId });

        const loaded = await guidanceFunctions.loadForTurn({ orgId: `org_cfg_other_${Date.now()}`, context: {} });
        assert.equal(loaded.guidancePrompt, "");
    });
});
