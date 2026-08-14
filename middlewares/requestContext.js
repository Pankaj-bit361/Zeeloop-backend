const { AsyncLocalStorage } = require("node:async_hooks");
const generalFunctions = require("../functions/utilFunctions/generalFunctions");

// Requiring the agent again is free — Node returns the cached module from the
// load server.js already did. Null when unlicensed, so every call site below
// has to null-check rather than assume the agent is present.
const newrelic =
    process.env.NEW_RELIC_LICENSE_KEY && process.env.NEW_RELIC_ENABLED !== "false" ? require("newrelic") : null;

const storage = new AsyncLocalStorage();

// Lets any function deep in the call stack label its logs with the request it
// belongs to, without threading a parameter through every signature.
function currentRequestId() {
    const store = storage.getStore();
    return store ? store.requestId : null;
}

function requestContext(req, res, next) {
    // Honour an inbound id so a request that already crossed a proxy keeps one
    // identity end to end.
    const requestId = req.get("x-request-id") || generalFunctions.generateId("req");
    res.setHeader("x-request-id", requestId);

    // Makes the id searchable in New Relic, which is the half that turns a
    // support ticket into a trace.
    if (newrelic) {
        newrelic.addCustomAttribute("requestId", requestId);
    }

    // The generic 500 body is built in 60+ places. Rather than edit each one,
    // stamp the id at the single choke point they all pass through — res.json.
    const sendJson = res.json.bind(res);
    res.json = (body) => {
        if (res.statusCode >= 500 && body && typeof body === "object" && !Array.isArray(body)) {
            return sendJson({ ...body, requestId });
        }
        return sendJson(body);
    };

    storage.run({ requestId }, next);
}

module.exports = { requestContext, currentRequestId };
