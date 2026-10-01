"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const config = require("../config/config");
const Chunk = require("../models/knowledge/chunk");
const KnowledgeSource = require("../models/knowledge/knowledgeSource");
const Org = require("../models/org/org");
const { post } = require("./helpers/client");
const search = require("../functions/knowledge/searchFunctions");
const agent = require("../functions/agent/agentFunctions");
const articles = require("../functions/widget/articleFunctions");
const llm = require("../functions/utilFunctions/llmFunctions");
const guidance = require("../functions/config/guidanceFunctions");
const { ensureSearchIndexes, searchIndexDefinitions } = require("../config/searchIndexes");

const orgId = "org_search_regression";
const otherOrgId = "org_search_regression_other";
const sourceId = "src_search_ready";
const ready = { orgId, sourceId, name: "Choosing an SEO tool", type: "SNIPPET", status: "READY" };
const decision = { orgId, sourceId, chunkId: "search_late_answer", position: 0, documentKey: "decision",
    headingPath: ["SEO tools", "Which tool should you choose?"],
    text: "Choose an SEO tool by the missing step. For research, trial Ahrefs. For content workflows, test Seovyn. Compare one real article before buying." };
const aggregate = Chunk.aggregate.bind(Chunk);

before(async () => {
    assert.ok(process.env.TEST_MONGODB_URI, "Run with scripts/runTests.js; never connect these tests to production");
    await mongoose.connect(process.env.TEST_MONGODB_URI, { serverSelectionTimeoutMS: 3000 });
    await Org.create({ orgId, name: "Search regression", ownerEmail: "owner@search.test", publicKey: "pk_search_regression", widgetSecret: "isolated-test-fixture" });
    await KnowledgeSource.create(ready);
    // Insert the relevant document after the old unsorted 200-row cutoff.
    await Chunk.insertMany(Array.from({ length: 240 }, (_, i) => ({
        orgId, sourceId, chunkId: `search_decoy_${i}`, position: i, documentKey: "decoys",
        headingPath: ["General documentation"], text: "SEO tools can help a team publish content. This paragraph has no decision criteria.",
    })));
    await Chunk.insertMany([
        decision,
        { orgId, sourceId: "src_search_refund", chunkId: "search_refund", position: 0, headingPath: ["Billing", "Refund policy"], text: "Eligible purchases can be returned within 14 days." },
        { orgId, sourceId, chunkId: "search_ai", position: 0, headingPath: ["AI visibility"], text: "Track brand citations in generated answers." },
        { orgId, sourceId, chunkId: "search_hindi", position: 0, headingPath: ["भुगतान नीति"], text: "विवरण खाते में उपलब्ध हैं।" },
        { orgId, sourceId, chunkId: "search_invoice", position: 0, headingPath: [], text: "Download an invoice from the billing page." },
        { orgId, sourceId, chunkId: "search_substring", position: 0, headingPath: [], text: "A paid subscription on this planet." },
        { orgId, sourceId, chunkId: "search_content_plan", position: 0, headingPath: ["Research", "A defensible content plan"], text: "Build a content plan around customer questions, mapped intent and source evidence." },
        { orgId, sourceId, chunkId: "search_content_terms", position: 0, headingPath: ["Terms", "Your content and what we create"], text: "You own your content. You can cancel paid plans at any time." },
        { ...decision, orgId: otherOrgId, sourceId: "src_search_other", chunkId: "search_other" },
    ]);
    await KnowledgeSource.create({ ...ready, sourceId: "src_search_refund", name: "Refund policy" });
});

after(async () => {
    await Chunk.deleteMany({ orgId: { $in: [orgId, otherOrgId] } });
    await KnowledgeSource.deleteMany({ orgId: { $in: [orgId, otherOrgId] } });
    await Org.deleteMany({ orgId });
    await mongoose.disconnect();
});

