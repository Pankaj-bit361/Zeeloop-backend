// Integration tests for the crawl queue (§1.3) and content-hash re-sync (§1.4).
//
// The queue is a Mongo collection and an in-process poller rather than BullMQ —
// see models/knowledge/crawlJob.js for why. What matters is that it behaves like
// a queue: atomic claim, lease recovery, bounded retry, dead-letter, cancel. All
// five are tested here, because "it is not really a queue" is only acceptable if
// it actually is one.
"use strict";
const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const crawlWorker = require("../functions/knowledge/crawlWorker");
const CrawlJob = require("../models/knowledge/crawlJob");
const KnowledgeSource = require("../models/knowledge/knowledgeSource");
const { RunStatus, SourceStatus, SourceType } = require("../config/enums");
const config = require("../config/config");

const TEST_URI = process.env.TEST_MONGODB_URI || "mongodb://127.0.0.1:27017/zealoop_crawl_test";
const ORG_PREFIX = "org_crawl_";

let connection;
let orgId;

before(async () => {
    connection = await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 3000 });
    // "One live job per source" IS the partial unique index. Built in the
    // background by mongoose, so a fresh database needs it awaited or the
    // duplicate-enqueue assertions test timing instead of the constraint.
    await CrawlJob.init();
});

after(async () => {
    const scope = { orgId: { $regex: `^${ORG_PREFIX}` } };
    await Promise.all([CrawlJob.deleteMany(scope), KnowledgeSource.deleteMany(scope)]);
    if (connection) await mongoose.disconnect();
});

