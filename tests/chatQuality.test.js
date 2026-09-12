// The chat-quality pass on the turn pipeline, tested in-process. The model
// calls and the chunk lookup are stood in for, so these run without a server
// or a database — what they check is the pipeline's own logic:
//
//   - gate and rewrite start together, and a first turn embeds while gating
//   - neighbour expansion merges adjacent chunks and keeps the citation id
//   - a validator complaint with named claims gets one repair pass, re-checked
//   - follow-up suggestions are sanitised and become a choices component
//   - progress is reported stage by stage, and a throwing listener is harmless
"use strict";
const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

process.env.NEW_RELIC_ENABLED = "false";
const config = require("../config/config");
const { TurnOutcome } = require("../config/enums");
const agentFunctions = require("../functions/agent/agentFunctions");
const llmFunctions = require("../functions/utilFunctions/llmFunctions");
const guidanceFunctions = require("../functions/config/guidanceFunctions");
const responseComponentFunctions = require("../functions/widget/responseComponentFunctions");

const org = { orgId: "org_test", name: "AcmeShip", agent: { name: "Zea" } };
const conversation = { conversationId: "conv_test", turnCount: 0, attributes: [] };

const CHUNKS = [
    { chunkId: "c0", sourceId: "src_1", documentKey: "doc_a", position: 0, text: "Refund policy overview. Refunds are available within 14 days of purchase.", headingPath: ["Billing", "Refunds"], tokenCount: 20 },
    { chunkId: "c1", sourceId: "src_1", documentKey: "doc_a", position: 1, text: "Refunds are available within 14 days of purchase. To request one, open Billing and click Request refund.", headingPath: ["Billing", "Refunds"], tokenCount: 25 },
    { chunkId: "c2", sourceId: "src_1", documentKey: "doc_a", position: 2, text: "Refunds take 5 to 7 business days to appear on your statement.", headingPath: ["Billing", "Refunds"], tokenCount: 18 },
    { chunkId: "c9", sourceId: "src_2", documentKey: "doc_b", position: 4, text: "Carrier rates are compared live at label time.", headingPath: ["Shipping", "Rates"], tokenCount: 12 },
];

// One patched-method registry so every test restores what it touched.
const originals = [];
function stub(target, name, impl) {
    originals.push([target, name, target[name]]);
    target[name] = impl;
}

function stubEnvironment({ generate, validate, gate, rewrite, rows } = {}) {
    let validateCalls = 0;
    let generateCalls = 0;
    stub(llmFunctions, "completeJson", async ({ system, messages }) => {
        if (/message classifier/.test(system)) {
            return { json: gate ? await gate() : { language: "en", intent: "QUESTION", sentiment: "NEUTRAL", safe: true }, inputTokens: 10, outputTokens: 5 };
        }
        if (/Rewrite the user's latest message/.test(system)) {
            return { json: rewrite ? await rewrite() : { query: "refund policy" }, inputTokens: 10, outputTokens: 5 };
        }
        if (/strict validator/.test(system)) {
            validateCalls += 1;
            return { json: await validate({ call: validateCalls, messages }), inputTokens: 10, outputTokens: 5 };
        }
        generateCalls += 1;
        return { json: await generate({ call: generateCalls, system, messages }), inputTokens: 100, outputTokens: 40 };
    });
    stub(llmFunctions, "embed", async () => [[0.1, 0.2, 0.3]]);
    stub(llmFunctions, "rerank", async ({ documents, topN }) =>
        documents.slice(0, topN).map((_, index) => ({ index, score: 0.9 - index * 0.1 }))
    );
    stub(guidanceFunctions, "loadForTurn", async () => ({
        appliedRuleIds: [], segmentIds: [], guidancePrompt: "", escalationPrompt: "", escalation: { triggered: false, rule: null },
    }));
    stub(guidanceFunctions, "composeIdentityAndContext", () => ({ prompt: "", maxTokens: 512 }));
    stub(agentFunctions, "_vectorSearch", async () => [{ chunkId: "c1", sourceId: "src_1", text: CHUNKS[1].text, headingPath: CHUNKS[1].headingPath, vectorScore: 0.8 }]);
    stub(agentFunctions, "_textSearch", async () => [{ chunkId: "c9", sourceId: "src_2", text: CHUNKS[3].text, headingPath: CHUNKS[3].headingPath, textScore: 3.2 }]);
    stub(agentFunctions, "_loadTables", async () => ({ tables: [], rows: [] }));
    stub(agentFunctions, "_loadActions", async () => []);
    stub(agentFunctions, "_loadProcedures", async () => null);
    stub(agentFunctions, "_fetchChunkRows", async () => rows || CHUNKS);
    const traces = [];
    stub(agentFunctions, "_writeTrace", async (trace) => { traces.push(trace); });
    return { traces, counts: () => ({ validateCalls, generateCalls }) };
}