function unavailableAtlas(t, empty = false) {
    t.mock.method(Chunk, "aggregate", (pipeline) => {
        if (pipeline[0].$search || pipeline[0].$vectorSearch) {
            if (empty) return aggregate([{ $match: { chunkId: "__unavailable_search_index__" } }]);
            return { option() { return Promise.reject(new Error("Atlas index unavailable")); } };
        }
        return aggregate(pipeline);
    });
    t.mock.method(llm, "embed", async () => [[1, 0]]);
}

test("keyword ranking finds the relevant answer beyond 200 early matches", async () => {
    const hits = await search.keywordSearch({ orgId, query: "Which SEO tool should I choose?" });
    assert.equal(hits[0].chunkId, decision.chunkId);
    assert.ok(hits.length <= config.RETRIEVAL_CANDIDATES);
    assert.ok(!hits.some((hit) => hit.chunkId === "search_other"));
});

test("heading-only content and plural query terms are searchable", async () => {
    for (const query of ["refund policy", "refund policies", "refunds policy"]) {
        const hits = await search.keywordSearch({ orgId, query });
        assert.equal(hits[0].chunkId, "search_refund", query);
    }
});

test("AI and Unicode terms survive tokenization without substring false positives", async () => {
    assert.deepEqual((await search.keywordSearch({ orgId, query: "AI" })).map((h) => h.chunkId), ["search_ai"]);
    assert.deepEqual((await search.keywordSearch({ orgId, query: "भुगतान" })).map((h) => h.chunkId), ["search_hindi"]);
    const plans = await search.keywordSearch({ orgId, query: "plan" });
    assert.ok(!plans.some((hit) => hit.chunkId === "search_substring"), "plan must not match planet");
});

test("meaningful words after the eighth query term are retained", async () => {
    const hits = await search.keywordSearch({ orgId, query: "alpha beta gamma delta epsilon zeta theta lambda omega kappa invoice" });
    assert.equal(hits[0].chunkId, "search_invoice");
});

test("phrase relevance beats unrelated content and subscription-plan matches", async () => {
    const hits = await search.keywordSearch({ orgId, query: "How do I create a content plan?" });
    assert.equal(hits[0].chunkId, "search_content_plan");
});

test("empty, stopword-only and regex punctuation queries do not match everything", async () => {
    for (const query of ["", "how can you?", ".* [^] $ +"]) {
        assert.deepEqual(await search.keywordSearch({ orgId, query }), []);
    }
    assert.deepEqual(await search.keywordSearch({ orgId, query: "unknown_zxq" }), []);
});

for (const empty of [false, true]) {
    test(`hybrid retrieval falls back when Atlas ${empty ? "returns no rows" : "throws"}`, async (t) => {
        unavailableAtlas(t, empty);
        const hits = await search.hybridSearch({ orgId, query: "refund policy" });
        assert.equal(hits[0].chunkId, "search_refund");
    });
}

test("embedding failure still searches text", async (t) => {
    unavailableAtlas(t, true);
    t.mock.method(llm, "embed", async () => { throw new Error("provider offline"); });
    const hits = await search.hybridSearch({ orgId, query: "refund policy" });
    assert.equal(hits[0].chunkId, "search_refund");
});

test("text search starts before a slow embedding finishes", async () => {
    let finish;
    let textStarted = false;
    const queryEmbeddingPromise = new Promise((resolve) => { finish = resolve; });
    const result = search.hybridSearch({ orgId, query: "refund", queryEmbeddingPromise,
        textSearch: async () => { textStarted = true; return [{ chunkId: "text", textScore: 1 }]; },
        vectorSearch: async () => [],
    });
    assert.equal(textStarted, true);
    finish([[1, 0]]);
    assert.equal((await result)[0].chunkId, "text");
});

test("raw keywords survive a noisy rewrite and duplicate hits fuse once per list", async () => {
    const queries = [];
    const hits = await search.hybridSearch({ orgId, query: "ChatGPT research", rawQuery: "SEO tools",
        queryEmbeddingPromise: Promise.resolve([[1, 0]]), vectorSearch: async () => [],
        textSearch: async ({ query }) => {
            queries.push(query);
            return query === "SEO tools" ? [decision, decision] : [{ chunkId: "irrelevant", text: "research" }];
        },
    });
    assert.deepEqual(queries, ["ChatGPT research", "SEO tools"]);
    assert.equal(hits.filter((hit) => hit.chunkId === decision.chunkId).length, 1);
    assert.equal(hits.find((hit) => hit.chunkId === decision.chunkId).fusionScore, 1 / (config.FUSION_K + 1));
});

