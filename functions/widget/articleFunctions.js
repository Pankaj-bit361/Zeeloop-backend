const config = require("../../config/config");
const { SourceStatus } = require("../../config/enums");
const Org = require("../../models/org/org");
const Chunk = require("../../models/knowledge/chunk");
const KnowledgeSource = require("../../models/knowledge/knowledgeSource");
const generalFunctions = require("../utilFunctions/generalFunctions");
const { asId } = require("../utilFunctions/generalFunctions");
const llmFunctions = require("../utilFunctions/llmFunctions");

// §4.9 — article search and reading inside the widget.
//
// Deflection before a conversation starts. A customer who finds the answer
// themselves costs nothing, waits for nothing, and does not become a
// conversation against the workspace's quota.
//
// Backed by the SAME index the agent retrieves from, so there is no second
// corpus to keep in sync and no way for the widget to surface an article the
// agent has never heard of. Articles are knowledge sources; chunks are how they
// are found.
//
// Public endpoints, keyed by publicKey. Everything here is content the workspace
// has deliberately published to its help centre, so there is nothing to gate —
// but note what is NOT exposed: chunk text is returned only as a snippet, and
// the reader returns a source's own content, never another workspace's.

const MAX_RESULTS = 8;
const SNIPPET_CHARS = 180;

class ArticleFunctions {
    // ── Public Functions ─────────────────────────────────────────────