afterEach(() => {
    while (originals.length) {
        const [target, name, value] = originals.pop();
        target[name] = value;
    }
});

const answer = (text, extra = {}) => ({ type: "answer", text, citationChunkIds: ["c1"], ...extra });
const ok = { grounded: true, answersQuery: true, unsupportedClaims: [] };

describe("stage 0 and 1 run together", () => {
    test("the rewrite starts before the gate has answered, and a first turn embeds during the gate", async () => {
        const order = [];
        const env = stubEnvironment({
            gate: async () => { order.push("gate:start"); await new Promise((r) => setTimeout(r, 20)); order.push("gate:done"); return { language: "en", intent: "QUESTION", sentiment: "NEUTRAL", safe: true }; },
            rewrite: async () => { order.push("rewrite:start"); return { query: "refund policy" }; },
            generate: async () => answer("Refunds are available within 14 days."),
            validate: async () => ok,
        });
        stub(llmFunctions, "embed", async () => { order.push("embed:start"); return [[0.1, 0.2, 0.3]]; });

        // Turn 2 with history: rewrite runs. Both must start before the gate finishes.
        await agentFunctions.runTurn({ org, conversation: { ...conversation, turnCount: 1 }, endUser: null, identityVerified: false, rawMessage: "and how long does it take?", history: [{ role: "USER", content: "refund?" }, { role: "ASSISTANT", content: "14 days" }] });
        assert.ok(order.indexOf("rewrite:start") < order.indexOf("gate:done"), `rewrite waited for the gate: ${order.join(" → ")}`);

        // Turn 1, no history: no rewrite, but the embedding starts under the gate.
        order.length = 0;
        await agentFunctions.runTurn({ org, conversation, endUser: null, identityVerified: false, rawMessage: "What is your refund policy?", history: [] });
        assert.ok(order.indexOf("embed:start") < order.indexOf("gate:done"), `embed waited for the gate: ${order.join(" → ")}`);
        assert.equal(env.traces[1].latencyMs.rewrite, 0);
    });
});

