// Tests for Phase 3 — evaluation and measurement.
//
// The pieces tested here are the ones whose logic is not a model call: gap
// clustering, monitor matching, the search filter builder, and the shape of the
// simulation and quality definitions. The model-facing parts are exercised by
// their callers; what matters here is that the deterministic scaffolding around
// them is right, because a judge with a broken harness reports green.
"use strict";
const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const recommendationFunctions = require("../functions/eval/recommendationFunctions");
const monitorFunctions = require("../functions/eval/monitorFunctions");
const conversationSearchFunctions = require("../functions/eval/conversationSearchFunctions");
const simulationFunctions = require("../functions/eval/simulationFunctions");
const qualityFunctions = require("../functions/eval/qualityFunctions");
const batchTestFunctions = require("../functions/eval/batchTestFunctions");
const evalRunner = require("../functions/eval/evalRunner");
const Conversation = require("../models/conversation/conversation");
const { Monitor, ConversationReview } = require("../models/eval/monitor");
const { MonitorTrigger, TurnOutcome, EvalRating, GateSentiment, ConversationStatus } = require("../config/enums");

const TEST_URI = process.env.TEST_MONGODB_URI || "mongodb://127.0.0.1:27017/zealoop_eval_test";
const ORG_PREFIX = "org_eval_";

let connection;
let orgId;

before(async () => {
    connection = await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 3000 });
    // The review queue's de-duplication IS a unique index, and mongoose builds
    // indexes in the background. Against a fresh database the duplicate insert
    // below would otherwise succeed and the test would report a bug that is
    // really a race — the same race server.js now closes at boot via
    // indexReadiness.
    await ConversationReview.init();
});

after(async () => {
    const scope = { orgId: { $regex: `^${ORG_PREFIX}` } };
    await Promise.all([Conversation.deleteMany(scope), Monitor.deleteMany(scope), ConversationReview.deleteMany(scope)]);
    if (connection) await mongoose.disconnect();
});

