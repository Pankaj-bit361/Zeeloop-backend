// Same additive setup used at boot. No knowledge content or vectors change.
const mongoose = require("mongoose");
const config = require("../config/config");
const { ensureSearchIndexes } = require("../config/searchIndexes");

async function main() {
    try {
        await mongoose.connect(config.MONGODB_URI, { serverSelectionTimeoutMS: 5000, autoIndex: false });
        const collection = mongoose.connection.db.collection("chunks");
        const result = await ensureSearchIndexes(collection);
        console.log("Search indexes created:", result.created.length ? result.created.join(", ") : "none; already present");
        const indexes = await collection.listSearchIndexes().toArray();
        console.log(JSON.stringify(indexes.map(({ name, status, queryable }) => ({ name, status, queryable })), null, 2));
    } catch (error) {
        console.error("Search index setup failed:", String(error.message).replace(config.MONGODB_URI, "[database]"));
        process.exitCode = 1;
    } finally {
        await mongoose.disconnect();
    }
}

main();
