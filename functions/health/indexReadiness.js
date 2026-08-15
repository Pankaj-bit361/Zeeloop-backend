const generalFunctions = require("../utilFunctions/generalFunctions");

// Several correctness properties in this codebase are enforced by a unique
// index rather than by application code, on purpose: insert-and-catch-11000 has
// no race, while find-then-insert has a window where two workers both see
// nothing and both write.
//
// That reasoning has one dependency nobody states out loud — the index has to
// exist. Mongoose builds indexes in the background after connecting, so on a
// FRESH database there is a window at boot where the insert succeeds twice and
// the guarantee quietly does not hold. On an established deployment this is
// invisible; on the first deploy, on a restored backup, or in a test against a
// new database, it is a real duplicate.
//
// So the models whose uniqueness is load-bearing are awaited at boot. Model.init()
// resolves once that model's indexes are built.
//
// Deliberately NOT every model: waiting on indexes that are merely for query
// speed would add startup latency for no correctness benefit. The list is
// exactly the constraints something depends on.

const CRITICAL_MODELS = [
    // Webhook idempotency — the same provider event must never double-apply.
    { path: "../../models/billing/webhookEvent", why: "billing webhook idempotency" },
    // Transactional email — a cron that fires twice must not send twice.
    { path: "../../models/org/emailLog", why: "email send idempotency" },
    // Review queue — one conversation is flagged at most once per monitor.
    { path: "../../models/eval/monitor", why: "review queue de-duplication", key: "ConversationReview" },
    // One live crawl per source, so a second "sync now" click cannot start a
    // second crawl of the same site.
    { path: "../../models/knowledge/crawlJob", why: "one live crawl job per source" },
    // Blocklist entries are unique per (org, type, value).
    { path: "../../models/org/expansion", why: "blocklist uniqueness", key: "BlocklistEntry" },
    // Install pings are upserted per (org, origin).
    { path: "../../models/org/widgetPing", why: "widget install ping upsert" },
];

const READY_TIMEOUT_MS = 15_000;

class IndexReadiness {
    // ── Public Functions ─────────────────────────────────────────────

    // Returns { success, built, failed } and never throws. A backend that
    // refused to start because an index was slow would be trading a rare
    // duplicate for a guaranteed outage.
    async ensureCriticalIndexes() {
        console.log("IndexReadiness:ensureCriticalIndexes: waiting on", CRITICAL_MODELS.length, "models");
        const built = [];
        const failed = [];

        for (const entry of CRITICAL_MODELS) {
            try {
                const exported = require(entry.path);
                const Model = entry.key ? exported[entry.key] : exported;
                if (!Model || typeof Model.init !== "function") {
                    failed.push({ why: entry.why, error: "not a mongoose model" });
                    continue;
                }

                await Promise.race([
                    Model.init(),
                    new Promise((resolve, reject) =>
                        setTimeout(() => reject(new Error(`index build timed out after ${READY_TIMEOUT_MS}ms`)), READY_TIMEOUT_MS)
                    ),
                ]);
                built.push(entry.why);
            } catch (error) {
                console.error("IndexReadiness:ensureCriticalIndexes: failed for", entry.why, "—", error.message);
                generalFunctions.captureException(error);
                failed.push({ why: entry.why, error: error.message });
            }
        }

        if (failed.length > 0) {
            // Loud, because until these exist the idempotency guarantees they
            // back are not actually in force.
            console.error("");
            console.error("  ┌───────────────────────────────────────────────────────────────┐");
            console.error("  │  SOME UNIQUENESS INDEXES ARE NOT READY                       │");
            console.error("  └───────────────────────────────────────────────────────────────┘");
            for (const entry of failed) {
                console.error(`  ${entry.why}: ${entry.error}`);
            }
            console.error("");
            console.error("  Until these build, the de-duplication they enforce is not active.");
            console.error("  Duplicate emails, webhook double-applies or repeat crawl jobs are");
            console.error("  possible in this window.");
            console.error("");
        } else {
            console.log("IndexReadiness:ensureCriticalIndexes: all uniqueness constraints active");
        }

        return { success: failed.length === 0, built, failed };
    }
}

module.exports = new IndexReadiness();
module.exports.CRITICAL_MODELS = CRITICAL_MODELS;
