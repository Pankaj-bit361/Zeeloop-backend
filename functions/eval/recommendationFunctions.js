const config = require("../../config/config");
const { IdPrefix, SourceType, SourceStatus } = require("../../config/enums");
const TurnTrace = require("../../models/trace/turnTrace");
const Recommendation = require("../../models/eval/recommendation");
const generalFunctions = require("../utilFunctions/generalFunctions");
const llmFunctions = require("../utilFunctions/llmFunctions");

// §3.5 — turn detected content gaps into something someone can act on.
//
// The existing analytics group `belowThreshold` queries by exact string, which
// is close to useless: "how do I cancel", "can I cancel my plan" and
// "cancellation process" are one gap and three rows. This clusters by embedding
// distance instead, so the output is gaps rather than phrasings.
//
// Clustering is greedy single-pass rather than k-means. There is no k to choose
// — the number of real gaps is unknown and changes weekly — and a greedy pass
// with a distance threshold produces stable, explainable clusters that do not
// reshuffle every run. k-means on the same data gives different groupings each
// time, which makes "is this gap new?" unanswerable.

const MAX_QUERIES_ANALYSED = 400;
const MIN_CLUSTER_SIZE = 2;
const MAX_CLUSTERS_KEPT = 30;

class RecommendationFunctions {
    // ── Public Functions ─────────────────────────────────────────────

