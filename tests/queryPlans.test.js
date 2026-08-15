// Query-plan regression tests.
//
// These do not assert that a particular index exists — that would test the
// implementation, and would fail the day someone replaces two indexes with a
// better one. They assert the property we actually care about: these queries
// must never become collection scans or in-memory sorts.
//
// Every one of them was one or the other before the indexes went in, and the
// two failure modes are the ones that do not show up in testing:
//
//   COLLSCAN is invisible until the collection is large. It is fast on the
//   hundred rows a test fixture creates and pathological on a real workspace.
//
//   An in-memory SORT is worse than it looks. Mongo caps it at 32MB and then
//   the query FAILS rather than degrading — so a list endpoint that works for
//   two years stops working entirely once a workspace crosses the line.
"use strict";
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const Conversation = require("../models/conversation/conversation");
const Message = require("../models/conversation/message");
const TurnTrace = require("../models/trace/turnTrace");
const Chunk = require("../models/knowledge/chunk");
const Subscription = require("../models/billing/subscription");
const KnowledgeSource = require("../models/knowledge/knowledgeSource");
const CrawlJob = require("../models/knowledge/crawlJob");

const URI = process.env.TEST_MONGODB_URI || "mongodb://127.0.0.1:27017/zealoop_plans_test";
const ORG = "org_plan_test";

let connection;

const MODELS = [Conversation, Message, TurnTrace, Chunk, Subscription, KnowledgeSource, CrawlJob];

before(async () => {
    connection = await mongoose.connect(URI, { serverSelectionTimeoutMS: 5000 });

    /* Every index is dropped and rebuilt from the models before measuring.
       This is not tidiness — it is what makes the suite a guard at all.

       Mongoose creates indexes that are missing and never drops ones that are
       no longer declared. So on a database where an index was built once, these
       tests keep passing forever even after someone deletes the declaration —
       which is exactly the regression they exist to catch, sailing through
       green. Verified: without this, removing the conversations index by hand
       left all eleven tests passing. */
    for (const model of MODELS) {
        try {
            await model.collection.dropIndexes();
        } catch (error) {
            // 26 = NamespaceNotFound: the collection does not exist yet, which
            // is fine — createIndexes below will make both.
            if (error.code !== 26) throw error;
        }
    }
    await Promise.all(MODELS.map((model) => model.createIndexes()));
});

after(async () => {
    if (connection) await mongoose.disconnect();
});

/** Flattens the winning plan into a list of stage names. */
function stagesOf(explain) {
    const stages = [];
    (function walk(stage) {
        if (!stage) return;
        stages.push(stage.stage);
        if (stage.inputStage) walk(stage.inputStage);
        if (stage.inputStages) stage.inputStages.forEach(walk);
    })(explain.queryPlanner.winningPlan.queryPlan || explain.queryPlanner.winningPlan);
    return stages;
}

async function assertIndexed(label, query) {
    const explain = await query.explain();
    const stages = stagesOf(explain);
    assert.ok(
        !stages.includes("COLLSCAN"),
        `${label}: collection scan — plan was ${stages.join(" < ")}`
    );
    assert.ok(
        !stages.includes("SORT"),
        `${label}: in-memory sort — plan was ${stages.join(" < ")}. Mongo caps this at 32MB and then fails the query outright.`
    );
}

describe("hot query plans stay indexed", () => {
    test("the inbox list, newest first", async () => {
        await assertIndexed(
            "conversations by createdAt",
            Conversation.find({ orgId: ORG }).sort({ createdAt: -1 }).limit(50)
        );
    });

    test("the inbox list filtered by status", async () => {
        await assertIndexed(
            "conversations by status",
            Conversation.find({ orgId: ORG, status: "OPEN" }).sort({ lastMessageAt: -1 }).limit(50)
        );
    });

    test("messages of one conversation, in order", async () => {
        await assertIndexed(
            "messages by conversation",
            Message.find({ orgId: ORG, conversationId: "cnv_1" }).sort({ createdAt: 1 })
        );
    });

    test("traces of one conversation, in turn order", async () => {
        await assertIndexed(
            "traces by conversation",
            TurnTrace.find({ orgId: ORG, conversationId: "cnv_1" }).sort({ turn: 1 })
        );
    });

    test("every chunk of one source, in position order", async () => {
        // Rendering an article reads all of them. A big help centre is
        // thousands of chunks per source.
        await assertIndexed(
            "chunks by source",
            Chunk.find({ orgId: ORG, sourceId: "src_1" }).sort({ position: 1 })
        );
    });

    test("the knowledge sources list", async () => {
        await assertIndexed(
            "sources by createdAt",
            KnowledgeSource.find({ orgId: ORG }).sort({ createdAt: -1 })
        );
    });

    test("crawl history for one source", async () => {
        await assertIndexed(
            "crawl jobs by source",
            CrawlJob.find({ orgId: ORG, sourceId: "src_1" }).sort({ createdAt: -1 })
        );
    });
});

describe("cron sweeps do not scan the cluster", () => {
    /* These run on a schedule and are NOT scoped to one tenant, so their cost
       grows with the total number of customers — the one number a business
       should never be punished for. */

    test("the autonomous-resolution sweep", async () => {
        await assertIndexed(
            "resolution sweep",
            Conversation.find({
                isResolved: false,
                status: { $ne: "ESCALATED" },
                hasHumanReply: false,
                lastMessageAt: { $lte: new Date(), $ne: null },
                turnCount: { $gt: 0 },
            }).limit(500)
        );
    });

    test("the trial-expiry sweep", async () => {
        await assertIndexed(
            "trial sweep",
            Subscription.find({ status: "TRIALING", trialEndsAt: { $lte: new Date() } })
        );
    });

    test("the grace-period sweep", async () => {
        await assertIndexed(
            "grace sweep",
            Subscription.find({ status: "PAST_DUE", gracePeriodEndsAt: { $lte: new Date() } })
        );
    });

    test("the scheduled re-sync sweep", async () => {
        await assertIndexed(
            "resync sweep",
            KnowledgeSource.find({
                syncSchedule: { $in: ["DAILY", "WEEKLY"] },
                nextSyncAt: { $lte: new Date() },
            }).limit(200)
        );
    });
});