beforeEach(() => {
    orgId = `${ORG_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
});

describe("gap clustering (§3.5)", () => {
    // Two-dimensional vectors keep the geometry obvious.
    const unit = (x, y) => {
        const length = Math.hypot(x, y);
        return [x / length, y / length];
    };

    test("near-identical phrasings land in one cluster", () => {
        // The whole point: "how do I cancel", "can I cancel my plan" and
        // "cancellation process" are one gap and three exact-match groups.
        const queries = ["how do I cancel", "can I cancel my plan", "cancellation process"];
        const vectors = [unit(1, 0.01), unit(1, 0.02), unit(1, 0.0)];

        const clusters = recommendationFunctions._cluster({ queries, vectors });
        assert.equal(clusters.length, 1);
        assert.equal(clusters[0].members.length, 3);
    });

    test("unrelated questions form separate clusters", () => {
        const queries = ["how do I cancel", "what is your API rate limit"];
        const vectors = [unit(1, 0), unit(0, 1)];

        const clusters = recommendationFunctions._cluster({ queries, vectors });
        assert.equal(clusters.length, 2);
    });

    test("the representative is the first member, which is the most recent phrasing", () => {
        // Traces come back newest-first, so the label reads as something a
        // customer actually asked recently.
        const clusters = recommendationFunctions._cluster({
            queries: ["newest phrasing", "older phrasing"],
            vectors: [unit(1, 0), unit(1, 0.01)],
        });
        assert.equal(clusters[0].representative, "newest phrasing");
    });

    test("clustering is stable across runs on the same input", () => {
        // k-means would reshuffle every run, which makes "is this gap new?"
        // unanswerable.
        const queries = ["a", "b", "c", "d"];
        const vectors = [unit(1, 0), unit(1, 0.01), unit(0, 1), unit(0.01, 1)];

        const first = recommendationFunctions._cluster({ queries, vectors });
        const second = recommendationFunctions._cluster({ queries, vectors });
        assert.deepEqual(
            first.map((cluster) => cluster.members),
            second.map((cluster) => cluster.members)
        );
    });

    test("cosine similarity is correct at the extremes", () => {
        assert.equal(Math.round(recommendationFunctions._cosine([1, 0], [1, 0]) * 1000), 1000);
        assert.equal(Math.round(recommendationFunctions._cosine([1, 0], [0, 1]) * 1000), 0);
        assert.equal(recommendationFunctions._cosine([0, 0], [1, 0]), 0);
    });
});

describe("monitor matching (§3.6)", () => {
    async function makeConversation(overrides) {
        const conversationId = `conv_ev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const conversation = await Conversation.create({ orgId, conversationId, lastMessageAt: new Date(), ...overrides });
        return conversation.toObject();
    }

    test("ALL_ESCALATIONS flags only escalated conversations", async () => {
        const escalated = await makeConversation({ status: ConversationStatus.ESCALATED });
        const open = await makeConversation({ status: ConversationStatus.OPEN });

        const matches = await monitorFunctions._matchConversations({
            orgId,
            monitor: { trigger: MonitorTrigger.ALL_ESCALATIONS, monitorId: "mon_1" },
            conversations: [escalated, open],
        });

        assert.equal(matches.length, 1);
        assert.equal(matches[0].conversation.conversationId, escalated.conversationId);
    });

    test("NEGATIVE_SENTIMENT flags both NEGATIVE and ANGRY", async () => {
        const angry = await makeConversation({
            attributes: [{ attributeId: "atr_s", name: "Sentiment", value: GateSentiment.ANGRY }],
        });
        const happy = await makeConversation({
            attributes: [{ attributeId: "atr_s", name: "Sentiment", value: GateSentiment.POSITIVE }],
        });

        const matches = await monitorFunctions._matchConversations({
            orgId,
            monitor: { trigger: MonitorTrigger.NEGATIVE_SENTIMENT, monitorId: "mon_2" },
            conversations: [angry, happy],
        });

        assert.equal(matches.length, 1);
    });

    test("LOW_QUALITY_SCORE respects the threshold", async () => {
        const poor = await makeConversation({ quality: { score: 0.3, gradedAt: new Date() } });
        const good = await makeConversation({ quality: { score: 0.9, gradedAt: new Date() } });
        const ungraded = await makeConversation({});

        const matches = await monitorFunctions._matchConversations({
            orgId,
            monitor: { trigger: MonitorTrigger.LOW_QUALITY_SCORE, scoreBelow: 0.6, monitorId: "mon_3" },
            conversations: [poor, good, ungraded],
        });

        assert.equal(matches.length, 1);
        assert.equal(matches[0].conversation.conversationId, poor.conversationId);
    });

    test("RANDOM_SAMPLE is deterministic, so a re-run flags the same set", async () => {
        // A random draw would accumulate a new slice on every tick until the
        // whole workspace is in the queue.
        const conversations = await Promise.all(Array.from({ length: 20 }, () => makeConversation({})));
        const monitor = { trigger: MonitorTrigger.RANDOM_SAMPLE, samplePercent: 50, monitorId: "mon_4" };

        const first = await monitorFunctions._matchConversations({ orgId, monitor, conversations });
        const second = await monitorFunctions._matchConversations({ orgId, monitor, conversations });

        assert.deepEqual(
            first.map((match) => match.conversation.conversationId),
            second.map((match) => match.conversation.conversationId)
        );
    });

    test("the sample hash spreads roughly evenly", () => {
        const ids = Array.from({ length: 400 }, (unused, index) => `conv_${index}_abcdef`);
        const under = ids.filter((id) => monitorFunctions._hashFraction(id) < 0.5).length;
        // Loose bounds: this checks the hash is not degenerate, not that it is
        // cryptographic.
        assert.ok(under > 140 && under < 260, `expected roughly half, got ${under}/400`);
    });

    test("every verdict carries a human-readable reason", async () => {
        const conversation = await makeConversation({ status: ConversationStatus.ESCALATED });
        const matches = await monitorFunctions._matchConversations({
            orgId,
            monitor: { trigger: MonitorTrigger.ALL_ESCALATIONS, monitorId: "mon_5" },
            conversations: [conversation],
        });
        assert.ok(matches[0].reason);
    });

    test("re-enqueueing the same conversation is a no-op, not a duplicate", async () => {
        // Without this the queue is unusable by the end of the first day.
        const conversation = await makeConversation({ status: ConversationStatus.ESCALATED });
        const monitor = { monitorId: "mon_dedupe", trigger: MonitorTrigger.ALL_ESCALATIONS, assignTo: null };
        const match = { conversation, reason: "Escalated" };

        const first = await monitorFunctions._enqueue({ orgId, monitor, match });
        const second = await monitorFunctions._enqueue({ orgId, monitor, match });

        assert.equal(first, true);
        assert.equal(second, false);
        assert.equal(await ConversationReview.countDocuments({ orgId, monitorId: "mon_dedupe" }), 1);
    });
});