    async searchArticles({ publicKey, query, limit }) {
        console.log("ArticleFunctions:searchArticles: query:", query ? "set" : "empty");
        try {
            const org = await Org.findOne({ publicKey: asId(publicKey) }).select("orgId").lean();
            if (!org) return { status: 404, json: { success: false, error: "Unknown publicKey" } };

            const trimmed = String(query || "").trim();
            if (!trimmed) {
                // No query means the browse view: the workspace's articles, most
                // recent first, rather than an error.
                return await this.listArticles({ publicKey, limit });
            }

            const results = await this._hybridArticleSearch({
                orgId: org.orgId,
                query: trimmed,
                limit: Math.min(MAX_RESULTS, Number(limit) || 5),
            });

            return { status: 200, json: { success: true, data: results } };
        } catch (error) {
            console.error("ArticleFunctions:searchArticles: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async listArticles({ publicKey, limit }) {
        console.log("ArticleFunctions:listArticles");
        try {
            const org = await Org.findOne({ publicKey: asId(publicKey) }).select("orgId").lean();
            if (!org) return { status: 404, json: { success: false, error: "Unknown publicKey" } };

            const sources = await KnowledgeSource.find({ orgId: org.orgId, status: SourceStatus.READY })
                .sort({ updatedAt: -1 })
                .limit(Math.min(MAX_RESULTS, Number(limit) || 5))
                .select("sourceId title url type updatedAt")
                .lean();

            return {
                status: 200,
                json: {
                    success: true,
                    data: sources.map((source) => ({
                        sourceId: source.sourceId,
                        title: source.title || source.url || "Untitled",
                        url: source.url || null,
                        snippet: "",
                        updatedAt: source.updatedAt,
                    })),
                },
            };
        } catch (error) {
            console.error("ArticleFunctions:listArticles: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // The in-widget reader. Reassembles a source from its chunks in order,
    // rather than storing article bodies twice — the chunks ARE the article, and
    // a second copy would drift the moment a resync ran.
    async getArticle({ publicKey, sourceId }) {
        console.log("ArticleFunctions:getArticle: sourceId:", sourceId);
        try {
            const org = await Org.findOne({ publicKey: asId(publicKey) }).select("orgId").lean();
            if (!org) return { status: 404, json: { success: false, error: "Unknown publicKey" } };

            // Scoped by orgId as well as sourceId. Without the orgId a guessed
            // source id from another workspace would read fine.
            const source = await KnowledgeSource.findOne({ orgId: org.orgId, sourceId })
                .select("sourceId title url type status content")
                .lean();
            if (!source || source.status !== SourceStatus.READY) {
                return { status: 404, json: { success: false, error: "Article not found" } };
            }

            const chunks = await Chunk.find({ orgId: org.orgId, sourceId })
                .sort({ position: 1 })
                .select("text headingPath position")
                .lean();

            return {
                status: 200,
                json: {
                    success: true,
                    data: {
                        sourceId: source.sourceId,
                        title: source.title || source.url || "Untitled",
                        url: source.url || null,
                        sections: chunks.map((chunk) => ({
                            heading: (chunk.headingPath || []).join(" › "),
                            text: chunk.text,
                        })),
                    },
                },
            };
        } catch (error) {
            console.error("ArticleFunctions:getArticle: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // ── Private Helper Functions ─────────────────────────────────────

    // Vector where available, keyword otherwise. Same graceful degradation as
    // the agent's retrieval: a cluster without the Atlas indexes returns
    // keyword results rather than nothing, because an empty help centre looks
    // like a broken product.
    async _hybridArticleSearch({ orgId, query, limit }) {
        let hits = [];

        try {
            const [vector] = await llmFunctions.embed({ texts: [query] });
            hits = await Chunk.aggregate([
                {
                    $vectorSearch: {
                        index: config.VECTOR_INDEX_NAME,
                        path: "embedding",
                        queryVector: vector,
                        numCandidates: 60,
                        limit: limit * 3,
                        filter: { orgId },
                    },
                },
                { $project: { _id: 0, sourceId: 1, text: 1, headingPath: 1, score: { $meta: "vectorSearchScore" } } },
            ]);
        } catch (error) {
            console.log("ArticleFunctions:_hybridArticleSearch: vector unavailable, using keyword");
            console.error(error.message);
            const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            hits = await Chunk.find({ orgId, text: { $regex: escaped, $options: "i" } })
                .limit(limit * 3)
                .select("sourceId text headingPath")
                .lean();
        }

        // One result per article, not per chunk. A customer searching "refund"
        // wants the refund article once, not its six paragraphs as six results.
        const bySource = new Map();
        for (const hit of hits) {
            if (bySource.has(hit.sourceId)) continue;
            bySource.set(hit.sourceId, hit);
        }

        const sourceIds = [...bySource.keys()].slice(0, limit);
        if (sourceIds.length === 0) return [];

        const sources = await KnowledgeSource.find({ orgId, sourceId: { $in: sourceIds }, status: SourceStatus.READY })
            .select("sourceId title url")
            .lean();
        const titles = new Map(sources.map((source) => [source.sourceId, source]));

        return sourceIds
            .filter((sourceId) => titles.has(sourceId))
            .map((sourceId) => {
                const hit = bySource.get(sourceId);
                const source = titles.get(sourceId);
                return {
                    sourceId,
                    title: source.title || source.url || "Untitled",
                    url: source.url || null,
                    heading: (hit.headingPath || []).join(" › "),
                    snippet: this._snippet(hit.text, query),
                };
            });
    }

    // Windowed around the first match rather than the first N characters, so the
    // snippet shows why the result matched instead of showing every article's
    // opening sentence.
    _snippet(text, query) {
        const body = String(text || "").replace(/\s+/g, " ");
        const needle = query.toLowerCase().split(/\s+/)[0];
        const at = body.toLowerCase().indexOf(needle);
        if (at === -1) return body.slice(0, SNIPPET_CHARS).trim();

        const start = Math.max(0, at - 60);
        const excerpt = body.slice(start, start + SNIPPET_CHARS).trim();
        return `${start > 0 ? "…" : ""}${excerpt}${start + SNIPPET_CHARS < body.length ? "…" : ""}`;
    }
}

module.exports = new ArticleFunctions();
module.exports.MAX_RESULTS = MAX_RESULTS;
