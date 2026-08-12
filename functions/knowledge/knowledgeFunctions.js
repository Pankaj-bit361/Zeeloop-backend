const KnowledgeSource = require("../../models/knowledge/knowledgeSource");
const Chunk = require("../../models/knowledge/chunk");
const config = require("../../config/config");
const { SourceType, SourceStatus, IdPrefix } = require("../../config/enums");
const generalFunctions = require("../utilFunctions/generalFunctions");
const llmFunctions = require("../utilFunctions/llmFunctions");

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
            console.log("KnowledgeFunctions:listSources: Catch block");
            console.log(error);
            generalFunctions.captureSentryException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async createSource({ orgId, type, name, url, content }) {
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
            console.log("KnowledgeFunctions:createSource: Catch block");
            console.log(error);
            generalFunctions.captureSentryException(error);
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
            console.log("KnowledgeFunctions:deleteSource: Catch block");
            console.log(error);
            generalFunctions.captureSentryException(error);
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
            console.log("KnowledgeFunctions:resyncSource: Catch block");
            console.log(error);
            generalFunctions.captureSentryException(error);
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
            console.log("KnowledgeFunctions:listChunks: Catch block");
            console.log(error);
            generalFunctions.captureSentryException(error);
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
            console.log("KnowledgeFunctions:_ingestSource: Catch block");
            console.log(error);
            generalFunctions.captureSentryException(error);
            await KnowledgeSource.updateOne(
                { orgId: source.orgId, sourceId: source.sourceId },
                { status: SourceStatus.FAILED, lastError: error.message }
            );
            return { success: false, error: error.message };
        }
    }

    // v1 handles SNIPPET and single URL. SITEMAP and FILE parsing are §13.5 —
    // deferred, returned as a clean not-implemented.
    async _fetchDocuments({ source }) {
        if (source.type === SourceType.SNIPPET) {
            return { success: true, documents: [{ title: source.name, text: source.content }] };
        }

        if (source.type === SourceType.URL) {
            const response = await fetch(source.url, { headers: { "user-agent": "ZealoopBot/1.0" } });
            if (!response.ok) {
                return { success: false, error: `Fetch failed with status ${response.status}` };
            }
            const html = await response.text();
            return { success: true, documents: [{ title: source.name, text: this._htmlToText(html) }] };
        }

        return {
            success: false,
            notImplemented: true,
            error: `${source.type} ingestion is not implemented yet. v1 supports SNIPPET and single URL sources.`,
        };
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
