const crypto = require("crypto");
const config = require("../../config/config");
const { RunStatus, SourceStatus, IdPrefix } = require("../../config/enums");
const CrawlJob = require("../../models/knowledge/crawlJob");
const KnowledgeSource = require("../../models/knowledge/knowledgeSource");
const generalFunctions = require("../utilFunctions/generalFunctions");

// §1.3 — the crawl worker.
//
// Crawling used to run inline in the request that created the source. Two things
// were wrong with that: it held a request thread open for the length of a
// hundred-page crawl, and a deploy mid-crawl lost the work with no record that
// it had been attempted.
//
// This is a poller over the CrawlJob collection. See the model for why it is
// not BullMQ and what stays the same if it becomes BullMQ later.
//
// One worker instance, one job at a time, by design: crawling is network-bound
// on someone else's server, and running four concurrent crawls per instance is
// how a knowledge sync becomes a denial of service against a customer's own
// marketing site.

// Identifies which instance holds a lease. Not for correctness — the lease is —
// but so a stuck job's log line says where to look.
const WORKER_ID = `${process.pid}-${crypto.randomBytes(3).toString("hex")}`;

class CrawlWorker {
    constructor() {
        this.timer = null;
        this.running = false;
        this.stopped = false;
    }

    // ── Public Functions ─────────────────────────────────────────────

    start() {
        if (this.timer) return { success: true, alreadyRunning: true };
        console.log("CrawlWorker:start: worker:", WORKER_ID, "interval:", config.CRAWL_WORKER_INTERVAL_MS);
        this.stopped = false;
        this.timer = setInterval(() => {
            this.tick().catch((error) => {
                console.error("CrawlWorker:start: tick failed");
                console.error(error);
                generalFunctions.captureException(error);
            });
        }, config.CRAWL_WORKER_INTERVAL_MS);
        // Do not hold the process open. Without this a `node --test` run that
        // requires server.js never exits.
        if (this.timer.unref) this.timer.unref();
        return { success: true, alreadyRunning: false };
    }

    stop() {
        console.log("CrawlWorker:stop");
        this.stopped = true;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        return { success: true };
    }

