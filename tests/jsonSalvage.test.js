// The generate stage asks the model for JSON. Models do not always comply —
// they wrap the object in prose, in fences, or write a perfectly good answer
// as plain text. This was a real production failure: a visitor asked "What is
// Volanea?", the model wrote a correct answer, the parser rejected it because
// it was not JSON, and the visitor was shown "Something went wrong on my end."
//
// Two defences, tested here:
//   1. extractJsonObject digs the object out of whatever the model wrapped it in
//   2. a non-JSON answer is salvaged as prose rather than discarded
//
// The second is only safe because Stage 5 validation still runs on the
// salvaged text — see _runGenerate for why a tool call is never salvaged.
"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { extractJsonObject } = require("../functions/utilFunctions/llmFunctions");

describe("extractJsonObject", () => {
    test("parses a bare object", () => {
        assert.deepEqual(extractJsonObject('{"type":"answer","text":"hi"}'), { type: "answer", text: "hi" });
    });

    test("strips markdown fences", () => {
        const fenced = '```json\n{"type":"answer","text":"hi"}\n```';
        assert.deepEqual(extractJsonObject(fenced), { type: "answer", text: "hi" });
    });

    test("digs the object out of surrounding prose", () => {
        const chatty = 'Sure! Here is the object:\n{"type":"answer","text":"hi"}\nHope that helps.';
        assert.deepEqual(extractJsonObject(chatty), { type: "answer", text: "hi" });
    });

    test("handles nested objects — a regex cannot", () => {
        const nested = '{"type":"tool_call","actionId":"a1","args":{"order":{"id":7}}}';
        assert.deepEqual(extractJsonObject(nested).args, { order: { id: 7 } });
    });

    test("is not fooled by braces inside strings", () => {
        const tricky = '{"type":"answer","text":"use { like this }"}';
        assert.equal(extractJsonObject(tricky).text, "use { like this }");
    });

    test("does not confuse an escaped quote for the end of a string", () => {
        const escaped = '{"type":"answer","text":"she said \\"hi\\" }"}';
        assert.equal(extractJsonObject(escaped).text, 'she said "hi" }');
    });

    test("returns null for prose with no object in it", () => {
        assert.equal(extractJsonObject("Volanea is an email API service."), null);
    });

    test("returns null rather than throwing on junk", () => {
        assert.equal(extractJsonObject("{ not json at all"), null);
        assert.equal(extractJsonObject(""), null);
        assert.equal(extractJsonObject(null), null);
    });
});

describe("salvage decision", () => {
    // Mirrors the guard in _runGenerate. Kept as a table because the rule is
    // easy to loosen by accident, and loosening it means inventing tool
    // arguments out of prose.
    const usable = (text) => {
        const salvaged = String(text || "").trim();
        return salvaged.length > 20 && !salvaged.startsWith("{") && !salvaged.startsWith("[");
    };

    test("salvages a real prose answer", () => {
        assert.equal(usable("Volanea is an email service platform with a REST API."), true);
    });

    test("refuses truncated or empty output", () => {
        assert.equal(usable(""), false);
        assert.equal(usable("Sorry —"), false);
    });

    test("refuses anything that looks like a broken structure", () => {
        // half-written JSON is not an answer, and treating it as one would
        // show the visitor a fragment of our own protocol
        assert.equal(usable('{"type":"answer","text":"the rest never arrived'), false);
        assert.equal(usable('[{"partial": true'), false);
    });
});
