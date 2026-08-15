const generalFunctions = require("../functions/utilFunctions/generalFunctions");

/* Strips MongoDB operator syntax out of anything a client sends.
   §8.6 — added after an audit found unauthenticated cross-tenant reads.

   The attack, concretely. `Org.findOne({ publicKey })` reads a value straight
   from the request body. A string is an equality match. An OBJECT is not:

       { "publicKey": { "$ne": null } }

   ...matches the first org in the collection — someone else's. The same
   primitive on a conversationId returns another tenant's support transcript,
   and on a boolean field it is an oracle you can use to enumerate values one
   character at a time with $regex. No credential is involved at any point,
   because the query never had to be authenticated to be wrong: it was asking
   "which org has this key" and the answer became "any of them".

   This middleware is DEFENCE IN DEPTH, not the fix. The fix is that every
   lookup coerces its own inputs — see `asId()` in utilFunctions. Both exist
   because the failure mode here is silent and the blast radius is the whole
   customer base, and the next person to add a route will not have read either
   note.

   Keys are REJECTED rather than stripped. Stripping turns a hostile request
   into a subtly different query that still runs; rejecting means an attempt
   shows up as a 400 in the logs, which is the only way anyone finds out it is
   happening. No legitimate client sends a `$` key — the config surface uses
   {field, operator, value} objects with operator names from an enum, never
   Mongo syntax. */

// Dotted keys are the other half: { "a.b": 1 } reaches into a subdocument, so
// a body key like "credits.plan" could write a field the route never intended.
function offendingKey(key) {
    if (typeof key !== "string") return null;
    if (key.startsWith("$")) return key;
    if (key.includes(".")) return key;
    return null;
}

/** Walks a parsed JSON body. Depth-capped: a deeply nested body is itself a
    denial-of-service vector, and nothing legitimate here nests past a few
    levels. */
function findOperator(value, depth = 0) {
    if (depth > 12) return "(nesting too deep)";
    if (Array.isArray(value)) {
        for (const entry of value) {
            const found = findOperator(entry, depth + 1);
            if (found) return found;
        }
        return null;
    }
    if (value && typeof value === "object") {
        for (const key of Object.keys(value)) {
            const bad = offendingKey(key);
            if (bad) return bad;
            const found = findOperator(value[key], depth + 1);
            if (found) return found;
        }
    }
    return null;
}

function sanitize(req, res, next) {
    try {
        for (const source of ["body", "query", "params"]) {
            const container = req[source];
            if (!container || typeof container !== "object") continue;
            const found = findOperator(container);
            if (found) {
                console.warn(
                    `sanitize: rejected ${req.method} ${req.path} — query operator in ${source}: ${found}`
                );
                return res.status(400).json({ success: false, error: "Invalid request" });
            }
        }
        return next();
    } catch (error) {
        console.error("sanitize: Catch block");
        console.error(error);
        generalFunctions.captureException(error);
        // Fail CLOSED. This middleware exists because the alternative is a
        // cross-tenant read; refusing a request we could not check is the
        // cheaper mistake by a wide margin.
        return res.status(400).json({ success: false, error: "Invalid request" });
    }
}

module.exports = { sanitize, findOperator };