beforeEach(async () => {
    orgId = `${ORG_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    // _claim takes the oldest queued job in the whole collection, not this
    // org's — that is correct for a worker and wrong for a test that then
    // asserts on a specific job. Draining between tests keeps each one honest.
    await CrawlJob.deleteMany({ orgId: { $regex: `^${ORG_PREFIX}` } });
});

async function makeSource() {
    const sourceId = `src_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await KnowledgeSource.create({
        orgId,
        sourceId,
        type: SourceType.SITEMAP,
        name: "Test site",
        url: "https://example.invalid",
        status: SourceStatus.PENDING,
    });
    return sourceId;
}

describe("enqueue", () => {
    test("creates a queued job and moves the source to PENDING", async () => {
        const sourceId = await makeSource();
        const result = await crawlWorker.enqueue({ orgId, sourceId });

        assert.equal(result.success, true);
        assert.equal(result.alreadyQueued, false);

        const job = await CrawlJob.findOne({ orgId, sourceId }).lean();
        assert.equal(job.status, RunStatus.QUEUED);
        assert.equal(job.attempts, 0);
    });

    test("a second enqueue returns the existing job rather than erroring", async () => {
        // Clicking "sync" twice should be idempotent, not a 409 the customer
        // has to interpret.
        const sourceId = await makeSource();
        const first = await crawlWorker.enqueue({ orgId, sourceId });
        const second = await crawlWorker.enqueue({ orgId, sourceId });

        assert.equal(second.alreadyQueued, true);
        assert.equal(second.crawlJobId, first.crawlJobId);
        assert.equal(await CrawlJob.countDocuments({ orgId, sourceId }), 1);
    });

    test("the partial unique index refuses a second live job for one source", async () => {
        const sourceId = await makeSource();
        await crawlWorker.enqueue({ orgId, sourceId });

        await assert.rejects(
            () =>
                CrawlJob.create({
                    orgId,
                    crawlJobId: `job_dup_${Date.now()}`,
                    sourceId,
                    status: RunStatus.QUEUED,
                }),
            (error) => error.code === 11000
        );
    });

    test("a finished job does not block a new one for the same source", async () => {
        // The index is partial on QUEUED/RUNNING precisely so a re-sync next
        // week is allowed.
        const sourceId = await makeSource();
        await crawlWorker.enqueue({ orgId, sourceId });
        await CrawlJob.updateOne({ orgId, sourceId }, { $set: { status: RunStatus.COMPLETED } });

        const second = await crawlWorker.enqueue({ orgId, sourceId });
        assert.equal(second.alreadyQueued, false);
        assert.equal(await CrawlJob.countDocuments({ orgId, sourceId }), 2);
    });
});

describe("claim semantics", () => {
    test("claiming is atomic — one job cannot be taken twice", async () => {
        // findOneAndUpdate does the filter and the write in one operation. A
        // find-then-update would let two instances both claim it.
        //
        // _claim deliberately takes the oldest QUEUED job in the whole
        // collection, not this org's — that is right for a worker and awkward
        // for a test, because the full suite shares one database and another
        // test file's fixture may be sitting ahead of ours in the queue. So this
        // fires enough concurrent claimers to drain past those and asserts on
        // how many of them ended up holding OUR job.
        const sourceId = await makeSource();
        await crawlWorker.enqueue({ orgId, sourceId });

        const backlog = await CrawlJob.countDocuments({ status: RunStatus.QUEUED });
        const claimers = Array.from({ length: backlog + 4 }, () => crawlWorker._claim());
        const claimed = (await Promise.all(claimers)).filter(Boolean);

        const mine = claimed.filter((job) => job.sourceId === sourceId);
        assert.equal(mine.length, 1, "exactly one concurrent claimer may hold a given job");

        // And no job was handed to two claimers, ours or anyone's.
        const ids = claimed.map((job) => job.crawlJobId);
        assert.equal(new Set(ids).size, ids.length, "no job may be claimed twice");

        await CrawlJob.updateMany({ orgId }, { $set: { status: RunStatus.COMPLETED } });
    });

    test("a claim sets RUNNING, a lease and an attempt count", async () => {
        const sourceId = await makeSource();
        await crawlWorker.enqueue({ orgId, sourceId });

        const job = await crawlWorker._claim();
        assert.ok(job);
        assert.equal(job.status, RunStatus.RUNNING);
        assert.equal(job.attempts, 1);
        assert.ok(job.leaseExpiresAt > new Date());
        assert.ok(job.claimedBy);

        await CrawlJob.updateMany({ orgId }, { $set: { status: RunStatus.COMPLETED } });
    });

    test("an expired lease is reclaimable — crash recovery", async () => {
        // The instance holding it died. Without this the job is stuck RUNNING
        // forever with nobody working on it.
        const sourceId = await makeSource();
        await crawlWorker.enqueue({ orgId, sourceId });
        await CrawlJob.updateOne(
            { orgId, sourceId },
            { $set: { status: RunStatus.RUNNING, leaseExpiresAt: new Date(Date.now() - 60_000), claimedBy: "dead-worker" } }
        );

        const job = await crawlWorker._claim();
        assert.ok(job, "an expired lease must be reclaimable");
        assert.notEqual(job.claimedBy, "dead-worker");

        await CrawlJob.updateMany({ orgId }, { $set: { status: RunStatus.COMPLETED } });
    });

    test("a live lease is not stolen", async () => {
        const sourceId = await makeSource();
        await crawlWorker.enqueue({ orgId, sourceId });
        await CrawlJob.updateOne(
            { orgId, sourceId },
            { $set: { status: RunStatus.RUNNING, leaseExpiresAt: new Date(Date.now() + 600_000), claimedBy: "busy-worker" } }
        );

        const job = await crawlWorker._claim();
        // Another org's job may exist in a shared test database, so assert on
        // this source specifically rather than on null.
        assert.ok(!job || job.sourceId !== sourceId, "a live lease must not be stolen");

        await CrawlJob.updateMany({ orgId }, { $set: { status: RunStatus.COMPLETED } });
    });

    test("a dead-lettered job is never claimed again", async () => {
        const sourceId = await makeSource();
        await crawlWorker.enqueue({ orgId, sourceId });
        await CrawlJob.updateOne(
            { orgId, sourceId },
            { $set: { status: RunStatus.QUEUED, deadLetteredAt: new Date() } }
        );

        const job = await crawlWorker._claim();
        assert.ok(!job || job.sourceId !== sourceId);
    });
});

describe("retry and dead-letter", () => {
    test("a failure below the attempt cap requeues with backoff", async () => {
        const sourceId = await makeSource();
        await crawlWorker.enqueue({ orgId, sourceId });
        const job = await CrawlJob.findOne({ orgId, sourceId });
        job.attempts = 1;
        await job.save();

        await crawlWorker._retryOrDeadLetter({ job, error: "fetch failed" });

        const fresh = await CrawlJob.findOne({ orgId, sourceId }).lean();
        assert.equal(fresh.status, RunStatus.QUEUED);
        assert.equal(fresh.deadLetteredAt, null);
        // Held down for the backoff window rather than sleeping the worker.
        assert.ok(fresh.leaseExpiresAt > new Date());
        assert.equal(fresh.lastError, "fetch failed");
    });

    test("passing the attempt cap dead-letters and fails the source", async () => {
        // A dead-lettered job is visible as failed rather than silently
        // vanishing or retrying forever.
        const sourceId = await makeSource();
        await crawlWorker.enqueue({ orgId, sourceId });
        const job = await CrawlJob.findOne({ orgId, sourceId });
        job.attempts = config.CRAWL_MAX_ATTEMPTS;
        await job.save();

        await crawlWorker._retryOrDeadLetter({ job, error: "site unreachable" });

        const fresh = await CrawlJob.findOne({ orgId, sourceId }).lean();
        assert.equal(fresh.status, RunStatus.FAILED);
        assert.ok(fresh.deadLetteredAt);

        const source = await KnowledgeSource.findOne({ orgId, sourceId }).lean();
        assert.equal(source.status, SourceStatus.FAILED);
        assert.equal(source.lastError, "site unreachable");
    });

    test("backoff grows with each attempt", async () => {
        const sourceId = await makeSource();
        await crawlWorker.enqueue({ orgId, sourceId });

        const job = await CrawlJob.findOne({ orgId, sourceId });
        job.attempts = 1;
        await job.save();
        await crawlWorker._retryOrDeadLetter({ job, error: "x" });
        const firstBackoff = (await CrawlJob.findOne({ orgId, sourceId }).lean()).leaseExpiresAt - Date.now();

        const again = await CrawlJob.findOne({ orgId, sourceId });
        again.attempts = 2;
        await again.save();
        await crawlWorker._retryOrDeadLetter({ job: again, error: "x" });
        const secondBackoff = (await CrawlJob.findOne({ orgId, sourceId }).lean()).leaseExpiresAt - Date.now();

        assert.ok(secondBackoff > firstBackoff);
    });
});

describe("cancellation", () => {
    test("cancelling a queued job stops it immediately", async () => {
        const sourceId = await makeSource();
        const queued = await crawlWorker.enqueue({ orgId, sourceId });

        const result = await crawlWorker.cancel({ orgId, crawlJobId: queued.crawlJobId });
        assert.equal(result.status, 200);
        assert.equal(result.json.data.immediate, true);

        const job = await CrawlJob.findOne({ orgId, sourceId }).lean();
        assert.equal(job.status, RunStatus.FAILED);
    });

    test("cancelling a running job flags it rather than killing it mid-write", async () => {
        // Killing a crawl mid-embedding leaves a source with half its chunks
        // replaced.
        const sourceId = await makeSource();
        const queued = await crawlWorker.enqueue({ orgId, sourceId });
        await CrawlJob.updateOne({ orgId, sourceId }, { $set: { status: RunStatus.RUNNING } });

        const result = await crawlWorker.cancel({ orgId, crawlJobId: queued.crawlJobId });
        assert.equal(result.json.data.immediate, false);
        assert.ok(result.json.note);

        const job = await CrawlJob.findOne({ orgId, sourceId }).lean();
        assert.equal(job.cancelRequested, true);
        assert.equal(job.status, RunStatus.RUNNING);
    });

    test("cancelling an unknown job 404s", async () => {
        const result = await crawlWorker.cancel({ orgId, crawlJobId: "job_nope" });
        assert.equal(result.status, 404);
    });

    test("one workspace cannot cancel another's job", async () => {
        const sourceId = await makeSource();
        const queued = await crawlWorker.enqueue({ orgId, sourceId });

        const result = await crawlWorker.cancel({ orgId: `${ORG_PREFIX}other`, crawlJobId: queued.crawlJobId });
        assert.equal(result.status, 404);
    });
});

describe("status reporting", () => {
    test("returns null when a source has never been crawled", async () => {
        const sourceId = await makeSource();
        const result = await crawlWorker.getStatus({ orgId, sourceId });
        assert.equal(result.json.data, null);
    });

    test("returns per-source progress counters", async () => {
        const sourceId = await makeSource();
        await crawlWorker.enqueue({ orgId, sourceId });
        await CrawlJob.updateOne(
            { orgId, sourceId },
            { $set: { "progress.discovered": 40, "progress.fetched": 12, "progress.failed": 1 } }
        );

        const result = await crawlWorker.getStatus({ orgId, sourceId });
        assert.equal(result.json.data.progress.discovered, 40);
        assert.equal(result.json.data.progress.fetched, 12);
        assert.equal(result.json.data.progress.failed, 1);
    });
});

describe("worker lifecycle", () => {
    test("start is idempotent and stop is clean", () => {
        const first = crawlWorker.start();
        const second = crawlWorker.start();
        assert.equal(second.alreadyRunning, true);

        crawlWorker.stop();
        // Restartable after a stop.
        const third = crawlWorker.start();
        assert.equal(third.alreadyRunning, false);
        crawlWorker.stop();
    });

    test("a tick while stopped does nothing", async () => {
        crawlWorker.stop();
        const result = await crawlWorker.tick();
        assert.equal(result.skipped, true);
    });
});