describe("monitor validation", () => {
    test("a keyword monitor with no keywords is refused", async () => {
        const result = await monitorFunctions.createMonitor({ orgId, name: "Keywords", trigger: MonitorTrigger.KEYWORD_MATCH });
        assert.equal(result.status, 400);
    });

    test("a random-sample monitor rejects an out-of-range percentage", async () => {
        const zero = await monitorFunctions.createMonitor({
            orgId,
            name: "Sample",
            trigger: MonitorTrigger.RANDOM_SAMPLE,
            samplePercent: 0,
        });
        assert.equal(zero.status, 400);

        const tooMuch = await monitorFunctions.createMonitor({
            orgId,
            name: "Sample",
            trigger: MonitorTrigger.RANDOM_SAMPLE,
            samplePercent: 500,
        });
        assert.equal(tooMuch.status, 400);
    });

    test("an unknown trigger is refused and the real ones are listed", async () => {
        const result = await monitorFunctions.createMonitor({ orgId, name: "x", trigger: "VIBES" });
        assert.equal(result.status, 400);
        assert.match(result.json.error, /trigger must be one of/);
    });
});

describe("conversation search filters (§3.7)", () => {
    async function seed() {
        await Conversation.create({
            orgId,
            conversationId: `conv_s1_${Date.now()}`,
            status: ConversationStatus.ESCALATED,
            channel: "CHAT",
            lastMessageAt: new Date(),
            attributes: [{ attributeId: "atr_issue", name: "Issue Type", value: "BILLING" }],
        });
        await Conversation.create({
            orgId,
            conversationId: `conv_s2_${Date.now()}`,
            status: ConversationStatus.OPEN,
            channel: "EMAIL",
            lastMessageAt: new Date(),
            attributes: [{ attributeId: "atr_issue", name: "Issue Type", value: "HOW_TO" }],
        });
    }

    test("filters by status", async () => {
        await seed();
        const result = await conversationSearchFunctions.search({
            orgId,
            filters: { status: ConversationStatus.ESCALATED },
        });
        assert.equal(result.json.data.length, 1);
        assert.equal(result.json.data[0].status, ConversationStatus.ESCALATED);
    });

    test("filters by channel", async () => {
        await seed();
        const result = await conversationSearchFunctions.search({ orgId, filters: { channel: "EMAIL" } });
        assert.equal(result.json.data.length, 1);
    });

    test("an attribute filter matches id and value on the SAME attribute", async () => {
        // Without $elemMatch, Mongo matches a conversation where one attribute
        // has the id and a different one has the value.
        await seed();
        const match = await conversationSearchFunctions.search({
            orgId,
            filters: { attributes: [{ attributeId: "atr_issue", value: "BILLING" }] },
        });
        assert.equal(match.json.data.length, 1);

        const mismatch = await conversationSearchFunctions.search({
            orgId,
            filters: { attributes: [{ attributeId: "atr_issue", value: "ACCOUNT" }] },
        });
        assert.equal(mismatch.json.data.length, 0);
    });

    test("an invalid date is ignored rather than matching nothing", async () => {
        // `new Date("last tuesday")` is Invalid Date, which Mongo matches
        // against nothing — indistinguishable from "no results".
        await seed();
        const result = await conversationSearchFunctions.search({ orgId, filters: { from: "last tuesday" } });
        assert.equal(result.json.data.length, 2);
    });

    test("two id-narrowing filters intersect rather than overwriting", () => {
        // Text search and outcome filter both narrow by conversationId; a naive
        // assignment would make whichever ran second the only one that applied.
        const first = conversationSearchFunctions._intersect(undefined, ["a", "b", "c"]);
        const second = conversationSearchFunctions._intersect(first, ["b", "c", "d"]);
        assert.deepEqual(second.$in, ["b", "c"]);
    });

    test("results are scoped to one workspace", async () => {
        await seed();
        const result = await conversationSearchFunctions.search({ orgId: `${ORG_PREFIX}other`, filters: {} });
        assert.equal(result.json.data.length, 0);
    });
});

