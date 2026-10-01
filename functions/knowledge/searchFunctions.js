const config = require("../../config/config");
const Chunk = require("../../models/knowledge/chunk");
const llmFunctions = require("../utilFunctions/llmFunctions");

const STOPWORDS = new Set((
    "a an the and or for are but not you your yours with can how what when where why who which " +
    "does do did will would could should have has had was were been being them they this that " +
    "there their from about into than then get much many any all long take make need want please " +
    "is it its of on in to as at be by me my we our us among create"
).split(" "));
const WORD = "\\p{L}\\p{N}\\p{M}";
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Keep acronyms (AI, UI) and non-Latin words. Inflections are word matches,
// never substrings: searching "AI" must not match "paid".
function searchTerms(query) {
    return [...new Set((String(query || "").normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}\p{M}]+/gu) || [])
        .filter((term) => term.length >= 2 && !STOPWORDS.has(term)))].slice(0, 24);
}

function termPattern(term, bounded = true) {
    let variants = escapeRegex(term);
    if (/^[a-z]{4,}$/.test(term)) {
        let base = term;
        if (/ies$/.test(base)) base = base.slice(0, -3) + "y";
        else if (/(ches|shes|sses|xes|zes)$/.test(base)) base = base.slice(0, -2);
        else if (/s$/.test(base) && !/(ss|us|is)$/.test(base)) base = base.slice(0, -1);
        const roots = new Set([base]);
        if (base.length > 5 && /ing$/.test(base)) {
            const root = base.slice(0, -3).replace(/([b-df-hj-np-tv-z])\1$/, "$1");
            roots.add(root); roots.add(root + "e");
        } else if (base.length > 4 && /ed$/.test(base)) {
            const root = base.slice(0, -2);
            roots.add(root); roots.add(root + "e");
        }
        variants = [...roots].map((root) => root.endsWith("y")
            ? escapeRegex(root.slice(0, -1)) + "(?:y|ies|ied)"
            : escapeRegex(root) + "(?:s|es|ed|d|ing)?").join("|");
    }
    return bounded ? `(^|[^${WORD}])(?:${variants})($|[^${WORD}])` : `(?:${variants})`;
}

class SearchFunctions {
    async hybridSearch({ orgId, query, rawQuery, sourceIds, queryEmbeddingPromise, vectorSearch, textSearch }) {
        if (sourceIds && !sourceIds.length) return [];
        // Text retrieval starts immediately; it doesn't wait for the embedding
        // provider. A rewritten follow-up supplements, never replaces, the
        // customer's original keywords.
        const queries = [...new Set([query, rawQuery].filter(Boolean).map((value) => String(value).trim()))];
        const textPromises = queries.map((value) => (textSearch || this.textSearch.bind(this))({ orgId, query: value, sourceIds }));
        const vectorPromise = (async () => {
            try {
                const [queryEmbedding] = await (queryEmbeddingPromise || llmFunctions.embed({ texts: [query] }));
                return queryEmbedding ? (vectorSearch || this.vectorSearch.bind(this))({ orgId, queryEmbedding, sourceIds }) : [];
            } catch (error) {
                console.log("SearchFunctions: embedding unavailable; using text retrieval");
                return [];
            }
        })();
        const lists = await Promise.all([vectorPromise, ...textPromises]);
        const fused = new Map();
        for (let i = 0; i < lists.length; i++) {
            const seen = new Set();
            lists[i].forEach((hit, rank) => {
                if (seen.has(hit.chunkId)) return;
                seen.add(hit.chunkId);
                const entry = fused.get(hit.chunkId) || { ...hit, fusionScore: 0 };
                entry.fusionScore += 1 / (config.FUSION_K + rank + 1);
                if (i === 0) entry.vectorScore = hit.vectorScore;
                else entry.textScore = Math.max(entry.textScore || 0, hit.textScore || 0);
                fused.set(hit.chunkId, entry);
            });
        }
        return [...fused.values()].sort((a, b) => b.fusionScore - a.fusionScore)
            .slice(0, config.RETRIEVAL_CANDIDATES);
    }

    async vectorSearch({ orgId, queryEmbedding, sourceIds }) {
        if (sourceIds && !sourceIds.length) return [];
        const scope = { orgId, ...(sourceIds ? { sourceId: { $in: sourceIds } } : {}) };
        try {
            return await Chunk.aggregate([
                { $vectorSearch: {
                    index: config.VECTOR_INDEX_NAME, path: "embedding", queryVector: queryEmbedding,
                    numCandidates: config.RETRIEVAL_CANDIDATES * 4, limit: config.RETRIEVAL_CANDIDATES,
                    filter: scope,
                } },
                { $match: scope },
                { $project: { _id: 0, chunkId: 1, sourceId: 1, text: 1, headingPath: 1, vectorScore: { $meta: "vectorSearchScore" } } },
            ]).option({ maxTimeMS: 5000 });
        } catch (error) {
            console.log("SearchFunctions: vector index unavailable; using text retrieval");
            return [];
        }
    }

