const config = require("./config");

function searchIndexDefinitions() {
    return [
        { name: config.VECTOR_INDEX_NAME, type: "vectorSearch", definition: { fields: [
            { type: "vector", path: "embedding", numDimensions: config.EMBEDDING_DIM, similarity: "cosine" },
            { type: "filter", path: "orgId" },
            { type: "filter", path: "sourceId" },
        ] } },
        { name: config.TEXT_INDEX_NAME, type: "search", definition: { mappings: { dynamic: false, fields: {
            text: { type: "string" },
            headingPath: { type: "string" },
            orgId: { type: "token" },
        } } } },
    ];
}

// Additive and idempotent. Existing indexes are never replaced or dropped;
// an operator can migrate a legacy definition while keyword retrieval works.
// Creation is asynchronous in Atlas: callers still check queryable/status.
async function ensureSearchIndexes(collection) {
    const existing = await collection.listSearchIndexes(undefined, { maxTimeMS: 5000 }).toArray();
    const present = new Set(existing.map((index) => index.name));
    const created = [];
    for (const index of searchIndexDefinitions()) {
        if (present.has(index.name)) continue;
        try {
            await collection.createSearchIndex(index, { maxTimeMS: 5000 });
            created.push(index.name);
        } catch (error) {
            // Multiple API instances can boot together. A concurrent creation
            // is success, provided the named index now actually exists.
            const current = await collection.listSearchIndexes(index.name, { maxTimeMS: 5000 }).toArray();
            if (!current.some((item) => item.name === index.name)) throw error;
        }
    }
    return { created };
}

module.exports = { searchIndexDefinitions, ensureSearchIndexes };