describe("built-in simulations (§3.2)", () => {
    test("all five shipped scenarios are present", () => {
        assert.equal(simulationFunctions.BUILT_IN_SIMULATIONS.length, 5);
    });

    test("each has criteria and a persona that can actually be played", () => {
        for (const simulation of simulationFunctions.BUILT_IN_SIMULATIONS) {
            assert.ok(simulation.criteria.length > 0, `${simulation.key} has no criteria`);
            assert.ok(
                simulation.persona.details.length > 40,
                `${simulation.key} persona is too thin for a model to play`
            );
        }
    });

    test("the identity-gate scenario asserts the agent REFUSES", () => {
        // The most important property in the system. A criterion phrased as
        // "the agent handles this well" would pass on a failure.
        const scenario = simulationFunctions.BUILT_IN_SIMULATIONS.find(
            (simulation) => simulation.key === simulationFunctions.BUILT_IN_KEYS.WRITE_WITHOUT_IDENTITY
        );
        assert.ok(scenario.criteria.some((criterion) => /did NOT|not accept/i.test(criterion)));
    });

    test("the frustrated-user scenario expects ESCALATED", () => {
        const scenario = simulationFunctions.BUILT_IN_SIMULATIONS.find(
            (simulation) => simulation.key === simulationFunctions.BUILT_IN_KEYS.FRUSTRATED
        );
        assert.equal(scenario.expectedOutcome, TurnOutcome.ESCALATED);
    });

    test("no persona description leaks the criteria being tested", () => {
        // A persona that knows the criterion steers toward it and the test
        // passes regardless of what the agent does.
        for (const simulation of simulationFunctions.BUILT_IN_SIMULATIONS) {
            assert.doesNotMatch(
                simulation.persona.details,
                /criteria|the agent should|test/i,
                `${simulation.key} persona leaks what is being tested`
            );
        }
    });
});

describe("quality grading vocabulary (§3.4)", () => {
    test("reason categories are a fixed vocabulary, not free text", () => {
        // Free-text reasons cannot be aggregated: fifty conversations produce
        // fifty explanations and no chart.
        assert.ok(Object.keys(qualityFunctions.POSITIVE_REASONS).length >= 4);
        assert.ok(Object.keys(qualityFunctions.NEGATIVE_REASONS).length >= 6);
    });

    test("positive and negative categories do not overlap", () => {
        const positive = new Set(Object.keys(qualityFunctions.POSITIVE_REASONS));
        for (const key of Object.keys(qualityFunctions.NEGATIVE_REASONS)) {
            assert.ok(!positive.has(key), `${key} is in both vocabularies`);
        }
    });

    test("the vocabulary distinguishes over- from under-escalation", () => {
        // Two very different problems that a single "escalation" category would
        // hide, which is the same mistake the single resolution rate made.
        assert.ok(qualityFunctions.NEGATIVE_REASONS.OVER_ESCALATED);
        assert.ok(qualityFunctions.NEGATIVE_REASONS.UNDER_ESCALATED);
    });
});

describe("batch test question handling (§3.1)", () => {
    test("normalises strings and objects into the same shape", () => {
        const questions = batchTestFunctions._normaliseQuestions([
            "How do I cancel?",
            { text: "Where is my order?", expectedBehaviour: "Should look it up" },
        ]);

        assert.equal(questions.length, 2);
        assert.ok(questions[0].questionId);
        assert.equal(questions[0].lastRating, EvalRating.UNRATED);
        assert.equal(questions[1].expectedBehaviour, "Should look it up");
    });

    test("drops blank questions", () => {
        const questions = batchTestFunctions._normaliseQuestions(["", "   ", null, { text: "" }, "Real"]);
        assert.equal(questions.length, 1);
    });

    test("caps the question count", () => {
        const many = Array.from({ length: 500 }, (unused, index) => `Question ${index}`);
        assert.equal(batchTestFunctions._normaliseQuestions(many).length, batchTestFunctions.MAX_QUESTIONS);
    });

    test("a non-array returns empty rather than throwing", () => {
        assert.deepEqual(batchTestFunctions._normaliseQuestions("not an array"), []);
        assert.deepEqual(batchTestFunctions._normaliseQuestions(undefined), []);
    });
});

describe("eval runner concurrency", () => {
    test("mapLimited runs everything and preserves order", async () => {
        const items = [1, 2, 3, 4, 5, 6, 7];
        const results = await evalRunner.mapLimited({ items, limit: 3, handler: async (value) => value * 2 });
        assert.deepEqual(results, [2, 4, 6, 8, 10, 12, 14]);
    });

    test("one failing item does not abandon the rest", async () => {
        // A forty-question suite must not lose thirty-nine answers to one bad
        // question.
        const results = await evalRunner.mapLimited({
            items: [1, 2, 3],
            limit: 2,
            handler: async (value) => {
                if (value === 2) throw new Error("boom");
                return value;
            },
        });

        assert.equal(results[0], 1);
        assert.ok(results[1].error);
        assert.equal(results[2], 3);
    });

    test("concurrency is actually bounded", async () => {
        let active = 0;
        let peak = 0;
        await evalRunner.mapLimited({
            items: Array.from({ length: 12 }, (unused, index) => index),
            limit: 3,
            handler: async () => {
                active += 1;
                peak = Math.max(peak, active);
                await new Promise((resolve) => setImmediate(resolve));
                active -= 1;
            },
        });

        assert.ok(peak <= 3, `expected at most 3 concurrent, saw ${peak}`);
    });
});