describe("neighbour expansion", () => {
    test("merges a top chunk with its neighbours into one passage that cites the matched chunk", async () => {
        stub(agentFunctions, "_fetchChunkRows", async () => CHUNKS);
        const passages = await agentFunctions._expandNeighbors({
            orgId: "org_test",
            topChunks: [
                { chunkId: "c1", sourceId: "src_1", text: CHUNKS[1].text, headingPath: CHUNKS[1].headingPath, rerankScore: 0.9 },
                { chunkId: "c9", sourceId: "src_2", text: CHUNKS[3].text, headingPath: CHUNKS[3].headingPath, rerankScore: 0.6 },
            ],
        });
        assert.equal(passages.length, 2);
        const [refund, rates] = passages;
        assert.equal(refund.chunkId, "c1");
        assert.deepEqual(refund.memberChunkIds, ["c0", "c1", "c2"]);
        assert.match(refund.text, /overview/);
        assert.match(refund.text, /5 to 7 business days/);
        // The 15% overlap between c0 and c1 is stitched once, not read twice.
        assert.equal(refund.text.split("Refunds are available within 14 days of purchase.").length - 1, 1);
        assert.deepEqual(rates.memberChunkIds, ["c9"]);
    });

    test("two top chunks in the same window become one passage cited by the higher score", async () => {
        stub(agentFunctions, "_fetchChunkRows", async () => CHUNKS);
        const passages = await agentFunctions._expandNeighbors({
            orgId: "org_test",
            topChunks: [
                { chunkId: "c2", sourceId: "src_1", text: CHUNKS[2].text, headingPath: CHUNKS[2].headingPath, rerankScore: 0.7 },
                { chunkId: "c1", sourceId: "src_1", text: CHUNKS[1].text, headingPath: CHUNKS[1].headingPath, rerankScore: 0.9 },
            ],
        });
        assert.equal(passages.length, 1);
        assert.equal(passages[0].chunkId, "c1");
        assert.deepEqual(passages[0].memberChunkIds, ["c0", "c1", "c2"]);
    });

    test("stays inside the token budget by leaving later chunks bare", async () => {
        stub(agentFunctions, "_fetchChunkRows", async () => CHUNKS);
        const saved = config.CONTEXT_MAX_TOKENS;
        config.CONTEXT_MAX_TOKENS = 30; // room for one bare chunk, not a widened one
        try {
            const passages = await agentFunctions._expandNeighbors({
                orgId: "org_test",
                topChunks: [{ chunkId: "c1", sourceId: "src_1", text: CHUNKS[1].text, headingPath: [], rerankScore: 0.9 }],
            });
            assert.deepEqual(passages[0].memberChunkIds, ["c1"]);
        } finally {
            config.CONTEXT_MAX_TOKENS = saved;
        }
    });

    test("a lookup failure degrades to the reranked chunks, never to nothing", async () => {
        stub(agentFunctions, "_fetchChunkRows", async () => { throw new Error("db down"); });
        const top = [{ chunkId: "c1", sourceId: "src_1", text: "x", headingPath: [], rerankScore: 0.9 }];
        assert.equal(await agentFunctions._expandNeighbors({ orgId: "org_test", topChunks: top }), top);
    });

    test("stitching trims the shared span between adjacent chunks", () => {
        const joined = agentFunctions._stitchChunks(["Alpha beta gamma delta epsilon zeta eta.", "delta epsilon zeta eta. Theta iota."]);
        assert.equal(joined, "Alpha beta gamma delta epsilon zeta eta. Theta iota.");
        assert.equal(agentFunctions._stitchChunks(["one", "two"]), "one\n\ntwo");
    });
});

