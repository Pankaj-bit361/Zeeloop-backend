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

            // v1: ingest runs inline. Moving crawls to a worker is an open decision (§13.5).
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
    async _ingestSource({ source }) {
        try {
            await KnowledgeSource.updateOne(
                { orgId: source.orgId, sourceId: source.sourceId },
                { status: SourceStatus.CRAWLING, lastError: null }
            );

            const fetched = await this._fetchDocuments({ source });
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

            const chunks = [];
            for (const document of fetched.documents) {
                chunks.push(...this._chunkDocument({ source, document }));
            }

            // Embed in batches; replace old chunks atomically at the end
            const embedded = [];
            for (let i = 0; i < chunks.length; i += 64) {
                const batch = chunks.slice(i, i + 64);
                const embeddings = await llmFunctions.embed({ texts: batch.map((chunk) => chunk.text) });
                batch.forEach((chunk, index) => {
                    embedded.push({ ...chunk, embedding: embeddings[index] });
                });
            }

            await Chunk.deleteMany({ orgId: source.orgId, sourceId: source.sourceId });
            if (embedded.length > 0) {
                await Chunk.insertMany(embedded);
            }

            await KnowledgeSource.updateOne(
                { orgId: source.orgId, sourceId: source.sourceId },
                { status: SourceStatus.READY, chunkCount: embedded.length, lastSyncedAt: new Date() }
            );
            return { success: true };
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

    // SNIPPET, URL and SITEMAP. FILE parsing remains unimplemented — it needs a
    // PDF/DOCX extraction dependency and an upload path, neither of which
    // exists yet.
    async _fetchDocuments({ source }) {
        if (source.type === SourceType.SNIPPET) {
            return { success: true, documents: [{ title: source.name, text: source.content }] };
        }

        if (source.type === SourceType.URL) {
            const fetched = await this._fetchPage({
                url: source.url,
                title: source.name,
                contentSelector: source.contentSelector,
            });
            if (!fetched.success) return fetched;
            return { success: true, documents: [fetched.document] };
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
            for (const target of targets) {
                const fetched = await this._fetchPage({
                    url: target.url,
                    title: target.url,
                    contentSelector: source.contentSelector,
                });
                if (fetched.success && fetched.document.text.trim().length > 0) documents.push(fetched.document);
                else failures.push(target.url);
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
