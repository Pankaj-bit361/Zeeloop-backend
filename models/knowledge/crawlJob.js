const mongoose = require("mongoose");
const { RunStatus } = require("../../config/enums");

// §1.3 — the crawl queue.
//
// The PRD says BullMQ. BullMQ needs Redis, and Redis is not in this stack — the
// backend is Express and Mongo on a single Elastic Beanstalk environment.
// Adding a broker to get a queue this shape would be a larger operational change
// than the feature itself, and it would need provisioning, monitoring and a
// second thing that can be down.
//
// So the queue is this collection and an in-process poller. What matters is that
// the SEAM is the same: a job document with a lease, an attempt counter and a
// dead-letter state. Moving to BullMQ later replaces crawlWorker's loop and
// leaves everything else — the progress UI, the retry policy, the cancel button
// — untouched.
//
// The lease is what makes it safe on more than one instance. A worker claims a
// job with a conditional update; if the instance dies mid-crawl the lease
// expires and another worker picks it up, rather than the job being stuck
// RUNNING forever.
const crawlJobSchema = new mongoose.Schema(
    {
        orgId: { type: String, required: true, index: true },
        crawlJobId: { type: String, required: true, unique: true },
        // No `index: true` here — the partial unique index below already covers
        // sourceId, and declaring both makes mongoose build two.
        sourceId: { type: String, required: true },
        status: { type: String, enum: Object.values(RunStatus), default: RunStatus.QUEUED, index: true },

        // §1.3 — per-source progress, surfaced in the source lifecycle UI.
        progress: {
            discovered: { type: Number, default: 0 },
            fetched: { type: Number, default: 0 },
            embedded: { type: Number, default: 0 },
            failed: { type: Number, default: 0 },
            skipped: { type: Number, default: 0 },
        },

        attempts: { type: Number, default: 0 },
        // Set when a worker claims the job. A job whose lease is in the past is
        // claimable again — that is the crash-recovery mechanism.
        leaseExpiresAt: { type: Date, default: null },
        claimedBy: { type: String, default: null },

        // The cancel button. Checked between pages rather than acted on
        // immediately: killing a crawl mid-embedding would leave a source with
        // half its chunks replaced.
        cancelRequested: { type: Boolean, default: false },

        lastError: { type: String, default: null },
        // Set once attempts pass CRAWL_MAX_ATTEMPTS. A dead-lettered job is not
        // retried and is visible in the UI as failed, rather than silently
        // disappearing or retrying forever.
        deadLetteredAt: { type: Date, default: null },
        startedAt: { type: Date, default: null },
        finishedAt: { type: Date, default: null },
    },
    {
        timestamps: true,
        toJSON: {
            transform: (doc, ret) => {
                delete ret._id;
                delete ret.__v;
                return ret;
            },
        },
    }
);

// The claim query: queued or expired-lease, oldest first.
crawlJobSchema.index({ status: 1, leaseExpiresAt: 1, createdAt: 1 });
// One live job per source. A second "sync now" click while one is running must
// not start a second crawl of the same site.
crawlJobSchema.index(
    { sourceId: 1 },
    { unique: true, partialFilterExpression: { status: { $in: [RunStatus.QUEUED, RunStatus.RUNNING] } } }
);

module.exports = mongoose.model("CrawlJob", crawlJobSchema);