describe("repair pass", () => {
    test("a validator complaint with named claims gets one rewrite, which is re-validated and shipped", async () => {
        const env = stubEnvironment({
            generate: async ({ call, messages }) => {
                if (call === 1) return answer("Refunds are available within 14 days and we also refund shipping.");
                assert.match(messages[messages.length - 1].content, /also refund shipping/);
                return answer("Refunds are available within 14 days of purchase.", { followUps: ["How long does a refund take?"] });
            },
            validate: async ({ call }) => (call === 1 ? { grounded: false, answersQuery: true, unsupportedClaims: ["we also refund shipping"] } : ok),
        });
        const turn = await agentFunctions.runTurn({ org, conversation, endUser: null, identityVerified: false, rawMessage: "What is your refund policy?", history: [] });
        assert.equal(turn.outcome, TurnOutcome.ANSWERED);
        assert.equal(turn.reply, "Refunds are available within 14 days of purchase.");
        assert.deepEqual(turn.followUps, ["How long does a refund take?"]);
        assert.deepEqual(env.counts(), { validateCalls: 2, generateCalls: 2 });
        assert.equal(env.traces[0].repairAttempted, true);
        assert.equal(env.traces[0].repairSucceeded, true);
        assert.equal(env.traces[0].grounded, true);
        assert.equal(env.traces[0].contextChunkCount, 2);
    });

    test("a second failure abstains, and the repair is never looped", async () => {
        const env = stubEnvironment({
            generate: async () => answer("Refunds cover shipping too."),
            validate: async () => ({ grounded: false, answersQuery: true, unsupportedClaims: ["covers shipping"] }),
        });
        const turn = await agentFunctions.runTurn({ org, conversation, endUser: null, identityVerified: false, rawMessage: "Refund policy?", history: [] });
        assert.equal(turn.outcome, TurnOutcome.ABSTAINED);
        assert.deepEqual(env.counts(), { validateCalls: 2, generateCalls: 2 });
        assert.equal(env.traces[0].repairAttempted, true);
        assert.equal(env.traces[0].repairSucceeded, false);
    });

    test("an answer that does not address the question, or a validator with no claims, is not repaired", async () => {
        const env = stubEnvironment({
            generate: async () => answer("Something unrelated."),
            validate: async () => ({ grounded: false, answersQuery: false, unsupportedClaims: ["x"] }),
        });
        const turn = await agentFunctions.runTurn({ org, conversation, endUser: null, identityVerified: false, rawMessage: "Refund policy?", history: [] });
        assert.equal(turn.outcome, TurnOutcome.ABSTAINED);
        assert.deepEqual(env.counts(), { validateCalls: 1, generateCalls: 1 });
        assert.equal(env.traces[0].repairAttempted, false);

        assert.equal(agentFunctions._isRepairable({ generation: { outcome: "ANSWERED", reply: "x", toolCalls: [] }, verdict: { grounded: false, answersQuery: true, unsupportedClaims: [] } }), false);
        assert.equal(agentFunctions._isRepairable({ generation: { outcome: "ANSWERED", reply: "x", toolCalls: [], halted: true }, verdict: { grounded: false, answersQuery: true, unsupportedClaims: ["a"] } }), false);
        assert.equal(agentFunctions._isRepairable({ generation: { outcome: "ANSWERED", reply: "x", toolCalls: [] }, verdict: { grounded: false, answersQuery: true, unsupportedClaims: ["a"] } }), true);
    });
});

describe("follow-up suggestions", () => {
    test("are sanitised: strings only, bounded, deduplicated, never the question just asked", () => {
        const clean = agentFunctions._cleanFollowUps({
            followUps: ["How long does a refund take?", 42, "  how long does a refund take? ", "x", "What is your refund policy?", "Can I get store credit instead?", "Do you refund shipping?", "Extra one"],
            query: "refund policy",
            rawMessage: "What is your refund policy?",
        });
        assert.deepEqual(clean, ["How long does a refund take?", "Can I get store credit instead?", "Do you refund shipping?"]);
        assert.deepEqual(agentFunctions._cleanFollowUps({ followUps: "nope" }), []);
    });

    test("ride to the widget as a choices component, only under a real answer", () => {
        const answered = responseComponentFunctions.fromTurn({ turn: { outcome: "ANSWERED", reply: "Yes.", followUps: ["How long does it take?"], toolCalls: [] } });
        const choices = answered.components.find((component) => component.type === "choices");
        assert.ok(choices, "expected a choices component");
        assert.deepEqual(choices.options, [{ label: "How long does it take?", value: "How long does it take?" }]);

        const abstained = responseComponentFunctions.fromTurn({ turn: { outcome: "ABSTAINED", reply: "Not sure.", followUps: ["x?"], toolCalls: [] } });
        assert.equal(abstained.components.some((component) => component.type === "choices"), false);
    });
});

describe("progress", () => {
    test("reports every stage in order, and a listener that throws cannot fail the turn", async () => {
        stubEnvironment({ generate: async () => answer("Refunds are available within 14 days."), validate: async () => ok });
        const stages = [];
        const turn = await agentFunctions.runTurn({
            org, conversation, endUser: null, identityVerified: false, rawMessage: "Refund policy?", history: [],
            onProgress: (progress) => { stages.push(progress.stage); if (progress.stage === "reading") assert.equal(progress.sources, 2); throw new Error("listener bug"); },
        });
        assert.equal(turn.outcome, TurnOutcome.ANSWERED);
        assert.deepEqual(stages, ["classifying", "searching", "reading", "writing", "checking"]);
    });
});