    async listRecommendations({ orgId }) {
        console.log("RecommendationFunctions:listRecommendations: orgId:", orgId);
        try {
            const recommendations = await Recommendation.find({ orgId, dismissedAt: null, resolvedAt: null })
                .sort({ estimatedImpact: -1 })
                .lean();
            return {
                status: 200,
                json: {
                    success: true,
                    data: recommendations.map((entry) => {
                        const copy = { ...entry };
                        delete copy._id;
                        delete copy.__v;
                        return copy;
                    }),
                },
            };
        } catch (error) {
            console.error("RecommendationFunctions:listRecommendations: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // Recomputes the whole set for one workspace. Called on demand from the
    // analytics page rather than on a cron: it costs an embedding call per
    // distinct query, and running it hourly for a workspace nobody is looking at
    // spends money to produce a number nobody reads.
    async computeRecommendations({ orgId }) {
        console.log("RecommendationFunctions:computeRecommendations: orgId:", orgId);
        try {
            const traces = await TurnTrace.find({ orgId, belowThreshold: true })
                .sort({ createdAt: -1 })
                .limit(MAX_QUERIES_ANALYSED)
                .select("rawQuery rewrittenQuery")
                .lean();

            if (traces.length === 0) {
                return { status: 200, json: { success: true, data: { clusters: 0, message: "No content gaps detected yet." } } };
            }

            // The rewritten query where there is one: it has had pronouns
            // resolved, so "how much is it" has become "how much is the Pro
            // plan" and clusters with the questions it actually resembles.
            const queries = [...new Set(traces.map((trace) => (trace.rewrittenQuery || trace.rawQuery || "").trim()).filter(Boolean))];
            if (queries.length < MIN_CLUSTER_SIZE) {
                return { status: 200, json: { success: true, data: { clusters: 0, message: "Not enough distinct gaps to cluster yet." } } };
            }

            const vectors = await llmFunctions.embed({ texts: queries });
            const clusters = this._cluster({ queries, vectors });
            const worthwhile = clusters
                .filter((cluster) => cluster.members.length >= MIN_CLUSTER_SIZE)
                .sort((a, b) => b.members.length - a.members.length)
                .slice(0, MAX_CLUSTERS_KEPT);

            if (worthwhile.length === 0) {
                return {
                    status: 200,
                    json: {
                        success: true,
                        data: { clusters: 0, message: "Gaps found, but none repeated often enough to be worth an article yet." },
                    },
                };
            }

            const drafted = await this._draftArticles({ clusters: worthwhile });

            // Replaced wholesale, except for anything already dealt with —
            // otherwise a gap someone closed last week reappears at the top of
            // the list every time this runs.
            const handled = await Recommendation.find({
                orgId,
                $or: [{ resolvedAt: { $ne: null } }, { dismissedAt: { $ne: null } }],
            })
                .select("representativeQuery")
                .lean();
            const handledQueries = new Set(handled.map((entry) => entry.representativeQuery));

            await Recommendation.deleteMany({ orgId, resolvedAt: null, dismissedAt: null });
            const fresh = drafted.filter((entry) => !handledQueries.has(entry.representativeQuery));

            if (fresh.length > 0) {
                await Recommendation.insertMany(
                    fresh.map((entry) => ({
                        orgId,
                        recommendationId: generalFunctions.generateId(IdPrefix.RECOMMENDATION),
                        ...entry,
                        computedAt: new Date(),
                    }))
                );
            }

            return { status: 200, json: { success: true, data: { clusters: fresh.length, analysed: queries.length } } };
        } catch (error) {
            console.error("RecommendationFunctions:computeRecommendations: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // §3.5 — "one click creates a draft snippet pre-filled". The outline goes in
    // as the body, so the customer is editing a draft rather than facing an
    // empty editor.
    async createSnippetFromRecommendation({ orgId, recommendationId }) {
        console.log("RecommendationFunctions:createSnippetFromRecommendation: id:", recommendationId);
        try {
            const recommendation = await Recommendation.findOne({ orgId, recommendationId });
            if (!recommendation) return { status: 404, json: { success: false, error: "Recommendation not found" } };

            const KnowledgeSource = require("../../models/knowledge/knowledgeSource");
            const body = [
                `# ${recommendation.suggestedTitle}`,
                ``,
                `_Draft created from ${recommendation.queryCount} unanswered customer questions._`,
                ``,
                ...recommendation.outline.map((heading) => `## ${heading}\n\nTODO\n`),
                ``,
                `---`,
                ``,
                `Questions this should answer:`,
                ...recommendation.queries.slice(0, 10).map((query) => `- ${query}`),
            ].join("\n");

            const source = await KnowledgeSource.create({
                orgId,
                sourceId: generalFunctions.generateId(IdPrefix.KNOWLEDGE_SOURCE),
                type: SourceType.SNIPPET,
                title: recommendation.suggestedTitle,
                content: body,
                // PENDING, not READY: the draft is full of TODOs, and embedding
                // it now would put "TODO" into the retrieval index and have the
                // agent cite it.
                status: SourceStatus.PENDING,
            });

            recommendation.resolvedAt = new Date();
            recommendation.createdSourceId = source.sourceId;
            await recommendation.save();

            return { status: 201, json: { success: true, data: { sourceId: source.sourceId, title: source.title } } };
        } catch (error) {
            console.error("RecommendationFunctions:createSnippetFromRecommendation: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async dismiss({ orgId, recommendationId }) {
        console.log("RecommendationFunctions:dismiss: id:", recommendationId);
        try {
            const result = await Recommendation.updateOne(
                { orgId, recommendationId },
                { $set: { dismissedAt: new Date() } }
            );
            if (result.matchedCount === 0) {
                return { status: 404, json: { success: false, error: "Recommendation not found" } };
            }
            return { status: 200, json: { success: true, data: { dismissed: recommendationId } } };
        } catch (error) {
            console.error("RecommendationFunctions:dismiss: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // ── Private Helper Functions ─────────────────────────────────────

    // Greedy single pass. Each query joins the first existing cluster whose
    // centroid it is close enough to, or starts its own. O(n·k) rather than
    // O(n²), and stable across runs because the input order is stable.
    _cluster({ queries, vectors }) {
        const clusters = [];

        for (let index = 0; index < queries.length; index++) {
            const vector = vectors[index];
            if (!vector) continue;

            let best = null;
            let bestDistance = Infinity;
            for (const cluster of clusters) {
                const distance = 1 - this._cosine(vector, cluster.centroid);
                if (distance < bestDistance) {
                    bestDistance = distance;
                    best = cluster;
                }
            }

            if (best && bestDistance <= config.GAP_CLUSTER_THRESHOLD) {
                best.members.push(queries[index]);
                best.centroid = this._updateCentroid(best.centroid, vector, best.members.length);
            } else {
                clusters.push({
                    // The first member is the representative. It is the earliest
                    // occurrence in a newest-first list, so it is the most
                    // recent phrasing a customer actually used.
                    representative: queries[index],
                    members: [queries[index]],
                    centroid: [...vector],
                });
            }
        }

        return clusters;
    }

    // Running mean, so the centroid does not require keeping every member
    // vector in memory.
    _updateCentroid(centroid, vector, count) {
        return centroid.map((value, index) => value + (vector[index] - value) / count);
    }

    _cosine(a, b) {
        let dot = 0;
        let normA = 0;
        let normB = 0;
        for (let index = 0; index < a.length; index++) {
            dot += a[index] * b[index];
            normA += a[index] * a[index];
            normB += b[index] * b[index];
        }
        if (normA === 0 || normB === 0) return 0;
        return dot / (Math.sqrt(normA) * Math.sqrt(normB));
    }

    // One model call for every cluster rather than one per cluster. Titles are
    // more consistent when written together, and it is one request instead of
    // thirty.
    async _draftArticles({ clusters }) {
        try {
            const result = await llmFunctions.completeJson({
                model: config.LARGE_MODEL,
                system:
                    "You turn clusters of unanswered customer questions into help-article briefs. For each cluster, give a title the customer would recognise as their own question, and 3-5 section headings that would answer everything in the cluster. Do not invent product facts — headings only.",
                schemaHint: `{"articles": [{"index": number, "title": string, "outline": string[]}]}`,
                messages: [
                    {
                        role: "user",
                        content: clusters
                            .map(
                                (cluster, index) =>
                                    `Cluster ${index} (${cluster.members.length} questions):\n${cluster.members
                                        .slice(0, 12)
                                        .map((query) => `- ${query}`)
                                        .join("\n")}`
                            )
                            .join("\n\n"),
                    },
                ],
                maxTokens: 2048,
            });

            const byIndex = new Map((result.json.articles || []).map((article) => [article.index, article]));
            return clusters.map((cluster, index) => {
                const article = byIndex.get(index);
                return {
                    representativeQuery: cluster.representative,
                    queries: cluster.members,
                    queryCount: cluster.members.length,
                    // Falls back to the customer's own words rather than
                    // dropping the cluster: a gap with a mediocre title is still
                    // a gap worth showing.
                    suggestedTitle: (article && article.title) || cluster.representative,
                    outline: (article && Array.isArray(article.outline) ? article.outline : []).slice(0, 6),
                    estimatedImpact: cluster.members.length,
                };
            });
        } catch (error) {
            console.error("RecommendationFunctions:_draftArticles: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return clusters.map((cluster) => ({
                representativeQuery: cluster.representative,
                queries: cluster.members,
                queryCount: cluster.members.length,
                suggestedTitle: cluster.representative,
                outline: [],
                estimatedImpact: cluster.members.length,
            }));
        }
    }
}

module.exports = new RecommendationFunctions();
module.exports.MIN_CLUSTER_SIZE = MIN_CLUSTER_SIZE;
module.exports.MAX_CLUSTERS_KEPT = MAX_CLUSTERS_KEPT;
