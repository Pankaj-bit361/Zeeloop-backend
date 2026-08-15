// Integration tests for the Phase 5 and §8.2 objects: scoped API keys, the
// credential store, teams, macros and the blocklist.
"use strict";
const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const expansionFunctions = require("../functions/expansion/expansionFunctions");
const { ApiKey, Credential, Team, Macro, BlocklistEntry } = require("../models/org/expansion");
const Action = require("../models/action/action");
const Conversation = require("../models/conversation/conversation");
const Org = require("../models/org/org");
const { ApiScope, CredentialType, BlocklistType, AccessType } = require("../config/enums");

const TEST_URI = process.env.TEST_MONGODB_URI || "mongodb://127.0.0.1:27017/zealoop_expansion_test";
const ORG_PREFIX = "org_exp_";

let connection;
let orgId;

before(async () => {
    connection = await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 3000 });
    // The duplicate-entry 409 depends on the unique index existing, and
    // mongoose builds indexes in the background.
    await BlocklistEntry.init();
});

after(async () => {
    const scope = { orgId: { $regex: `^${ORG_PREFIX}` } };
    await Promise.all([
        ApiKey.deleteMany(scope),
        Credential.deleteMany(scope),
        Team.deleteMany(scope),
        Macro.deleteMany(scope),
        BlocklistEntry.deleteMany(scope),
        Action.deleteMany(scope),
        Conversation.deleteMany(scope),
        Org.deleteMany(scope),
    ]);
    if (connection) await mongoose.disconnect();
});

