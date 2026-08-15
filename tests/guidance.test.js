// Pure unit tests for the configuration surface's prompt composition (§2.1,
// §2.7, §2.8) and audience matching (§2.6).
//
// These are the functions that decide what the agent is told on every turn, so
// a bug here changes every answer a workspace produces.
"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const guidanceFunctions = require("../functions/config/guidanceFunctions");
const segmentFunctions = require("../functions/config/segmentFunctions");
const { GuidanceCategory, AnswerLength, LanguagePolicy } = require("../config/enums");

const compose = (rules) => guidanceFunctions._composeGuidance(rules);
const rule = (category, body) => ({ category, body, guidanceRuleId: `gdr_${body.length}` });

describe("guidance composition", () => {
    test("no rules produces no section at all", () => {
        // An empty "GUIDANCE:" header would burn tokens on every turn to say
        // nothing.
        assert.equal(compose([]), "");
    });

    test("rules are grouped under their category label", () => {
        const text = compose([
            rule(GuidanceCategory.COMMUNICATION_STYLE, "Be concise."),
            rule(GuidanceCategory.SOURCES, "Never invent pricing."),
        ]);

        assert.match(text, /Communication style:/);
        assert.match(text, /Content and sources:/);
        assert.match(text, /- Be concise\./);
        assert.match(text, /- Never invent pricing\./);
    });

    test("rules in the same category are grouped together, not interleaved", () => {
        const text = compose([
            rule(GuidanceCategory.COMMUNICATION_STYLE, "Be concise."),
            rule(GuidanceCategory.SOURCES, "Cite sources."),
            rule(GuidanceCategory.COMMUNICATION_STYLE, "Be warm."),
        ]);

        const styleAt = text.indexOf("Communication style:");
        const sourcesAt = text.indexOf("Content and sources:");
        const warmAt = text.indexOf("Be warm.");
        // "Be warm" must sit inside the style block, before sources begins.
        assert.ok(warmAt > styleAt && warmAt < sourcesAt, "same-category rules must stay together");
    });

    test("category order is stable regardless of input order", () => {
        // Not cosmetic: a prompt whose sections shuffle every request defeats
        // prompt caching and makes two identical questions produce
        // differently-shaped answers.
        const a = compose([rule(GuidanceCategory.SPAM, "x"), rule(GuidanceCategory.COMMUNICATION_STYLE, "y")]);
        const b = compose([rule(GuidanceCategory.COMMUNICATION_STYLE, "y"), rule(GuidanceCategory.SPAM, "x")]);
        assert.equal(a, b);
    });

    test("only the body reaches the model, never the title", () => {
        const text = compose([{ category: GuidanceCategory.OTHER, title: "Internal note DO NOT SHIP", body: "Be helpful." }]);
        assert.doesNotMatch(text, /Internal note/);
        assert.match(text, /Be helpful\./);
    });
});

describe("escalation guidance composition", () => {
    test("empty produces nothing", () => {
        assert.equal(guidanceFunctions._composeEscalationGuidance([]), "");
    });

    test("renders as instructions to hand off, not as knowledge", () => {
        const text = guidanceFunctions._composeEscalationGuidance([{ body: "Escalate refund requests." }]);
        assert.match(text, /HAND OFF/i);
        assert.match(text, /- Escalate refund requests\./);
    });
});

describe("agent identity and tone (§2.8)", () => {
    const org = (agent, businessContext) => ({
        name: "AcmeShip",
        agent: agent || {},
        businessContext: businessContext || {},
    });

    test("CONCISE lowers the token ceiling as well as the instruction", () => {
        // A model told to be concise and handed a thousand tokens uses them.
        const concise = guidanceFunctions.composeIdentityAndContext({ org: org({ answerLength: AnswerLength.CONCISE }) });
        const detailed = guidanceFunctions.composeIdentityAndContext({ org: org({ answerLength: AnswerLength.DETAILED }) });

        assert.ok(concise.maxTokens < detailed.maxTokens);
        assert.match(concise.prompt, /at most three sentences/i);
    });

    test("defaults to STANDARD when unset", () => {
        const result = guidanceFunctions.composeIdentityAndContext({ org: org({}) });
        assert.equal(result.maxTokens, guidanceFunctions.LENGTH_GUIDANCE[AnswerLength.STANDARD].maxTokens);
    });

    test("FIXED language policy names the language", () => {
        const result = guidanceFunctions.composeIdentityAndContext({
            org: org({ languagePolicy: LanguagePolicy.FIXED, fixedLanguage: "es" }),
        });
        assert.match(result.prompt, /Always reply in es/);
    });

    test("MATCH_USER is the default and says so", () => {
        const result = guidanceFunctions.composeIdentityAndContext({ org: org({}) });
        assert.match(result.prompt, /same language the customer wrote in/);
    });

    test("formality changes the tone instruction", () => {
        const friendly = guidanceFunctions.composeIdentityAndContext({ org: org({ formality: "friendly" }) });
        const formal = guidanceFunctions.composeIdentityAndContext({ org: org({ formality: "formal" }) });
        assert.notEqual(friendly.prompt, formal.prompt);
        assert.match(formal.prompt, /No contractions/);
    });
});

