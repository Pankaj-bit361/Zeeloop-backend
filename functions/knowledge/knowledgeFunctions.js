const crypto = require("crypto");
const KnowledgeSource = require("../../models/knowledge/knowledgeSource");
const Chunk = require("../../models/knowledge/chunk");
const config = require("../../config/config");
const { SourceType, SourceStatus, IdPrefix } = require("../../config/enums");
const generalFunctions = require("../utilFunctions/generalFunctions");
const llmFunctions = require("../utilFunctions/llmFunctions");
const sitemapFunctions = require("./sitemapFunctions");
const extractionFunctions = require("./extractionFunctions");

// Cap on pages pulled from one sitemap in a single inline ingest. Higher than
// this needs the crawl worker (§1.3), which needs a queue this stack does not
// have yet.
const MAX_SITEMAP_PAGES = 200;

class KnowledgeFunctions {
    async listSources({ orgId }) {
        console.log("KnowledgeFunctions:listSources: orgId:", orgId);
        try {
            if (!orgId) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId" } };
            }
            const sources = await KnowledgeSource.find({ orgId }).sort({ createdAt: -1 });
            return { status: 200, json: { success: true, data: sources } };
        } catch (error) {
            console.error("KnowledgeFunctions:listSources: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async createSource({ orgId, type, name, url, content, includedUrls, contentSelector }) {
        console.log("KnowledgeFunctions:createSource: orgId:", orgId, "type:", type);
        try {
            if (!orgId || !type || !name) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId, type and name" } };
            }
            if (!Object.values(SourceType).includes(type)) {
                return { status: 400, json: { success: false, error: `type must be one of ${Object.values(SourceType).join(", ")}` } };
            }
            if ((type === SourceType.URL || type === SourceType.SITEMAP) && !url) {
                return { status: 400, json: { success: false, error: "url is required for URL and SITEMAP sources" } };
            }
            if (type === SourceType.SNIPPET && !content) {
                return { status: 400, json: { success: false, error: "content is required for SNIPPET sources" } };
            }

            const source = await KnowledgeSource.create({
                orgId,
                sourceId: generalFunctions.generateId(IdPrefix.KNOWLEDGE_SOURCE),
                type,
                name,
                url,
                content,
                includedUrls: Array.isArray(includedUrls) ? includedUrls : [],
                contentSelector: contentSelector || "",
                status: SourceStatus.PENDING,
            });

            // §1.3 — a SITEMAP crawl goes to the worker; everything else is one
            // fetch or no fetch at all and completes faster than the round trip
            // to a queue. Queueing a snippet would mean the customer watches a
            // spinner for something that took four milliseconds.
            if (type === SourceType.SITEMAP) {
                const crawlWorker = require("./crawlWorker");
                const queued = await crawlWorker.enqueue({ orgId, sourceId: source.sourceId });
                const fresh = await KnowledgeSource.findOne({ orgId, sourceId: source.sourceId });
                return {
                    status: 201,
                    json: { success: true, data: fresh, crawlJobId: queued.crawlJobId, queued: true },
                };
            }

            const ingest = await this._ingestSource({ source });
            if (!ingest.success && ingest.notImplemented) {
                return {
                    status: 501,
                    json: { success: false, error: ingest.error, data: source },
                };
            }

            const fresh = await KnowledgeSource.findOne({ orgId, sourceId: source.sourceId });
            return { status: 201, json: { success: true, data: fresh } };
        } catch (error) {
            console.error("KnowledgeFunctions:createSource: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // §1.2 — FILE upload. Extraction happens here, at upload time, and the text
    // is stored on the source; the original bytes are not kept. A support
    // workspace does not need to re-download its own PDF, and storing customer
    // documents verbatim is a data-handling obligation with no matching benefit.
    //
    // `sourceId` supplied means a re-upload: it REPLACES that source rather than
    // creating a second one, which is what §1.2 asks for and what stops a
    // workspace ending up with "Handbook v3", "Handbook v3 (1)" and
    // "Handbook v3 final" all in the retrieval index at once.
    async uploadFile({ orgId, sourceId, filename, mimeType, base64, name }) {
        console.log("KnowledgeFunctions:uploadFile: orgId:", orgId, "filename:", filename);
        try {
            if (!orgId || !filename || !base64) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass filename and file contents" } };
            }

            const fileFunctions = require("./fileFunctions");

            const validation = fileFunctions.validate({ filename, mimeType, base64 });
            if (!validation.success) {
                return { status: 400, json: { success: false, error: validation.error } };
            }

            const extracted = fileFunctions.extract({ filename, mimeType, base64 });
            if (!extracted.success) {
                return { status: 400, json: { success: false, error: extracted.error } };
            }

            let source;
            if (sourceId) {
                source = await KnowledgeSource.findOne({ orgId, sourceId, type: SourceType.FILE });
                if (!source) return { status: 404, json: { success: false, error: "File source not found" } };
                source.name = name || source.name;
                source.content = extracted.text;
                // documentHashes is deliberately NOT cleared here. It is the
                // record of which document keys this source currently owns, and
                // change detection uses exactly that to work out what to delete:
                // the old filename is in the previous hashes, absent from the
                // new ones, and therefore removed — which is what takes its
                // chunks with it.
                //
                // Clearing it looks like the cautious choice and is the opposite:
                // with no previous hashes there is nothing to diff against, so
                // the old file's chunks are never identified as stale and both
                // versions end up in the retrieval index at once.
            } else {
                source = await KnowledgeSource.create({
                    orgId,
                    sourceId: generalFunctions.generateId(IdPrefix.KNOWLEDGE_SOURCE),
                    type: SourceType.FILE,
                    name: name || extracted.title || filename,
                    content: extracted.text,
                    status: SourceStatus.PENDING,
                });
            }

            source.file = {
                filename,
                mimeType: mimeType || null,
                bytes: validation.bytes,
                extractionQuality: extracted.extractionQuality,
            };
            await source.save();

            const ingest = await this._ingestSource({ source });
            if (!ingest.success) {
                return { status: 500, json: { success: false, error: ingest.error } };
            }

            const fresh = await KnowledgeSource.findOne({ orgId, sourceId: source.sourceId });
            return {
                status: sourceId ? 200 : 201,
                json: {
                    success: true,
                    data: fresh,
                    // Surfaced, not buried. A PDF that extracted partially will
                    // retrieve badly, and the customer should learn that now
                    // rather than from a bad answer next week.
                    extractionQuality: extracted.extractionQuality,
                    note: extracted.note || null,
                },
            };
        } catch (error) {
            console.error("KnowledgeFunctions:uploadFile: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // §1.4 — sync schedule per source.
    async updateSchedule({ orgId, sourceId, syncSchedule }) {
        console.log("KnowledgeFunctions:updateSchedule: sourceId:", sourceId, "schedule:", syncSchedule);
        try {
            if (!["MANUAL", "DAILY", "WEEKLY"].includes(syncSchedule)) {
                return { status: 400, json: { success: false, error: "syncSchedule must be MANUAL, DAILY or WEEKLY" } };
            }
            const source = await KnowledgeSource.findOne({ orgId, sourceId });
            if (!source) return { status: 404, json: { success: false, error: "Source not found" } };

            source.syncSchedule = syncSchedule;
            source.nextSyncAt = this._nextSyncAt({ schedule: syncSchedule });
            await source.save();

            return { status: 200, json: { success: true, data: { syncSchedule, nextSyncAt: source.nextSyncAt } } };
        } catch (error) {
            console.error("KnowledgeFunctions:updateSchedule: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // Cron entry point for scheduled re-syncs. Queues rather than crawling
    // inline, so a hundred due sources do not all run at once on one tick.
    async enqueueScheduledSyncs() {
        console.log("KnowledgeFunctions:enqueueScheduledSyncs");
        try {
            const due = await KnowledgeSource.find({
                syncSchedule: { $in: ["DAILY", "WEEKLY"] },
                nextSyncAt: { $lte: new Date() },
            })
                .select("orgId sourceId")
                .limit(200)
                .lean();

            const crawlWorker = require("./crawlWorker");
            let queued = 0;
            for (const source of due) {
                const result = await crawlWorker.enqueue({ orgId: source.orgId, sourceId: source.sourceId });
                if (result.success && !result.alreadyQueued) queued += 1;
                // Pushed forward whether or not it queued, so a source whose job
                // is already running does not get re-examined every minute.
                await KnowledgeSource.updateOne(
                    { orgId: source.orgId, sourceId: source.sourceId },
                    { $set: { nextSyncAt: new Date(Date.now() + 3600_000) } }
                );
            }

            console.log("KnowledgeFunctions:enqueueScheduledSyncs: queued:", queued, "of", due.length, "due");
            return { success: true, queued };
        } catch (error) {
            console.error("KnowledgeFunctions:enqueueScheduledSyncs: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { success: false, queued: 0 };
        }
    }

    async deleteSource({ orgId, sourceId }) {
        console.log("KnowledgeFunctions:deleteSource: orgId:", orgId, "sourceId:", sourceId);
        try {
            if (!orgId || !sourceId) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId and sourceId" } };
            }
            const source = await KnowledgeSource.findOneAndDelete({ orgId, sourceId });
            if (!source) {
                return { status: 404, json: { success: false, error: "Source not found" } };
            }
            await Chunk.deleteMany({ orgId, sourceId });
            return { status: 200, json: { success: true } };
        } catch (error) {
            console.error("KnowledgeFunctions:deleteSource: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async resyncSource({ orgId, sourceId }) {
        console.log("KnowledgeFunctions:resyncSource: orgId:", orgId, "sourceId:", sourceId);
        try {
            if (!orgId || !sourceId) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId and sourceId" } };
            }
            const source = await KnowledgeSource.findOne({ orgId, sourceId });
            if (!source) {
                return { status: 404, json: { success: false, error: "Source not found" } };
            }

            const ingest = await this._ingestSource({ source });
            if (!ingest.success && ingest.notImplemented) {
                return { status: 501, json: { success: false, error: ingest.error } };
            }

            const fresh = await KnowledgeSource.findOne({ orgId, sourceId });
            return { status: 200, json: { success: true, data: fresh } };
        } catch (error) {
            console.error("KnowledgeFunctions:resyncSource: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // Chunk browser — embedding is select: false and never leaves the backend.
    async listChunks({ orgId, sourceId, page, limit }) {
        console.log("KnowledgeFunctions:listChunks: orgId:", orgId);
        try {
            if (!orgId) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId" } };
            }
            const pageNum = Math.max(parseInt(page, 10) || 1, 1);
            const pageSize = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
            const filter = { orgId, ...(sourceId && { sourceId }) };
            const [chunks, total] = await Promise.all([
                Chunk.find(filter)
                    .sort({ sourceId: 1, position: 1 })
                    .skip((pageNum - 1) * pageSize)
                    .limit(pageSize),
                Chunk.countDocuments(filter),
            ]);
            return { status: 200, json: { success: true, data: chunks, total, page: pageNum, limit: pageSize } };
        } catch (error) {
            console.error("KnowledgeFunctions:listChunks: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // Preview step for SITEMAP sources (§1.1). Nothing is fetched in full or
    // embedded here — the customer sees the URL list with the heuristics'
    // verdicts and toggles before anything is ingested, because a workspace
    // that discovers we crawled its careers page discovers it in the bill.
    async discoverSitemap({ orgId, url }) {
        console.log("KnowledgeFunctions:discoverSitemap: orgId:", orgId, "url:", url);
        try {
            if (!orgId || !url) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId and url" } };
            }

            const discovered = await sitemapFunctions.discover({ url, maxUrls: MAX_SITEMAP_PAGES });
            if (!discovered.success) {
                return { status: 422, json: { success: false, error: discovered.error } };
            }

            const included = discovered.urls.filter((entry) => entry.included);
            return {
                status: 200,
                json: {
                    success: true,
                    data: {
                        source: discovered.source,
                        total: discovered.urls.length,
                        includedCount: included.length,
                        excludedCount: discovered.urls.length - included.length,
                        cap: MAX_SITEMAP_PAGES,
                        urls: discovered.urls,
                    },
                },
            };
        } catch (error) {
            console.error("KnowledgeFunctions:discoverSitemap: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // Private Helper Functions

    // Fetch → chunk → embed → store. Returns { success } or { success: false, notImplemented }.
    // Called by the crawl worker (§1.3). Same ingest, plus progress reporting
    // onto the job document and a cancellation check between phases.
    async ingestForJob({ source, job }) {
        console.log("KnowledgeFunctions:ingestForJob: sourceId:", source.sourceId, "jobId:", job.crawlJobId);
        return this._ingestSource({ source, job });
    }

    async _ingestSource({ source, job }) {
        try {
            await KnowledgeSource.updateOne(
                { orgId: source.orgId, sourceId: source.sourceId },
                { status: SourceStatus.CRAWLING, lastError: null }
            );

            const fetched = await this._fetchDocuments({ source, job });
            if (!fetched.success) {
                await KnowledgeSource.updateOne(
                    { orgId: source.orgId, sourceId: source.sourceId },
                    { status: SourceStatus.FAILED, lastError: fetched.error }
                );
                return fetched;
            }

            await KnowledgeSource.updateOne(
                { orgId: source.orgId, sourceId: source.sourceId },
                { status: SourceStatus.EMBEDDING }
            );

            // §1.4 — change detection. A document whose text hashes to what it
            // hashed to last sync keeps the chunks it already has, and is never
            // sent to the embedding provider again. On a daily re-sync of a
            // hundred-page docs site where two pages changed, this is the
            // difference between 400 embedding calls and 8.
            const previousHashes = source.documentHashes || {};
            const currentHashes = {};
            const changedDocuments = [];
            const diff = { added: 0, updated: 0, removed: 0, unchanged: 0 };

            for (const document of fetched.documents) {
                const key = document.url || document.title || "default";
                const hash = crypto.createHash("sha256").update(document.text || "").digest("hex");
                currentHashes[key] = hash;

                if (previousHashes[key] === hash) {
                    diff.unchanged += 1;
                    continue;
                }
                if (previousHashes[key]) diff.updated += 1;
                else diff.added += 1;
                changedDocuments.push({ ...document, _key: key });
            }

            // A key that was there last time and is not now: the page was
            // deleted or dropped out of the sitemap. Its chunks go, rather than
            // being orphaned in the index where the agent would keep citing a
            // page that no longer exists.
            const removedKeys = Object.keys(previousHashes).filter((key) => currentHashes[key] === undefined);
            diff.removed = removedKeys.length;

            const unchangedKeys = Object.keys(currentHashes).filter((key) => previousHashes[key] === currentHashes[key]);

            const chunks = [];
            for (const document of changedDocuments) {
                chunks.push(...this._chunkDocument({ source, document }));
            }

            const embedded = [];
            for (let i = 0; i < chunks.length; i += 64) {
                if (job && (await this._cancelRequested({ job }))) {
                    console.log("KnowledgeFunctions:_ingestSource: cancelled mid-embedding");
                    return { success: false, error: "Cancelled", cancelled: true };
                }
                const batch = chunks.slice(i, i + 64);
                const embeddings = await llmFunctions.embed({ texts: batch.map((chunk) => chunk.text) });
                batch.forEach((chunk, index) => {
                    embedded.push({ ...chunk, embedding: embeddings[index] });
                });
                await this._reportProgress({ job, embedded: embedded.length });
            }

            // Only the changed and removed documents' chunks are replaced.
            // Deleting everything and reinserting would throw away the unchanged
            // chunks this whole mechanism exists to preserve.
            const staleKeys = [...changedDocuments.map((document) => document._key), ...removedKeys];
            if (staleKeys.length > 0) {
                await Chunk.deleteMany({ orgId: source.orgId, sourceId: source.sourceId, documentKey: { $in: staleKeys } });
            }
            // Chunks written before documentKey existed have none, so a first
            // sync after this shipped clears them and re-embeds once.
            if (unchangedKeys.length === 0) {
                await Chunk.deleteMany({ orgId: source.orgId, sourceId: source.sourceId, documentKey: null });
            }
            if (embedded.length > 0) {
                await Chunk.insertMany(embedded);
            }

            const chunkCount = await Chunk.countDocuments({ orgId: source.orgId, sourceId: source.sourceId });

            await KnowledgeSource.updateOne(
                { orgId: source.orgId, sourceId: source.sourceId },
                {
                    status: SourceStatus.READY,
                    chunkCount,
                    lastSyncedAt: new Date(),
                    documentHashes: currentHashes,
                    lastDiff: diff,
                    nextSyncAt: this._nextSyncAt({ schedule: source.syncSchedule }),
                }
            );

            console.log(
                "KnowledgeFunctions:_ingestSource: diff — added:", diff.added,
                "updated:", diff.updated,
                "removed:", diff.removed,
                "unchanged:", diff.unchanged
            );
            return { success: true, diff, chunkCount };
        } catch (error) {
            console.error("KnowledgeFunctions:_ingestSource: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            await KnowledgeSource.updateOne(
                { orgId: source.orgId, sourceId: source.sourceId },
                { status: SourceStatus.FAILED, lastError: error.message }
            );
            return { success: false, error: error.message };
        }
    }

    async _cancelRequested({ job }) {
        try {
            const CrawlJob = require("../../models/knowledge/crawlJob");
            const fresh = await CrawlJob.findOne({ crawlJobId: job.crawlJobId }).select("cancelRequested").lean();
            return !!(fresh && fresh.cancelRequested);
        } catch (error) {
            return false;
        }
    }

    async _reportProgress({ job, fetched, discovered, embedded, failed, skipped }) {
        if (!job) return;
        try {
            const CrawlJob = require("../../models/knowledge/crawlJob");
            const update = {};
            if (discovered !== undefined) update["progress.discovered"] = discovered;
            if (fetched !== undefined) update["progress.fetched"] = fetched;
            if (embedded !== undefined) update["progress.embedded"] = embedded;
            if (failed !== undefined) update["progress.failed"] = failed;
            if (skipped !== undefined) update["progress.skipped"] = skipped;
            if (Object.keys(update).length === 0) return;
            // The lease is extended on every progress report, so a slow but
            // healthy crawl is not stolen by another worker halfway through.
            update.leaseExpiresAt = new Date(Date.now() + config.CRAWL_LEASE_MS);
            await CrawlJob.updateOne({ crawlJobId: job.crawlJobId }, { $set: update });
        } catch (error) {
            console.error("KnowledgeFunctions:_reportProgress: Catch block");
            console.error(error.message);
        }
    }

    _nextSyncAt({ schedule }) {
        if (schedule === "DAILY") return new Date(Date.now() + 24 * 3600_000);
        if (schedule === "WEEKLY") return new Date(Date.now() + 7 * 24 * 3600_000);
        return null;
    }

    // SNIPPET, URL, SITEMAP and FILE.
    async _fetchDocuments({ source, job }) {
        if (source.type === SourceType.SNIPPET) {
            return { success: true, documents: [{ title: source.name, text: source.content, url: null }] };
        }

        // §1.2 — FILE. The extracted text is stored on the source at upload
        // time, so a re-sync re-chunks and re-embeds without needing the
        // original bytes kept around. That is also what makes a re-upload
        // replace rather than duplicate: it writes over `content` on the same
        // source document.
        if (source.type === SourceType.FILE) {
            if (!source.content || !source.content.trim()) {
                return { success: false, error: "This file source has no extracted text. Re-upload the file." };
            }
            return {
                success: true,
                documents: [{ title: source.name, text: source.content, url: (source.file && source.file.filename) || source.name }],
            };
        }

        if (source.type === SourceType.URL) {
            const fetched = await this._fetchPage({
                url: source.url,
                title: source.name,
                contentSelector: source.contentSelector,
            });
            if (!fetched.success) return fetched;
            return { success: true, documents: [{ ...fetched.document, url: source.url }] };
        }

        if (source.type === SourceType.SITEMAP) {
            const discovered = await sitemapFunctions.discover({ url: source.url, maxUrls: MAX_SITEMAP_PAGES });
            if (!discovered.success) {
                return { success: false, error: discovered.error };
            }

            // Only pages the heuristics kept, plus anything the customer
            // explicitly re-included on the source. Crawling a careers page is
            // something they would discover in their bill.
            const overrides = new Set(source.includedUrls || []);
            const targets = discovered.urls.filter((entry) => entry.included || overrides.has(entry.url));
            if (targets.length === 0) {
                return { success: false, error: "The sitemap contained no pages worth ingesting" };
            }

            // Sequential rather than Promise.all: this runs inline in a request
            // today, and firing hundreds of concurrent fetches at a customer's
            // site is how an ingestion becomes an outage on their end.
            const documents = [];
            const failures = [];
            await this._reportProgress({ job, discovered: targets.length });
            for (const target of targets) {
                if (job && (await this._cancelRequested({ job }))) {
                    console.log("KnowledgeFunctions:_fetchDocuments: cancelled mid-crawl");
                    return { success: false, error: "Cancelled", cancelled: true };
                }
                const fetched = await this._fetchPage({
                    url: target.url,
                    title: target.url,
                    contentSelector: source.contentSelector,
                });
                if (fetched.success && fetched.document.text.trim().length > 0) {
                    documents.push({ ...fetched.document, url: target.url });
                } else {
                    failures.push(target.url);
                }
                await this._reportProgress({ job, fetched: documents.length, failed: failures.length });
            }

            if (documents.length === 0) {
                return { success: false, error: `Fetched ${targets.length} pages, none had readable content` };
            }
            if (failures.length > 0) {
                console.log("KnowledgeFunctions:_fetchDocuments: sitemap pages skipped:", failures.length);
            }
            return { success: true, documents };
        }

        return {
            success: false,
            notImplemented: true,
            error: `${source.type} ingestion is not implemented yet. Supported: SNIPPET, URL, SITEMAP.`,
        };
    }

    async _fetchPage({ url, title, contentSelector }) {
        try {
            const response = await fetch(url, {
                redirect: "follow",
                headers: { "user-agent": "ZealoopBot/1.0 (+https://zealoop.com/docs/knowledge)" },
            });
            if (!response.ok) {
                return { success: false, error: `Fetch failed with status ${response.status}` };
            }
            const html = await response.text();
            const extracted = extractionFunctions.extractMainContent(html, {
                selectors: contentSelector ? { include: contentSelector } : null,
            });
            return {
                success: true,
                document: { title: extracted.title || title, text: extracted.text },
            };
        } catch (error) {
            return { success: false, error: `Fetch failed: ${error.message}` };
        }
    }

    // Heading-aware chunking: split on markdown-style headings so headingPath is
    // carried into every chunk, then pack sections to ~600 tokens with 15% overlap.
    _chunkDocument({ source, document }) {
        const sections = this._splitByHeadings(document.text, document.title);
        const chunks = [];
        let position = 0;

        for (const section of sections) {
            const pieces = this._packText(section.text);
            for (const piece of pieces) {
                chunks.push({
                    orgId: source.orgId,
                    chunkId: generalFunctions.generateId(IdPrefix.CHUNK),
                    sourceId: source.sourceId,
                    text: piece,
                    headingPath: section.headingPath,
                    tokenCount: generalFunctions.estimateTokens(piece),
                    position: position++,
                    // Set by the caller for hashed re-sync (§1.4); falls back to
                    // the document's own url/title so a chunk always knows which
                    // page it came from.
                    documentKey: document._key || document.url || document.title || null,
                });
            }
        }
        return chunks;
    }

    _splitByHeadings(text, rootTitle) {
        const lines = String(text).split("\n");
        const sections = [];
        let headingStack = [rootTitle];
        let buffer = [];

        const flush = () => {
            const body = buffer.join("\n").trim();
            if (body) {
                sections.push({ headingPath: [...headingStack], text: body });
            }
            buffer = [];
        };

        for (const line of lines) {
            const match = line.match(/^(#{1,4})\s+(.*)$/);
            if (match) {
                flush();
                const level = match[1].length;
                headingStack = [...headingStack.slice(0, level), match[2].trim()];
            } else {
                buffer.push(line);
            }
        }
        flush();
        return sections.length > 0 ? sections : [{ headingPath: [rootTitle], text: String(text).trim() }];
    }

    _packText(text) {
        const targetChars = config.CHUNK_TARGET_TOKENS * 4;
        const overlapChars = Math.floor(targetChars * config.CHUNK_OVERLAP_RATIO);
        if (text.length <= targetChars) {
            return [text];
        }
        const pieces = [];
        let start = 0;
        while (start < text.length) {
            let end = Math.min(start + targetChars, text.length);
            // prefer to break on a sentence or paragraph boundary near the end
            if (end < text.length) {
                const window = text.slice(start, end);
                const lastBreak = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf(". "));
                if (lastBreak > targetChars * 0.5) {
                    end = start + lastBreak + 1;
                }
            }
            pieces.push(text.slice(start, end).trim());
            if (end >= text.length) break;
            start = end - overlapChars;
        }
        return pieces.filter(Boolean);
    }

    _htmlToText(html) {
        return String(html)
            .replace(/<script[\s\S]*?<\/script>/gi, " ")
            .replace(/<style[\s\S]*?<\/style>/gi, " ")
            .replace(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi, (m, level, inner) => `\n${"#".repeat(Number(level))} ${inner.replace(/<[^>]+>/g, "").trim()}\n`)
            .replace(/<\/(p|div|li|tr|section|article)>/gi, "\n")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&#39;/g, "'")
            .replace(/&quot;/g, '"')
            .replace(/[ \t]+/g, " ")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }
}

module.exports = new KnowledgeFunctions();