beforeEach(() => {
    orgId = `${ORG_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
});

describe("API keys (§5.6)", () => {
    test("the plaintext key is returned exactly once and never stored", async () => {
        // A key readable from the database is a key that leaks through any read
        // path. Only the hash is kept.
        const result = await expansionFunctions.createApiKey({
            orgId,
            name: "CI integration",
            scopes: [ApiScope.CONVERSATIONS_READ],
            actorEmail: "owner@acme.com",
        });

        assert.equal(result.status, 201);
        const plaintext = result.json.data.key;
        assert.ok(plaintext.startsWith(expansionFunctions.KEY_PREFIX));

        const stored = await ApiKey.findOne({ orgId }).lean();
        assert.notEqual(stored.keyHash, plaintext);
        assert.equal(stored.keyHash, expansionFunctions.hashKey(plaintext));

        // And the list view never exposes it again.
        const listed = await expansionFunctions.listApiKeys({ orgId });
        assert.equal(listed.json.data[0].key, undefined);
        assert.equal(listed.json.data[0].keyHash, undefined);
    });

    test("the preview identifies a key without being usable", async () => {
        const result = await expansionFunctions.createApiKey({
            orgId,
            name: "Preview test",
            scopes: [ApiScope.ANALYTICS_READ],
        });
        const preview = result.json.data.keyPreview;

        assert.match(preview, /…/);
        assert.ok(preview.length < result.json.data.key.length / 2, "the preview must not be most of the key");
    });

    test("a key with no scopes is refused", async () => {
        // It could do nothing, so creating one is always a mistake.
        const result = await expansionFunctions.createApiKey({ orgId, name: "Useless", scopes: [] });
        assert.equal(result.status, 400);
        assert.match(result.json.error, /at least one/);
    });

    test("an unknown scope is refused", async () => {
        const result = await expansionFunctions.createApiKey({ orgId, name: "Bad", scopes: ["billing:write"] });
        assert.equal(result.status, 400);
        assert.match(result.json.error, /Unknown scopes/);
    });

    test("revoking keeps the row so the audit trail stays answerable", async () => {
        const created = await expansionFunctions.createApiKey({
            orgId,
            name: "To revoke",
            scopes: [ApiScope.CONVERSATIONS_READ],
        });
        const apiKeyId = created.json.data.apiKeyId;

        await expansionFunctions.revokeApiKey({ orgId, apiKeyId, actorEmail: "owner@acme.com" });

        const stored = await ApiKey.findOne({ orgId, apiKeyId }).lean();
        assert.ok(stored, "the row must survive so 'which key did that' stays answerable");
        assert.ok(stored.revokedAt);

        // But it is gone from the list.
        const listed = await expansionFunctions.listApiKeys({ orgId });
        assert.equal(listed.json.data.length, 0);
    });

    test("revoking twice 404s rather than silently succeeding", async () => {
        const created = await expansionFunctions.createApiKey({ orgId, name: "x", scopes: [ApiScope.ANALYTICS_READ] });
        await expansionFunctions.revokeApiKey({ orgId, apiKeyId: created.json.data.apiKeyId });
        const second = await expansionFunctions.revokeApiKey({ orgId, apiKeyId: created.json.data.apiKeyId });
        assert.equal(second.status, 404);
    });
});

describe("credential store (§5.3)", () => {
    test("the secret is encrypted and never returned", async () => {
        const result = await expansionFunctions.createCredential({
            orgId,
            name: "Shipping API",
            type: CredentialType.BEARER,
            secret: "sk_live_supersecret",
        });

        assert.equal(result.status, 201);
        assert.equal(result.json.data.secret, undefined);

        const stored = await Credential.findOne({ orgId }).lean();
        assert.notEqual(stored.secret, "sk_live_supersecret");
        // Encrypted, not hashed: unlike an API key, this one has to be readable
        // to be sent upstream.
        const generalFunctions = require("../functions/utilFunctions/generalFunctions");
        assert.equal(generalFunctions.decrypt(stored.secret), "sk_live_supersecret");
    });

    test("API_KEY_HEADER requires a header name and BASIC requires a username", async () => {
        const noHeader = await expansionFunctions.createCredential({
            orgId,
            name: "x",
            type: CredentialType.API_KEY_HEADER,
            secret: "k",
        });
        assert.equal(noHeader.status, 400);

        const noUsername = await expansionFunctions.createCredential({
            orgId,
            name: "y",
            type: CredentialType.BASIC,
            secret: "p",
        });
        assert.equal(noUsername.status, 400);
    });

    test("rotating forces every action using it back to untested", async () => {
        // An action calling an API with a key that may not work is exactly what
        // the NEVER_TESTED guard exists to stop.
        const credential = await expansionFunctions.createCredential({
            orgId,
            name: "Rotating",
            type: CredentialType.BEARER,
            secret: "old",
        });
        const credentialId = credential.json.data.credentialId;

        await Action.create({
            orgId,
            actionId: `act_${Date.now()}`,
            name: "Look up order",
            description: "d",
            accessType: AccessType.READ,
            urlTemplate: "https://api.acme.com/orders/{id}",
            credentialId,
            lastTestStatus: "PASS",
        });

        const result = await expansionFunctions.rotateCredential({ orgId, credentialId, secret: "new" });
        assert.equal(result.json.data.actionsRequiringRetest, 1);
        assert.ok(result.json.note);

        const action = await Action.findOne({ orgId, credentialId }).lean();
        assert.equal(action.lastTestStatus, null);
    });

    test("deleting a credential in use is refused with a count", async () => {
        const credential = await expansionFunctions.createCredential({
            orgId,
            name: "In use",
            type: CredentialType.BEARER,
            secret: "s",
        });
        const credentialId = credential.json.data.credentialId;

        await Action.create({
            orgId,
            actionId: `act_del_${Date.now()}`,
            name: "Uses it",
            description: "d",
            accessType: AccessType.READ,
            urlTemplate: "https://x",
            credentialId,
        });

        const result = await expansionFunctions.deleteCredential({ orgId, credentialId });
        assert.equal(result.status, 409);
        assert.match(result.json.error, /1 action/);
    });

    test("the list shows how many actions use each credential", async () => {
        const credential = await expansionFunctions.createCredential({
            orgId,
            name: "Counted",
            type: CredentialType.BEARER,
            secret: "s",
        });
        const listed = await expansionFunctions.listCredentials({ orgId });
        assert.equal(listed.json.data[0].usedByActions, 0);
        assert.equal(listed.json.data[0].credentialId, credential.json.data.credentialId);
    });
});

describe("blocklist (§8.2)", () => {
    test("blocks an exact identity", async () => {
        await expansionFunctions.addBlocklistEntry({ orgId, type: BlocklistType.IDENTITY, value: "Spam@Example.com" });

        // Lowercased on write, so a differently-cased address still matches.
        const blocked = await expansionFunctions.checkBlocked({ orgId, email: "spam@example.com" });
        assert.equal(blocked.blocked, true);

        const clean = await expansionFunctions.checkBlocked({ orgId, email: "real@example.com" });
        assert.equal(clean.blocked, false);
    });

    test("blocks a whole email domain", async () => {
        await expansionFunctions.addBlocklistEntry({ orgId, type: BlocklistType.EMAIL_DOMAIN, value: "spammer.test" });
        const blocked = await expansionFunctions.checkBlocked({ orgId, email: "anyone@spammer.test" });
        assert.equal(blocked.blocked, true);
    });

    test("blocks an IP", async () => {
        await expansionFunctions.addBlocklistEntry({ orgId, type: BlocklistType.IP, value: "203.0.113.5" });
        assert.equal((await expansionFunctions.checkBlocked({ orgId, ip: "203.0.113.5" })).blocked, true);
        assert.equal((await expansionFunctions.checkBlocked({ orgId, ip: "203.0.113.6" })).blocked, false);
    });

    test("an expired entry stops blocking", async () => {
        // A temporary block is often the right answer for one bad afternoon.
        await expansionFunctions.addBlocklistEntry({
            orgId,
            type: BlocklistType.IDENTITY,
            value: "temp@example.com",
            expiresAt: new Date(Date.now() - 1000),
        });
        assert.equal((await expansionFunctions.checkBlocked({ orgId, email: "temp@example.com" })).blocked, false);
    });

    test("a future expiry still blocks", async () => {
        await expansionFunctions.addBlocklistEntry({
            orgId,
            type: BlocklistType.IDENTITY,
            value: "later@example.com",
            expiresAt: new Date(Date.now() + 3600_000),
        });
        assert.equal((await expansionFunctions.checkBlocked({ orgId, email: "later@example.com" })).blocked, true);
    });

    test("a duplicate entry 409s rather than creating a second row", async () => {
        await expansionFunctions.addBlocklistEntry({ orgId, type: BlocklistType.IP, value: "198.51.100.1" });
        const second = await expansionFunctions.addBlocklistEntry({ orgId, type: BlocklistType.IP, value: "198.51.100.1" });
        assert.equal(second.status, 409);
    });

    test("one workspace's blocklist does not affect another's visitors", async () => {
        await expansionFunctions.addBlocklistEntry({ orgId, type: BlocklistType.IDENTITY, value: "shared@example.com" });
        const other = await expansionFunctions.checkBlocked({
            orgId: `${ORG_PREFIX}other_${Date.now()}`,
            email: "shared@example.com",
        });
        assert.equal(other.blocked, false);
    });

    test("no identifiers at all is not blocked", async () => {
        await expansionFunctions.addBlocklistEntry({ orgId, type: BlocklistType.IP, value: "1.2.3.4" });
        assert.equal((await expansionFunctions.checkBlocked({ orgId })).blocked, false);
    });
});

describe("macros (§5.8)", () => {
    test("a shortcut is normalised to a leading slash", async () => {
        const result = await expansionFunctions.createMacro({ orgId, name: "Refund", shortcut: "Refund", body: "Done." });
        assert.equal(result.json.data.shortcut, "/refund");
    });

    test("a duplicate shortcut is refused and names the conflict", async () => {
        await expansionFunctions.createMacro({ orgId, name: "First", shortcut: "/ref", body: "a" });
        const second = await expansionFunctions.createMacro({ orgId, name: "Second", shortcut: "/ref", body: "b" });

        assert.equal(second.status, 409);
        assert.match(second.json.error, /First/);
    });

    test("an empty visibleToRoles means everyone", async () => {
        // Same reading as `channels` on config objects.
        await expansionFunctions.createMacro({ orgId, name: "Open", body: "x", visibleToRoles: [] });
        const listed = await expansionFunctions.listMacros({ orgId, role: "AGENT" });
        assert.equal(listed.json.data.length, 1);
    });

    test("a role-restricted macro is hidden from other roles", async () => {
        await expansionFunctions.createMacro({ orgId, name: "Owner only", body: "x", visibleToRoles: ["OWNER"] });
        const asAgent = await expansionFunctions.listMacros({ orgId, role: "AGENT" });
        assert.equal(asAgent.json.data.length, 0);

        const asOwner = await expansionFunctions.listMacros({ orgId, role: "OWNER" });
        assert.equal(asOwner.json.data.length, 1);
    });

    test("rendering substitutes org and agent variables and counts the use", async () => {
        await Org.create({
            orgId,
            name: "AcmeShip",
            ownerEmail: "o@acme.com",
            publicKey: `pk_${orgId}`,
            widgetSecret: "ws",
            agent: { name: "Zea" },
        });
        const macro = await expansionFunctions.createMacro({
            orgId,
            name: "Signoff",
            body: "Thanks for contacting {org_name}. — {agent_name}",
        });

        const rendered = await expansionFunctions.renderMacro({ orgId, macroId: macro.json.data.macroId });
        assert.match(rendered.json.data.body, /AcmeShip/);
        assert.match(rendered.json.data.body, /Zea/);
        assert.doesNotMatch(rendered.json.data.body, /\{/);

        const stored = await Macro.findOne({ orgId, macroId: macro.json.data.macroId }).lean();
        assert.equal(stored.usageCount, 1);
    });

    test("rendering with no customer name leaves no placeholder behind", async () => {
        // The same collapse the widget welcome does — a reply about to be sent
        // to a customer must never contain "{first_name}".
        const macro = await expansionFunctions.createMacro({ orgId, name: "Greet", body: "Hi {first_name}, thanks!" });
        const rendered = await expansionFunctions.renderMacro({ orgId, macroId: macro.json.data.macroId });
        assert.doesNotMatch(rendered.json.data.body, /\{first_name\}/);
    });
});

describe("teams (§5.7)", () => {
    test("deleting a team clears its assignments rather than orphaning them", async () => {
        // A conversation assigned to a deleted team shows a blank team name and
        // is unfindable in every view.
        const team = await expansionFunctions.createTeam({ orgId, name: "Billing" });
        const teamId = team.json.data.teamId;

        const conversationId = `conv_exp_${Date.now()}`;
        await Conversation.create({ orgId, conversationId, teamId });

        await expansionFunctions.deleteTeam({ orgId, teamId });

        const conversation = await Conversation.findOne({ orgId, conversationId }).lean();
        assert.equal(conversation.teamId, null);
    });

    test("assigning to a person leaves the team alone, and the reverse", async () => {
        // undefined leaves a field; null clears it. Without the distinction,
        // assigning to a person silently unassigns the team.
        const conversationId = `conv_asg_${Date.now()}`;
        await Conversation.create({ orgId, conversationId, teamId: "team_x", assignedTo: null });

        await expansionFunctions.assignConversation({ orgId, conversationId, assignedTo: "agent@acme.com" });

        const conversation = await Conversation.findOne({ orgId, conversationId }).lean();
        assert.equal(conversation.assignedTo, "agent@acme.com");
        assert.equal(conversation.teamId, "team_x");
    });

    test("auto-assign routes by attribute value, first team wins", async () => {
        const billing = await expansionFunctions.createTeam({
            orgId,
            name: "Billing",
            assignmentRules: [{ attributeId: "atr_issue", value: "BILLING" }],
        });
        await expansionFunctions.createTeam({
            orgId,
            name: "Everything else",
            assignmentRules: [{ attributeId: "atr_issue", value: "BILLING" }],
        });

        const conversationId = `conv_auto_${Date.now()}`;
        await Conversation.create({
            orgId,
            conversationId,
            attributes: [{ attributeId: "atr_issue", name: "Issue Type", value: "BILLING" }],
        });

        const result = await expansionFunctions.autoAssign({ orgId });
        assert.equal(result.json.data.assigned, 1);

        const conversation = await Conversation.findOne({ orgId, conversationId }).lean();
        assert.equal(conversation.teamId, billing.json.data.teamId);
    });

    test("auto-assign leaves conversations that match nothing alone", async () => {
        await expansionFunctions.createTeam({
            orgId,
            name: "Billing",
            assignmentRules: [{ attributeId: "atr_issue", value: "BILLING" }],
        });

        const conversationId = `conv_nomatch_${Date.now()}`;
        await Conversation.create({
            orgId,
            conversationId,
            attributes: [{ attributeId: "atr_issue", name: "Issue Type", value: "HOW_TO" }],
        });

        await expansionFunctions.autoAssign({ orgId });
        const conversation = await Conversation.findOne({ orgId, conversationId }).lean();
        assert.equal(conversation.teamId, null);
    });
});