describe("business context (§2.7)", () => {
    const org = (businessContext) => ({ name: "AcmeShip", agent: {}, businessContext });

    test("omits the section entirely when nothing is set", () => {
        const result = guidanceFunctions.composeIdentityAndContext({ org: org({}) });
        assert.doesNotMatch(result.prompt, /BUSINESS CONTEXT/);
    });

    test("states facts as always-true and citation-free", () => {
        // This is the whole point of keeping these out of the knowledge index:
        // they must be available on every turn, and anything retrieved can fail
        // to be retrieved.
        const result = guidanceFunctions.composeIdentityAndContext({
            org: org({ pricingSummary: "From $49/month", supportHours: "9-5 GMT" }),
        });

        assert.match(result.prompt, /BUSINESS CONTEXT/);
        assert.match(result.prompt, /without a citation/);
        assert.match(result.prompt, /From \$49\/month/);
        assert.match(result.prompt, /9-5 GMT/);
    });

    test("open-ended facts are included, and unlabelled ones are dropped", () => {
        const result = guidanceFunctions.composeIdentityAndContext({
            org: org({ facts: [{ label: "SLA", value: "4 hours" }, { label: "", value: "orphan" }] }),
        });
        assert.match(result.prompt, /SLA: 4 hours/);
        assert.doesNotMatch(result.prompt, /orphan/);
    });
});

describe("audience matching (§2.6)", () => {
    test("'everyone' applies regardless of segment membership", () => {
        assert.equal(segmentFunctions.appliesToAudience({ audience: { type: "everyone" }, segmentIds: [] }), true);
        assert.equal(segmentFunctions.appliesToAudience({ audience: undefined, segmentIds: [] }), true);
    });

    test("a segment audience applies only to members", () => {
        const audience = { type: "segment", segmentId: "seg_paid" };
        assert.equal(segmentFunctions.appliesToAudience({ audience, segmentIds: ["seg_paid"] }), true);
        assert.equal(segmentFunctions.appliesToAudience({ audience, segmentIds: ["seg_trial"] }), false);
        assert.equal(segmentFunctions.appliesToAudience({ audience, segmentIds: [] }), false);
    });

    test("a segment audience with no segmentId falls back to everyone", () => {
        // A half-configured audience must not silently disable the rule.
        assert.equal(segmentFunctions.appliesToAudience({ audience: { type: "segment", segmentId: null }, segmentIds: [] }), true);
    });
});

describe("channel matching", () => {
    const applies = (channels, channel) =>
        guidanceFunctions._applies({ rule: { channels, audience: { type: "everyone" } }, segmentIds: [], channel });

    test("an empty channel list means every channel", () => {
        // The reading that matters: objects created before the email channel
        // existed must not silently stop working the day it ships.
        assert.equal(applies([], "CHAT"), true);
        assert.equal(applies([], "EMAIL"), true);
        assert.equal(applies(undefined, "EMAIL"), true);
    });

    test("a named channel restricts to it", () => {
        assert.equal(applies(["CHAT"], "CHAT"), true);
        assert.equal(applies(["CHAT"], "EMAIL"), false);
        assert.equal(applies(["CHAT", "EMAIL"], "EMAIL"), true);
    });
});

describe("suggestion chips (§2.1)", () => {
    test("every category has chips so no category shows a blank box", () => {
        for (const category of Object.values(GuidanceCategory)) {
            const chips = guidanceFunctions.SUGGESTION_CHIPS[category];
            assert.ok(chips && chips.length > 0, `${category} has no chips`);
        }
    });

    test("every chip has both a title and a usable body", () => {
        for (const chips of Object.values(guidanceFunctions.SUGGESTION_CHIPS)) {
            for (const chip of chips) {
                assert.ok(chip.title, "chip missing title");
                // The body is what reaches the model, so a one-word body would
                // produce a rule that does nothing.
                assert.ok(chip.body && chip.body.length > 20, `chip body too short: ${chip.title}`);
            }
        }
    });

    test("escalation chips exist and read as escalation instructions", () => {
        assert.ok(guidanceFunctions.ESCALATION_CHIPS.length >= 4);
        for (const chip of guidanceFunctions.ESCALATION_CHIPS) {
            assert.match(chip.title, /escalate/i);
        }
    });
});