test("Atlas candidates are filtered to the exact tenant before limit and projection", async (t) => {
    // Execute all post-search Mongo stages against real mixed-tenant rows,
    // simulating an upstream index that supplied the wrong tenant as well.
    t.mock.method(Chunk, "aggregate", (pipeline) => {
        if (!pipeline[0].$search) return aggregate(pipeline);
        assert.deepEqual(pipeline[0].$search.compound.filter, [{ equals: { value: orgId, path: "orgId" } }]);
        return aggregate([
            { $match: { chunkId: { $in: ["search_other", decision.chunkId] } } },
            ...pipeline.slice(1).map((stage) => stage.$project
                ? { $project: { ...stage.$project, textScore: { $literal: 1 } } } : stage),
        ]);
    });
    const hits = await search.textSearch({ orgId, query: "SEO tools" });
    assert.deepEqual(hits.map((h) => h.chunkId), [decision.chunkId]);
});

test("Help search finds reordered multiword headings through the same empty-index fallback", async (t) => {
    unavailableAtlas(t, true);
    const result = await articles._hybridArticleSearch({ orgId, query: "policy for refunds", limit: 3 });
    assert.equal(result[0].sourceId, "src_search_refund");
    assert.equal(result[0].title, "Refund policy");
    assert.ok(result[0].snippet.includes("14 days"));
});

test("the widget's actual public Help endpoint ranks reordered words and headings", async () => {
    const result = await post("/api/widget/help", { body: { publicKey: "pk_search_regression", query: "policy for refunds" } });
    assert.equal(result.status, 200);
    assert.equal(result.json.data.hits[0].chunkId, "search_refund");
    assert.equal(result.json.data.hits[0].source, "Refund policy");
    assert.ok(!result.json.data.hits.some((hit) => hit.chunkId === "search_other"));
});

test("unpublished high-ranking chunks cannot crowd published Help results out of the candidate limit", async (t) => {
    const unpublished = "src_search_unpublished_many";
    await KnowledgeSource.create({ ...ready, sourceId: unpublished, status: "PENDING" });
    await Chunk.insertMany(Array.from({ length: 50 }, (_, i) => ({ orgId, sourceId: unpublished,
        chunkId: `search_unpublished_${i}`, position: i, headingPath: ["Refund policy"], text: "Refund policy refund policy",
    })));
    t.after(async () => {
        await Chunk.deleteMany({ orgId, sourceId: unpublished });
        await KnowledgeSource.deleteMany({ orgId, sourceId: unpublished });
    });
    const result = await post("/api/widget/help", { body: { publicKey: "pk_search_regression", query: "refund policy" } });
    assert.deepEqual(result.json.data.hits.map((hit) => hit.chunkId), ["search_refund"]);
    unavailableAtlas(t, true);
    const alternate = await articles._hybridArticleSearch({ orgId, query: "refund policy", limit: 2 });
    assert.deepEqual(alternate.map((hit) => hit.sourceId), ["src_search_refund"]);
});

test("unpublished sources do not consume the requested article result slots", async (t) => {
    t.mock.method(search, "hybridSearch", async () => [
        { ...decision, sourceId: "src_search_unpublished" },
        { ...decision, sourceId: "src_search_refund" },
        decision, decision,
    ]);
    const result = await articles._hybridArticleSearch({ orgId, query: "SEO refund", limit: 2 });
    assert.deepEqual(result.map((r) => r.sourceId), ["src_search_refund", sourceId]);
});

