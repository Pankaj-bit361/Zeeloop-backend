"use strict";
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const mongoose = require("mongoose");
const { Client, StreamableHTTPClientTransport } = require("@modelcontextprotocol/client");
const { BASE_URL, createIsolatedOrg, post, authHeader } = require("./helpers/client");
const scopes = require("../functions/mcp/scopes");
const Conversation = require("../models/conversation/conversation");
const Message = require("../models/conversation/message");
const EndUser = require("../models/user/endUser");
const Subscription = require("../models/billing/subscription");
const Artifact = require("../models/security/mcpArtifact");
const InstallToken = require("../models/security/installToken");
const RateBucket = require("../models/security/rateBucket");
const Action = require("../models/action/action");
const Guidance = require("../models/config/guidanceRule");
const AuditLog = require("../models/org/auditLog");
const evalContext = require("../functions/eval/evalContext");
const evalRunner = require("../functions/eval/evalRunner");
const guidance = require("../functions/config/guidanceFunctions");
const actionFunctions = require("../functions/action/actionFunctions");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
let owner, sibling, free, full, reader, installer, foreign, freeClient, actionServer, actionSite, endpointCalls = 0;
const connections = [], tokens = [];
async function connect(workspace, scope) {
    const created = await post(`/api/org/${workspace.orgId}/mcp/tokens`, { headers: authHeader(workspace.token), body: { name: "Workspace regression", ...(scope ? { scope } : {}) } });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    tokens.push(created.json.data);
    const client = new Client({ name: "workspace-regression", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`), { requestInit: { headers: authHeader(created.json.data.token) } }));
    connections.push(client); return client;
}
async function call(name, args = {}, client = full) {
    const result = await client.callTool({ name: `zealoop_${name}`, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(result.structuredContent.success, true, JSON.stringify(result));
    return result.structuredContent.data;
}
async function fails(name, args, code, client = full) {
    let result;
    try { result = await client.callTool({ name: `zealoop_${name}`, arguments: args }); }
    catch (error) { if (code) throw error; assert.equal(error.code, -32602); return error; }
    assert.equal(result.isError, true, JSON.stringify(result));
    if (code) assert.equal(result.structuredContent?.code, code, JSON.stringify(result));
    return result;
}
before(async () => {
    await mongoose.connect(process.env.TEST_MONGODB_URI);
    actionServer = http.createServer((req, res) => { endpointCalls++; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ order: "Delivered" })); });
    await new Promise(resolve => actionServer.listen(0, "127.0.0.1", resolve));
    actionSite = `http://127.0.0.1:${actionServer.address().port}`;
    owner = await createIsolatedOrg("mcp-workspace"); sibling = await createIsolatedOrg("mcp-workspace-foreign"); free = await createIsolatedOrg("mcp-workspace-free");
    for (const org of [owner, sibling]) await Subscription.updateOne({ orgId: org.orgId }, { $set: { plan: "GROWTH", status: "ACTIVE" } });
    await Subscription.updateOne({ orgId: free.orgId }, { $set: { plan: "FREE", status: "ACTIVE" } });
    full = await connect(owner, scopes.WORKSPACE); reader = await connect(owner, `${scopes.INSTALL} ${scopes.READ}`);
    installer = await connect(owner); foreign = await connect(sibling, scopes.WORKSPACE); freeClient = await connect(free, scopes.WORKSPACE);
});
beforeEach(async () => {
    await RateBucket.deleteMany({ key: { $in: [...["127.0.0.1", "::ffff:127.0.0.1", "::1"].map(ip => hash(`mcp:ip:${ip}`)), ...tokens.map(row => hash(`mcp:token:${row.tokenId}`))] } });
});
after(async () => { await Promise.all(connections.map(client => client.close())); actionServer.closeAllConnections(); await new Promise(resolve => actionServer.close(resolve)); await mongoose.disconnect(); });

test("legacy, read and write credentials expose distinct tools without upgrading legacy DB rows", async () => {
    assert.equal((await full.listTools()).tools.length, 38);
    const readNames = (await reader.listTools()).tools.map(item => item.name);
    assert.ok(readNames.includes("zealoop_get_workspace_status")); assert.ok(!readNames.includes("zealoop_create_config"));
    assert.equal((await installer.listTools()).tools.length, 3);
    await fails("create_config", { resource: "guidance", data: { category: "OTHER", title: "Forbidden", body: "No" } }, undefined, reader);
    await fails("get_workspace_status", {}, undefined, installer);
    const original = tokens[2]; await InstallToken.collection.updateOne({ tokenId: original.tokenId }, { $unset: { scope: 1 } });
    assert.equal((await installer.listTools()).tools.length, 3);
});
test("scope input rejects invalid or empty grants and canonicalizes duplicates", async () => {
    for (const scope of ["", "billing:write", [scopes.WRITE], 42, "zealoop:read unknown"]) {
        const result = await post(`/api/org/${owner.orgId}/mcp/tokens`, { headers: authHeader(owner.token), body: { name: "Invalid grant", scope } });
        assert.equal(result.status, 400);
    }
    assert.equal(scopes.normalizeScope("zealoop:write zealoop:read zealoop:read"), "zealoop:read zealoop:write");
    assert.equal(scopes.isSubset(scopes.READ, scopes.WRITE), true);
    assert.equal(scopes.hasScope(scopes.WRITE, scopes.READ), true); assert.equal(scopes.hasScope(scopes.READ, scopes.WRITE), false);
});
test("status and schema discovery report actual granted operations without secrets", async () => {
    const status = await call("get_workspace_status"); assert.equal(status.workspace.orgId, owner.orgId); assert.equal(status.plan.id, "GROWTH");
    assert.equal(status.scope, scopes.WORKSPACE); assert.ok(status.counts.attributes > 0);
    assert.ok(!JSON.stringify(status).includes("widgetSecret"));
    const index = await call("get_api_reference"); assert.equal(index.operations.length, 38);
    assert.ok(index.operations.some(row => row.name === "zealoop_get_install_config"));
    const reference = await call("get_api_reference", { group: "configuration", indexOnly: false, operations: ["zealoop_create_config"] });
    assert.equal(reference.operations[0].scope, scopes.WRITE); assert.ok(reference.operations[0].inputSchema);
    await fails("get_api_reference", { operations: ["zealoop_create_config"] }, undefined, reader);
});
test("tools reject workspace overrides, invalid resource names and unbounded payloads", async () => {
    await fails("get_workspace_status", { orgId: sibling.orgId });
    await fails("list_resources", { resource: "accounts" });
    await fails("list_resources", { resource: "chunks" });
    await fails("list_resources", { resource: "knowledge", limit: 51 });
    await fails("create_knowledge_source", { type: "SNIPPET", name: "Too long", content: "x".repeat(48001) });
});
test("knowledge create, chunk detail, resync and edits use the real indexing service and plan limits", async () => {
    const source = await call("create_knowledge_source", { type: "SNIPPET", name: "Refund policy", content: "Customers can return unused items within thirty days." });
    assert.ok(source.sourceId); assert.equal(await Artifact.countDocuments({ orgId: owner.orgId, kind: "knowledge", resourceId: source.sourceId }), 1);
    const chunks = await call("list_resources", { resource: "chunks", parentId: source.sourceId }); assert.ok(chunks.total > 0);
    const chunk = await call("get_resource", { resource: "chunks", resourceId: chunks.items[0].chunkId }); assert.equal(chunk.embedding, undefined);
    await fails("get_resource", { resource: "knowledge", resourceId: source.sourceId }, "not_found", foreign);
    assert.equal((await call("update_knowledge_source", { sourceId: source.sourceId, content: "Refunds take five business days." })).applied, false);
    await call("update_knowledge_source", { sourceId: source.sourceId, content: "Refunds take five business days.", confirm: true });
    assert.equal((await call("resync_knowledge_source", { sourceId: source.sourceId })).applied, false);
    await call("resync_knowledge_source", { sourceId: source.sourceId, confirm: true });
    for (let i = 0; i < 3; i++) await call("create_knowledge_source", { type: "SNIPPET", name: `Free ${i}`, content: "Useful content" }, freeClient);
    await fails("create_knowledge_source", { type: "SNIPPET", name: "Over capacity", content: "Useful content" }, undefined, freeClient);
});
test("all config types stay draft in a solo workspace and publication, versions and restore are explicit", async () => {
    const definitions = {
        guidance: { category: "OTHER", title: "MCP guidance", body: "Be precise and cite sources." },
        escalation_rules: { title: "Long conversation", conditions: [{ field: "TURN_COUNT", operator: "GREATER_THAN", value: 8 }], target: { mode: "INBOX" } },
        escalation_guidance: { title: "Legal issues", body: "Ask a human to review legal requests." },
        attributes: { name: "MCP urgency", values: [{ name: "Urgent" }, { name: "Routine" }] },
    };
    for (const [resource, data] of Object.entries(definitions)) {
        const row = await call("create_config", { resource, data }); assert.equal(row.publishState, "DRAFT"); assert.equal(row.enabled, false);
    }
    const listed = await call("list_resources", { resource: "guidance", limit: 1 }); const id = listed.items[0].guidanceRuleId;
    assert.equal((await call("publish_config", { resource: "guidance", resourceId: id })).applied, false);
    assert.equal((await Guidance.findOne({ orgId: owner.orgId, guidanceRuleId: id }).lean()).publishState, "DRAFT");
    await call("publish_config", { resource: "guidance", resourceId: id, confirm: true });
    assert.equal((await call("update_config", { resource: "guidance", resourceId: id, data: { body: "Updated draft" } })).applied, false);
    await call("update_config", { resource: "guidance", resourceId: id, data: { body: "Updated draft" }, confirm: true });
    const edited = await call("get_resource", { resource: "guidance", resourceId: id }); assert.equal(edited.publishState, "DRAFT"); assert.equal(edited.enabled, false);
    const versions = await call("get_config_versions", { resource: "guidance", resourceId: id }); assert.ok(versions.length > 0);
    assert.equal((await call("restore_config_version", { resource: "guidance", resourceId: id, version: versions[0].version })).applied, false);
    await call("restore_config_version", { resource: "guidance", resourceId: id, version: versions[0].version, confirm: true });
    await call("publish_config", { resource: "guidance", resourceId: id, confirm: true });
    await call("unpublish_config", { resource: "guidance", resourceId: id, confirm: true });
});
test("agent and widget edits preview before applying and refuse identity/security overrides", async () => {
    const original = await call("get_agent_config");
    assert.equal((await call("update_agent_config", { agent: { name: "MCP Support" } })).applied, false);
    assert.deepEqual(await call("get_agent_config"), original);
    await call("update_agent_config", { agent: { name: "MCP Support", formality: "friendly" }, businessContext: { productOneLiner: "A helpful support product" }, confirm: true });
    const actual = await call("get_agent_config"); assert.equal(actual.agent.name, "MCP Support");
    assert.equal((await call("update_widget_config", { widget: { accentColor: "#345678" } })).applied, false);
    await call("update_widget_config", { widget: { accentColor: "#345678" }, confirm: true });
    assert.equal((await call("get_widget_config")).widget.accentColor, "#345678");
    await fails("update_widget_config", { widget: { allowedOrigins: ["*"] }, confirm: true });
    await fails("update_agent_config", { agent: { widgetSecret: "attacker" }, confirm: true });
});
test("segments and procedures support drafting, review and pause-before-edit", async () => {
    const segment = await call("create_segment", { name: "Verified visitors", conditions: [{ field: "IDENTITY_VERIFIED", operator: "EQUALS", value: true }] });
    assert.equal((await call("update_segment", { segmentId: segment.segmentId, name: "Verified customers" })).applied, false);
    await call("update_segment", { segmentId: segment.segmentId, name: "Verified customers", confirm: true });
    const procedure = await call("create_procedure", { name: "Return instructions", triggerType: "KEYWORD", keywords: ["return"], steps: ["Ask when the customer bought the item.", "Explain the return policy."] });
    assert.equal(procedure.enabled, false);
    await call("update_procedure", { procedureId: procedure.procedureId, data: { description: "Reviewed steps" } });
    assert.equal((await call("set_resource_enabled", { resource: "procedures", resourceId: procedure.procedureId, enabled: true })).applied, false);
    await call("set_resource_enabled", { resource: "procedures", resourceId: procedure.procedureId, enabled: true, confirm: true });
    await fails("update_procedure", { procedureId: procedure.procedureId, data: { name: "Unreviewed edit" } }, "resource_active");
    await call("set_resource_enabled", { resource: "procedures", resourceId: procedure.procedureId, enabled: false, confirm: true });
});
test("actions stay disabled, retain write confirmation, redact headers and refuse untested/mock activation", async () => {
    const action = await call("create_action", { name: "Order lookup", description: "Fetch order status", accessType: "WRITE", method: "POST", urlTemplate: "https://api.example.com/orders/:id", params: [{ name: "id", required: true }], requiresConfirmation: false });
    assert.equal(action.enabled, false); assert.equal(action.requiresConfirmation, true);
    await Action.updateOne({ orgId: owner.orgId, actionId: action.actionId }, { $set: { headers: { Authorization: "Bearer hidden-fixture-value" } } });
    const detail = await call("get_resource", { resource: "actions", resourceId: action.actionId }); assert.equal(detail.headers, undefined); assert.ok(!JSON.stringify(detail).includes("hidden-fixture-value"));
    const preview = await call("preview_action", { actionId: action.actionId }); assert.equal(preview.executed, false); assert.deepEqual(preview.missingParams, ["id"]);
    await call("update_action", { actionId: action.actionId, data: { description: "Reviewed write action", requiresConfirmation: false } });
    await fails("set_resource_enabled", { resource: "actions", resourceId: action.actionId, enabled: true, confirm: true }, "action_untested");
    await Action.updateOne({ orgId: owner.orgId, actionId: action.actionId }, { $set: { lastTestStatus: "PASS", lastTestMocked: true, mockEnabled: true, mockResponse: { statusCode: 200, body: { ok: true } } } });
    await fails("set_resource_enabled", { resource: "actions", resourceId: action.actionId, enabled: true, confirm: true }, "action_untested");
    await Action.updateOne({ orgId: owner.orgId, actionId: action.actionId }, { $set: { mockEnabled: false } });
    await fails("set_resource_enabled", { resource: "actions", resourceId: action.actionId, enabled: true, confirm: true }, "action_untested");
    await Action.updateOne({ orgId: owner.orgId, actionId: action.actionId }, { $set: { lastTestMocked: false } });
    const active = await call("set_resource_enabled", { resource: "actions", resourceId: action.actionId, enabled: true, confirm: true }); assert.equal(active.publishState, "LIVE"); assert.equal(active.enabled, true);
    await fails("update_action", { actionId: action.actionId, data: { name: "Dangerous edit" } }, "resource_active");
    await call("set_resource_enabled", { resource: "actions", resourceId: action.actionId, enabled: false, confirm: true });
    await call("cleanup_created_resources", { resources: [{ kind: "actions", resourceId: action.actionId }], confirm: true });
    assert.equal(await Action.countDocuments({ orgId: owner.orgId, actionId: action.actionId }), 0);
    await fails("create_action", { name: "Free action", description: "Restricted", accessType: "READ", method: "GET", urlTemplate: "https://api.example.com/status" }, undefined, freeClient);
});
test("typed tables enforce identity uniqueness, confirm live edits and preserve plan restrictions", async () => {
    const table = await call("create_table", { name: "Orders", columns: [{ name: "email", type: "string", isIdentityKey: true }, { name: "status", type: "string", isIdentityKey: false }] });
    const row = await call("create_table_row", { tableId: table.tableId, data: { email: "customer@example.com", status: "Shipped" } });
    await fails("create_table_row", { tableId: table.tableId, data: { email: "customer@example.com", status: "Duplicate" } });
    assert.equal((await call("update_table_row", { tableId: table.tableId, rowId: row.rowId, data: { status: "Delivered" } })).applied, false);
    await call("update_table_row", { tableId: table.tableId, rowId: row.rowId, data: { status: "Delivered" }, confirm: true });
    const list = await call("list_resources", { resource: "table_rows", parentId: table.tableId }); assert.equal(list.items[0].data.status, "Delivered");
    await fails("update_table_row", { tableId: table.tableId, rowId: row.rowId, data: { status: "Other tenant" }, confirm: true }, undefined, foreign);
    await fails("create_table", { name: "Free restricted table", columns: [{ name: "email", type: "string", isIdentityKey: true }] }, undefined, freeClient);
});
test("conversations and all analytics reports are accessible without customer sends or billing mutations", async () => {
    await call("search_conversations", { search: "unknown-customer" });
    for (const report of ["overview", "quality", "content_gaps"]) await call("get_analytics", { report, days: 7 });
    const names = (await full.listTools()).tools.map(item => item.name); assert.ok(!names.includes("zealoop_send_reply")); assert.ok(!names.includes("zealoop_change_plan"));
});
test("MCP runs real batch tests and multi-turn simulations without exposing drafts to concurrent live reads", async () => {
    const suite = await call("create_batch_test", { name: "Returns regression", questions: [{ text: "What is your refund policy?", expectedAnswer: "Thirty days" }] });
    const evaluation = await call("run_batch_test", { batchTestId: suite.batchTestId, target: "DRAFT" }); assert.ok(evaluation.run); assert.match(evaluation.note, /isolated context/);
    const scenario = await call("create_simulation", { name: "Returns conversation", persona: { openingMessage: "How can I return my order?", details: "A customer with an unused item" }, criteria: ["Respond helpfully"] });
    const run = await call("run_simulation", { simulationId: scenario.simulationId, target: "DRAFT" }); assert.ok(run);
    const draft = await Guidance.create({ orgId: owner.orgId, guidanceRuleId: "gr_mcp_isolated", category: "OTHER", title: "Secret draft", body: "draft-only-sentinel", publishState: "DRAFT", enabled: false });
    let entered, release; const started = new Promise(resolve => { entered = resolve; }); const hold = new Promise(resolve => { release = resolve; });
    const evaluating = evalRunner.withTarget({ orgId: owner.orgId, target: "DRAFT", run: async () => {
        entered(); await hold; return guidance.loadForTurn({ orgId: owner.orgId, context: {}, channel: "CHAT" });
    } });
    await started;
    const live = await guidance.loadForTurn({ orgId: owner.orgId, context: {}, channel: "CHAT" }); assert.ok(!live.appliedRuleIds.includes(draft.guidanceRuleId));
    const during = await Guidance.findOne({ guidanceRuleId: draft.guidanceRuleId }).lean(); assert.equal(during.publishState, "DRAFT"); assert.equal(during.enabled, false);
    release(); const tested = await evaluating; assert.ok(tested.appliedRuleIds.includes(draft.guidanceRuleId));
    await assert.rejects(evalRunner.withTarget({ orgId: owner.orgId, target: "DRAFT", run: () => { throw new Error("Interrupted evaluation"); } }));
    assert.equal(evalContext.configFilter(owner.orgId).publishState, "LIVE");
});
test("evaluation action guard stops a real outbound call and allows configured mocks only in scoped context", async () => {
    const action = { orgId: owner.orgId, kind: "REST", urlTemplate: "https://should-never-be-called.invalid", method: "POST", headers: {}, mockEnabled: false };
    const result = await evalContext.run({ orgId: owner.orgId, blockExternalActions: true }, () => evalRunner.withTarget({ orgId: owner.orgId, target: "DRAFT", run: () => actionFunctions._callEndpoint({ action, args: {} }) }));
    assert.equal(result.success, false); assert.match(result.error, /disabled during MCP evaluation/);
    const mocked = await evalContext.run({ orgId: owner.orgId, blockExternalActions: true }, () => actionFunctions._callEndpoint({ action: { ...action, mockEnabled: true, mockResponse: { mocked: true } }, args: {} }));
    assert.equal(mocked.success, true); assert.deepEqual(mocked.body, { mocked: true });
    assert.equal(evalContext.blocksExternalActions(owner.orgId), false);
    await evalContext.run({ orgId: owner.orgId, blockExternalActions: true }, async () => { assert.equal(evalContext.blocksExternalActions(sibling.orgId), false); });
});
test("cleanup previews owned resources, rejects human/foreign ownership and reports active-resource failures", async () => {
    const created = await call("create_config", { resource: "guidance", data: { category: "OTHER", title: "Cleanup draft", body: "Disposable guidance" } });
    const pair = { kind: "guidance", resourceId: created.guidanceRuleId };
    assert.equal((await call("cleanup_created_resources", { resources: [pair] })).applied, false);
    assert.ok(await Guidance.exists({ orgId: owner.orgId, guidanceRuleId: pair.resourceId }));
    await fails("cleanup_created_resources", { resources: [pair], confirm: true }, "not_mcp_owned", foreign);
    await fails("cleanup_created_resources", { resources: [{ kind: "guidance", resourceId: "gr_mcp_isolated" }], confirm: true }, "not_mcp_owned");
    await call("publish_config", { resource: "guidance", resourceId: pair.resourceId, confirm: true });
    await fails("cleanup_created_resources", { resources: [pair], confirm: true }, "partial_cleanup");
    await call("unpublish_config", { resource: "guidance", resourceId: pair.resourceId, confirm: true });
    const removed = await call("cleanup_created_resources", { resources: [pair], confirm: true }); assert.equal(removed.results[0].success, true);
    assert.equal(await Guidance.countDocuments({ guidanceRuleId: pair.resourceId }), 0); assert.equal(await Artifact.countDocuments({ orgId: owner.orgId, resourceId: pair.resourceId }), 0);
    const logs = await AuditLog.find({ orgId: owner.orgId, action: "MCP_TOOL_EXECUTED" }).lean(); assert.ok(logs.length > 0);
    assert.ok(!JSON.stringify(logs).includes(tokens[0].token));
});

test("a real dashboard endpoint test records provenance and activation rejects a concurrently edited definition", async () => {
    const action = await call("create_action", { name: "Real test proof", description: "Read order status", accessType: "READ", method: "GET", urlTemplate: `${actionSite}/orders/{id}`, params: [{ name: "id", required: true }] });
    const beforeCalls = endpointCalls;
    const tested = await post(`/api/org/${owner.orgId}/actions/${action.actionId}/test`, { headers: authHeader(owner.token), body: { args: { id: "123" } } });
    assert.equal(tested.status, 200); assert.equal(tested.json.data.lastTestStatus, "PASS"); assert.equal(endpointCalls, beforeCalls + 1);
    const snapshot = await Action.findOne({ orgId: owner.orgId, actionId: action.actionId }).lean(); assert.equal(snapshot.lastTestMocked, false);
    await Action.updateOne({ orgId: owner.orgId, actionId: action.actionId }, { $set: { description: "A concurrent dashboard edit", updatedAt: new Date(snapshot.updatedAt.getTime() + 1000) } });
    const raced = await actionFunctions.updateAction({ orgId: owner.orgId, actionId: action.actionId, enabled: true, mcpActivation: true, expectedUpdatedAt: snapshot.updatedAt });
    assert.equal(raced.status, 409); assert.equal((await Action.findOne({ actionId: action.actionId }).lean()).enabled, false);
    await call("set_resource_enabled", { resource: "actions", resourceId: action.actionId, enabled: true, confirm: true });
    assert.equal(endpointCalls, beforeCalls + 1, "activation never calls the external endpoint");
});
test("private customer profiles and transcripts are visible only to workspace scopes in their own organization", async () => {
    const customer = await EndUser.create({ orgId: owner.orgId, endUserId: "eu_mcp_private", email: "private-reader@example.com", name: "Private Reader" });
    const conversation = await Conversation.create({ orgId: owner.orgId, conversationId: "conv_mcp_private", endUserId: customer.endUserId, status: "OPEN", lastMessage: "Private delivery question" });
    await Message.create({ orgId: owner.orgId, conversationId: conversation.conversationId, messageId: "msg_mcp_private", role: "USER", content: "Private delivery question" });
    const result = await call("get_resource", { resource: "conversations", resourceId: conversation.conversationId }, reader);
    assert.equal(result.messages[0].content, "Private delivery question"); assert.equal(result.endUser.email, customer.email);
    const results = await call("search_conversations", { search: customer.email, limit: 1 }, reader); assert.equal(results[0].conversationId, conversation.conversationId);
    const profile = await call("get_resource", { resource: "users", resourceId: customer.endUserId }, reader); assert.equal(profile.email, customer.email);
    await fails("get_resource", { resource: "conversations", resourceId: conversation.conversationId }, undefined, foreign);
    await fails("get_resource", { resource: "users", resourceId: customer.endUserId }, "not_found", foreign);
    await fails("get_resource", { resource: "conversations", resourceId: conversation.conversationId }, undefined, installer);
});
test("cleanup deletion guards also hold when a draft was published after the ownership preview", async () => {
    const configFunctions = require("../functions/config/configFunctions");
    const row = await call("create_config", { resource: "guidance", data: { category: "OTHER", title: "Concurrent publication", body: "Keep me" } });
    await Guidance.updateOne({ guidanceRuleId: row.guidanceRuleId }, { $set: { publishState: "LIVE", enabled: true } });
    const result = await configFunctions.remove({ orgId: owner.orgId, objectType: "GUIDANCE_RULE", objectId: row.guidanceRuleId, actorEmail: owner.email, draftOnly: true });
    assert.equal(result.status, 409); assert.ok(await Guidance.exists({ guidanceRuleId: row.guidanceRuleId }));
});
