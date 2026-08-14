// Unit tests for PII redaction (§8.1). Pure logic, no server.
//
// The false-positive cases matter as much as the true positives: this codebase
// is full of order numbers, tracking codes and SKUs, and a redactor that eats
// them produces traces that cannot explain the conversation they came from.
"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const redaction = require("../functions/utilFunctions/redactionFunctions");

describe("email redaction", () => {
    test("redacts a plain address", () => {
        assert.equal(redaction.redactText("write to maya@brightloop.io please"), "write to [email] please");
    });

    test("redacts plus-addressing and subdomains", () => {
        assert.equal(redaction.redactText("maya+orders@mail.brightloop.co.uk"), "[email]");
    });

    test("redacts several in one string", () => {
        assert.equal(redaction.redactText("a@b.com and c@d.org"), "[email] and [email]");
    });

    test("leaves a bare domain alone", () => {
        assert.equal(redaction.redactText("see brightloop.io/help"), "see brightloop.io/help");
    });
});

describe("card redaction", () => {
    // Standard publicly documented test numbers — all Luhn-valid, none real.
    test("redacts a Luhn-valid 16-digit number", () => {
        assert.equal(redaction.redactText("card 4242424242424242 declined"), "card [card] declined");
    });

    test("redacts across spaces and hyphens", () => {
        assert.equal(redaction.redactText("4242 4242 4242 4242"), "[card]");
        assert.equal(redaction.redactText("4242-4242-4242-4242"), "[card]");
    });

    test("redacts a 15-digit Amex-shaped number", () => {
        assert.equal(redaction.redactText("378282246310005"), "[card]");
    });

    test("leaves a Luhn-invalid run of digits alone — order numbers are not cards", () => {
        assert.equal(redaction.redactText("order 1234567890123456"), "order 1234567890123456");
    });

    test("leaves a long tracking code alone", () => {
        const text = "tracking 9400111899223817428490";
        assert.equal(redaction.redactText(text), text);
    });
});

describe("phone redaction", () => {
    test("redacts an international number", () => {
        assert.equal(redaction.redactText("call +91 98765 43210 now"), "call [phone] now");
    });

    test("redacts a hyphenated number", () => {
        assert.equal(redaction.redactText("555-867-5309"), "[phone]");
    });

    test("leaves a short digit group alone", () => {
        assert.equal(redaction.redactText("order 12-34"), "order 12-34");
    });

    test("leaves a date alone", () => {
        assert.equal(redaction.redactText("2026-08-15"), "2026-08-15");
    });
});

describe("selective redaction", () => {
    test("can redact cards while leaving email intact — the model-input posture", () => {
        const out = redaction.redactText("maya@brightloop.io paid with 4242424242424242", { email: false });
        assert.ok(out.includes("maya@brightloop.io"));
        assert.ok(out.includes("[card]"));
    });

    test("a card that also looks like a phone is redacted as a card", () => {
        const out = redaction.redactText("4242 4242 4242 4242");
        assert.equal(out, "[card]");
    });
});

describe("redactDeep", () => {
    test("walks nested objects and arrays", () => {
        const input = {
            rawQuery: "email maya@brightloop.io",
            topChunks: [{ text: "contact a@b.com", score: 0.9 }],
            nested: { deeper: { value: "c@d.com" } },
        };
        const out = redaction.redactDeep(input);
        assert.equal(out.rawQuery, "email [email]");
        assert.equal(out.topChunks[0].text, "contact [email]");
        assert.equal(out.topChunks[0].score, 0.9, "non-strings pass through untouched");
        assert.equal(out.nested.deeper.value, "[email]");
    });

    test("leaves dates, numbers, booleans and null alone", () => {
        const when = new Date("2026-01-01");
        const out = redaction.redactDeep({ when, n: 42, ok: true, nothing: null });
        assert.equal(out.when, when);
        assert.equal(out.n, 42);
        assert.equal(out.ok, true);
        assert.equal(out.nothing, null);
    });

    test("does not mutate its input", () => {
        const input = { q: "a@b.com" };
        redaction.redactDeep(input);
        assert.equal(input.q, "a@b.com");
    });

    test("bounded depth means a pathological structure cannot hang a turn", () => {
        let deep = { value: "a@b.com" };
        for (let i = 0; i < 40; i++) deep = { nested: deep };
        assert.doesNotThrow(() => redaction.redactDeep(deep));
    });
});

describe("containsPii", () => {
    test("detects each category", () => {
        assert.equal(redaction.containsPii("a@b.com"), true);
        assert.equal(redaction.containsPii("4242424242424242"), true);
        assert.equal(redaction.containsPii("+91 98765 43210"), true);
    });

    test("is false for ordinary support text", () => {
        assert.equal(redaction.containsPii("where is my order 12345"), false);
        assert.equal(redaction.containsPii("the package never arrived"), false);
    });

    test("is false for non-strings", () => {
        assert.equal(redaction.containsPii(null), false);
        assert.equal(redaction.containsPii(42), false);
    });
});