function modelEnvironment(t, { human = false, invalid = false } = {}) {
    unavailableAtlas(t, true);
    t.mock.method(llm, "rerank", async () => { throw new Error("Optional reranker unavailable"); });
    let generated = false;
    t.mock.method(llm, "completeJson", async ({ system }) => {
        let json;
        if (system.includes("message classifier")) json = { intent: human ? "HUMAN_REQUEST" : "QUESTION", safe: true, sentiment: "NEUTRAL", language: "en" };
        else if (system.includes("strict validator")) json = { grounded: !invalid, answersQuery: !invalid, unsupportedClaims: [] };
        else {
            generated = true;
            assert.ok(system.includes("For research, trial Ahrefs"), "retrieval must supply real supporting evidence to generation");
            json = { type: "answer", text: "Choose by the missing step: trial Ahrefs for research or Seovyn for content workflows.", citationChunkIds: [decision.chunkId] };
        }
        return { json, inputTokens: 1, outputTokens: 1 };
    });
    t.mock.method(guidance, "loadForTurn", async () => ({ appliedRuleIds: [], segmentIds: [], escalation: { triggered: false } }));
    t.mock.method(guidance, "composeIdentityAndContext", () => ({ prompt: "", maxTokens: 512 }));
    t.mock.method(agent, "_writeTrace", async () => {});
    return () => generated;
}

async function turn(rawMessage) {
    return agent.runTurn({ org: { orgId, name: "Search regression", agent: { name: "Zea" } },
        conversation: { conversationId: "conv_search_test", turnCount: 0, attributes: [] },
        endUser: null, identityVerified: false, rawMessage, history: [],
    });
}

test("answerable support question reaches grounded answer with both indexes and reranker offline", async (t) => {
    modelEnvironment(t);
    const result = await turn("Which SEO tool should I choose?");
    assert.equal(result.outcome, "ANSWERED");
    assert.ok(result.reply.includes("Ahrefs"));
    assert.ok(result.citations.some((citation) => citation.chunkId === decision.chunkId));
});

test("unknown questions still abstain instead of inventing an answer", async (t) => {
    const generated = modelEnvironment(t);
    const result = await turn("zxqv nonexistentconcept");
    assert.equal(result.outcome, "ABSTAINED");
    assert.equal(generated(), false);
});

test("unsupported answers still fail the unchanged validator", async (t) => {
    modelEnvironment(t, { invalid: true });
    const result = await turn("Which SEO tool should I choose?");
    assert.equal(result.outcome, "ABSTAINED");
});

test("explicit requests for a human still escalate", async (t) => {
    const generated = modelEnvironment(t, { human: true });
    const result = await turn("Talk to a human");
    assert.equal(result.outcome, "ESCALATED");
    assert.equal(generated(), false);
});

test("search index bootstrap creates only missing definitions and is idempotent", async () => {
    const definitions = searchIndexDefinitions();
    const existing = [{ name: definitions[0].name }];
    const created = [];
    const collection = {
        listSearchIndexes: () => ({ toArray: async () => existing }),
        createSearchIndex: async (definition) => { created.push(definition); existing.push({ name: definition.name }); },
    };
    assert.deepEqual((await ensureSearchIndexes(collection)).created, [definitions[1].name]);
    assert.deepEqual((await ensureSearchIndexes(collection)).created, []);
    assert.equal(created.length, 1);
    assert.equal(created[0].definition.mappings.fields.orgId.type, "token");
    assert.equal(definitions[0].definition.fields[0].numDimensions, 1024);
});

test("index bootstrap tolerates a concurrent API instance creating the index", async () => {
    const existing = [];
    const collection = {
        listSearchIndexes: (name) => ({ toArray: async () => existing.filter((i) => !name || i.name === name) }),
        createSearchIndex: async ({ name }) => { existing.push({ name }); throw new Error("Index already exists"); },
    };
    assert.deepEqual((await ensureSearchIndexes(collection)).created, []);
    assert.equal(existing.length, 2);
});

test("index bootstrap reports a real permissions failure", async () => {
    await assert.rejects(ensureSearchIndexes({
        listSearchIndexes: () => ({ toArray: async () => [] }),
        createSearchIndex: async () => { throw new Error("Not authorized to create search indexes"); },
    }), /Not authorized/);
});