    // Enqueue. Returns the existing job rather than erroring when one is already
    // running — clicking "sync" twice should be idempotent, not a 409 the
    // customer has to interpret.
    async enqueue({ orgId, sourceId }) {
        console.log("CrawlWorker:enqueue: sourceId:", sourceId);
        try {
            const existing = await CrawlJob.findOne({
                orgId,
                sourceId,
                status: { $in: [RunStatus.QUEUED, RunStatus.RUNNING] },
            }).lean();
            if (existing) {
                return { success: true, crawlJobId: existing.crawlJobId, alreadyQueued: true };
            }

            const job = await CrawlJob.create({
                orgId,
                crawlJobId: generalFunctions.generateId(IdPrefix.CRAWL_JOB),
                sourceId,
                status: RunStatus.QUEUED,
            });

            await KnowledgeSource.updateOne({ orgId, sourceId }, { $set: { status: SourceStatus.PENDING, lastError: null } });
            return { success: true, crawlJobId: job.crawlJobId, alreadyQueued: false };
        } catch (error) {
            // The partial unique index rejects a concurrent second enqueue.
            // That is the index doing its job, not a failure worth surfacing.
            if (error && error.code === 11000) {
                const existing = await CrawlJob.findOne({ orgId, sourceId, status: { $in: [RunStatus.QUEUED, RunStatus.RUNNING] } }).lean();
                return { success: true, crawlJobId: existing ? existing.crawlJobId : null, alreadyQueued: true };
            }
            console.error("CrawlWorker:enqueue: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { success: false };
        }
    }

    async cancel({ orgId, crawlJobId }) {
        console.log("CrawlWorker:cancel: crawlJobId:", crawlJobId);
        try {
            const job = await CrawlJob.findOne({ orgId, crawlJobId });
            if (!job) return { status: 404, json: { success: false, error: "Crawl job not found" } };

            if (job.status === RunStatus.QUEUED) {
                // Never started, so it can just be dropped.
                job.status = RunStatus.FAILED;
                job.lastError = "Cancelled before it started";
                job.finishedAt = new Date();
                await job.save();
                await KnowledgeSource.updateOne(
                    { orgId, sourceId: job.sourceId },
                    { $set: { status: SourceStatus.FAILED, lastError: "Crawl cancelled" } }
                );
                return { status: 200, json: { success: true, data: { cancelled: true, immediate: true } } };
            }

            // Running: flag it and let the loop notice between pages. Killing it
            // mid-embedding would leave the source with half its chunks replaced.
            job.cancelRequested = true;
            await job.save();
            return {
                status: 200,
                json: { success: true, data: { cancelled: true, immediate: false }, note: "The crawl will stop after the current page." },
            };
        } catch (error) {
            console.error("CrawlWorker:cancel: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async getStatus({ orgId, sourceId }) {
        console.log("CrawlWorker:getStatus: sourceId:", sourceId);
        try {
            const job = await CrawlJob.findOne({ orgId, sourceId }).sort({ createdAt: -1 }).lean();
            if (!job) return { status: 200, json: { success: true, data: null } };

            const copy = { ...job };
            delete copy._id;
            delete copy.__v;
            return { status: 200, json: { success: true, data: copy } };
        } catch (error) {
            console.error("CrawlWorker:getStatus: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // One poll. Exposed so the tests can drive the worker deterministically
    // rather than sleeping and hoping.
    async tick() {
        if (this.running || this.stopped) return { success: true, skipped: true };
        this.running = true;
        try {
            const job = await this._claim();
            if (!job) return { success: true, claimed: false };

            console.log("CrawlWorker:tick: claimed job:", job.crawlJobId, "source:", job.sourceId);
            await this._process({ job });
            return { success: true, claimed: true, crawlJobId: job.crawlJobId };
        } catch (error) {
            console.error("CrawlWorker:tick: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { success: false };
        } finally {
            this.running = false;
        }
    }

    // ── Private Helper Functions ─────────────────────────────────────

    // findOneAndUpdate is the whole concurrency story: the filter and the write
    // happen in one atomic operation, so two instances cannot both claim the
    // same job. A find-then-update would let them.
    async _claim() {
        const now = new Date();
        return CrawlJob.findOneAndUpdate(
            {
                deadLetteredAt: null,
                $or: [
                    { status: RunStatus.QUEUED },
                    // An expired lease means the instance holding it died.
                    { status: RunStatus.RUNNING, leaseExpiresAt: { $lt: now } },
                ],
            },
            {
                $set: {
                    status: RunStatus.RUNNING,
                    leaseExpiresAt: new Date(now.getTime() + config.CRAWL_LEASE_MS),
                    claimedBy: WORKER_ID,
                    startedAt: now,
                },
                $inc: { attempts: 1 },
            },
            { sort: { createdAt: 1 }, new: true }
        );
    }

    async _process({ job }) {
        // Required lazily. knowledgeFunctions requires this module for enqueue,
        // and requiring it back at module load would be a cycle that resolves to
        // an empty object.
        const knowledgeFunctions = require("./knowledgeFunctions");

        try {
            const source = await KnowledgeSource.findOne({ orgId: job.orgId, sourceId: job.sourceId });
            if (!source) {
                await this._finish({ job, status: RunStatus.FAILED, error: "The source was deleted before the crawl ran" });
                return;
            }

            const result = await knowledgeFunctions.ingestForJob({ source, job });

            if (job.cancelRequested) {
                await this._finish({ job, status: RunStatus.FAILED, error: "Cancelled" });
                await KnowledgeSource.updateOne(
                    { orgId: job.orgId, sourceId: job.sourceId },
                    { $set: { status: SourceStatus.FAILED, lastError: "Crawl cancelled" } }
                );
                return;
            }

            if (result.success) {
                await this._finish({ job, status: RunStatus.COMPLETED, error: null });
                return;
            }

            await this._retryOrDeadLetter({ job, error: result.error });
        } catch (error) {
            console.error("CrawlWorker:_process: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            await this._retryOrDeadLetter({ job, error: error.message });
        }
    }

    // Backoff by requeueing with a lease in the future rather than sleeping: a
    // worker that sleeps to back off is a worker not doing other jobs.
    async _retryOrDeadLetter({ job, error }) {
        const fresh = await CrawlJob.findOne({ crawlJobId: job.crawlJobId });
        if (!fresh) return;

        if (fresh.attempts >= config.CRAWL_MAX_ATTEMPTS) {
            console.error("CrawlWorker:_retryOrDeadLetter: dead-lettering", fresh.crawlJobId, "after", fresh.attempts, "attempts");
            fresh.status = RunStatus.FAILED;
            fresh.deadLetteredAt = new Date();
            fresh.finishedAt = new Date();
            fresh.lastError = error || "Crawl failed";
            await fresh.save();
            await KnowledgeSource.updateOne(
                { orgId: fresh.orgId, sourceId: fresh.sourceId },
                { $set: { status: SourceStatus.FAILED, lastError: fresh.lastError } }
            );
            return;
        }

        const backoffMs = Math.min(15 * 60_000, 30_000 * Math.pow(2, fresh.attempts - 1));
        fresh.status = RunStatus.QUEUED;
        fresh.claimedBy = null;
        // Held down for the backoff window: _claim only takes QUEUED jobs or
        // expired leases, and a future lease on a queued job is not re-claimed
        // until it passes.
        fresh.leaseExpiresAt = new Date(Date.now() + backoffMs);
        fresh.lastError = error || "Crawl failed";
        await fresh.save();
        console.log("CrawlWorker:_retryOrDeadLetter: retry", fresh.crawlJobId, "in", Math.round(backoffMs / 1000), "s");
    }

    async _finish({ job, status, error }) {
        await CrawlJob.updateOne(
            { crawlJobId: job.crawlJobId },
            {
                $set: {
                    status,
                    finishedAt: new Date(),
                    leaseExpiresAt: null,
                    claimedBy: null,
                    lastError: error || null,
                },
            }
        );
    }
}

module.exports = new CrawlWorker();
module.exports.WORKER_ID = WORKER_ID;