    async textSearch({ orgId, query, sourceIds }) {
        if (sourceIds && !sourceIds.length) return [];
        try {
            const hits = await Chunk.aggregate([
                { $search: { index: config.TEXT_INDEX_NAME, compound: {
                    should: [
                        { text: { query, path: "text" } },
                        { text: { query, path: "headingPath", score: { boost: { value: 2 } } } },
                    ],
                    minimumShouldMatch: 1,
                    filter: [{ equals: { value: orgId, path: "orgId" } }],
                } } },
                // Defence in depth: tenant IDs must be exact, never analysed
                // text, even when an older index definition is deployed.
                { $match: { orgId, ...(sourceIds ? { sourceId: { $in: sourceIds } } : {}) } },
                { $limit: config.RETRIEVAL_CANDIDATES },
                { $project: { _id: 0, chunkId: 1, sourceId: 1, text: 1, headingPath: 1, textScore: { $meta: "searchScore" } } },
            ]).option({ maxTimeMS: 5000 });
            if (hits.length) return hits;
        } catch (error) {
            console.log("SearchFunctions: text index unavailable; using keyword retrieval");
        }
        // Atlas can return an empty array for a missing/building index as well
        // as throwing. Both cases need the working fallback.
        return this.keywordSearch({ orgId, query, sourceIds });
    }

    async keywordSearch({ orgId, query, sourceIds }) {
        if (sourceIds && !sourceIds.length) return [];
        const terms = searchTerms(query);
        if (!terms.length) return [];
        const patterns = terms.map((term) => termPattern(term));
        // Proximity distinguishes "content plan" from an unrelated page that
        // mentions content in one paragraph and subscription plans in another.
        const phrases = terms.slice(1).map((term, i) => `(^|[^${WORD}])${termPattern(terms[i], false)}[^${WORD}]+${termPattern(term, false)}($|[^${WORD}])`);
        const heading = { $reduce: { input: { $ifNull: ["$headingPath", []] }, initialValue: "", in: { $concat: ["$$value", " ", "$$this"] } } };
        const leaf = { $ifNull: [{ $arrayElemAt: ["$headingPath", -1] }, ""] };
        const match = (input, regex, weight) => ({ $cond: [{ $regexMatch: { input, regex, options: "i" } }, weight, 0] });
        const scope = { orgId, ...(sourceIds ? { sourceId: { $in: sourceIds } } : {}), $or: patterns.flatMap((regex) => [
            { text: { $regex: regex, $options: "i" } },
            { headingPath: { $regex: regex, $options: "i" } },
        ]) };
        try {
            // Document frequency makes a specific term such as "guarantee"
            // count more than "Seovyn", which appears across the whole corpus.
            // Only aggregate counts cross the wire, never every matching body.
            const frequencies = await Chunk.aggregate([
                { $match: scope },
                { $group: { _id: null, count: { $sum: 1 },
                    ...Object.fromEntries(patterns.map((regex, i) => [`df${i}`, { $sum: { $cond: [{ $or: [
                        { $regexMatch: { input: { $ifNull: ["$text", ""] }, regex, options: "i" } },
                        { $regexMatch: { input: heading, regex, options: "i" } },
                    ] }, 1, 0] } }])),
                } },
            ]).option({ maxTimeMS: 5000 });
            if (!frequencies.length) return [];
            const stats = frequencies[0];
            const weights = patterns.map((_, i) => Math.log(1 + (stats.count - stats[`df${i}`] + 0.5) / (stats[`df${i}`] + 0.5)));
            return await Chunk.aggregate([
                { $match: scope },
                { $project: { _id: 0, chunkId: 1, sourceId: 1, text: 1, headingPath: 1,
                    textScore: { $divide: [{ $add: [...patterns.flatMap((regex, i) => [
                        match({ $ifNull: ["$text", ""] }, regex, weights[i]),
                        match(heading, regex, weights[i]),
                        match(leaf, regex, weights[i] * 2),
                    ]), ...phrases.flatMap((regex, i) => [
                        match({ $ifNull: ["$text", ""] }, regex, weights[i] + weights[i + 1]),
                        match(leaf, regex, (weights[i] + weights[i + 1]) * 2),
                    ])] }, weights.reduce((total, weight) => total + weight, 0) * 4] },
                } },
                // Rank ALL workspace matches in Mongo before taking top-N.
                // Returning the first 200 rows used to discard relevant later
                // documents and made generic words outrank specific headings.
                { $sort: { textScore: -1, chunkId: 1 } },
                { $limit: config.RETRIEVAL_CANDIDATES },
            ]).option({ maxTimeMS: 5000 });
        } catch (error) {
            // Database failure still fails closed; never invent evidence.
            console.error("SearchFunctions: keyword retrieval failed:", error.message);
            return [];
        }
    }
}

module.exports = new SearchFunctions();
module.exports.searchTerms = searchTerms;
