// Pure unit tests for the widget configuration surface (§4.1–§4.6).
//
// Launcher precedence in particular is worth testing hard: per the PRD it
// generates more support tickets than any other setting, and every one of those
// tickets is someone who changed a dashboard toggle and saw nothing happen.
"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const widgetConfigFunctions = require("../functions/widget/widgetConfigFunctions");
const responseComponentFunctions = require("../functions/widget/responseComponentFunctions");
const { HeaderTextMode, HomeSectionType, ResponseComponentType, ToolCallStatus, TurnOutcome } = require("../config/enums");

const org = (widget, agent) => ({ orgId: "org_test", name: "AcmeShip", widget: widget || {}, agent: agent || {} });

describe("home screen sections (§4.1)", () => {
    test("null means never customised, so the defaults apply", () => {
        const sections = widgetConfigFunctions.resolveHomeSections({ org: org({ homeSections: null }) });
        assert.deepEqual(sections, widgetConfigFunctions.DEFAULT_HOME_SECTIONS);
    });

    test("an empty array means the customer removed every section", () => {
        // Collapsing this into "use the defaults" would resurrect sections a
        // workspace deliberately cleared.
        const sections = widgetConfigFunctions.resolveHomeSections({ org: org({ homeSections: [] }) });
        assert.deepEqual(sections, []);
    });

    test("sections come back in `order`, not insertion order", () => {
        const sections = widgetConfigFunctions.resolveHomeSections({
            org: org({
                homeSections: [
                    { id: "b", type: HomeSectionType.ASK_QUESTION, order: 2 },
                    { id: "a", type: HomeSectionType.TRUST_BADGE, order: 0 },
                ],
            }),
        });
        assert.equal(sections[0].id, "a");
        assert.equal(sections[1].id, "b");
    });

    test("the default is capped at four sections", () => {
        // Empty space in a messenger is not a bug.
        assert.equal(widgetConfigFunctions.DEFAULT_HOME_SECTIONS.length, 4);
    });

    test("validation rejects duplicate ids", () => {
        const result = widgetConfigFunctions._validateSections([
            { id: "ask", type: HomeSectionType.ASK_QUESTION },
            { id: "ask", type: HomeSectionType.TRUST_BADGE },
        ]);
        assert.equal(result.success, false);
        assert.match(result.error, /Duplicate section id/);
    });

    test("validation accepts an unknown type", () => {
        // Deliberate: the widget skips unknown types, so a newer dashboard must
        // be able to configure a section an older backend has not heard of.
        const result = widgetConfigFunctions._validateSections([{ id: "new", type: "future_section" }]);
        assert.equal(result.success, true);
    });
});

describe("welcome message (§4.2)", () => {
    test("falls back to the agent greeting when no welcome is set", () => {
        const text = widgetConfigFunctions.renderWelcome({
            org: org({}, { greeting: "Hi! How can I help?" }),
            endUser: null,
            identityVerified: false,
        });
        assert.equal(text, "Hi! How can I help?");
    });

    test("identified visitors get the identified copy", () => {
        const workspace = org({ welcome: { anonymous: "Hi there!", identified: "Welcome back, {first_name}!" } });
        const text = widgetConfigFunctions.renderWelcome({
            org: workspace,
            endUser: { name: "Maya Chen" },
            identityVerified: true,
        });
        assert.equal(text, "Welcome back, Maya!");
    });

    test("anonymous visitors never see the identified copy", () => {
        const workspace = org({ welcome: { anonymous: "Hi there!", identified: "Welcome back!" } });
        const text = widgetConfigFunctions.renderWelcome({ org: workspace, endUser: null, identityVerified: false });
        assert.equal(text, "Hi there!");
    });

    test("only the first name is used, not the full name", () => {
        const workspace = org({ welcome: { anonymous: "Hi {first_name}!" } });
        const text = widgetConfigFunctions.renderWelcome({ org: workspace, endUser: { name: "Maya Chen" }, identityVerified: false });
        assert.equal(text, "Hi Maya!");
    });

    test("a missing name collapses the whole clause, leaving no stranded comma", () => {
        // "Hi , how can we help" is the bug this prevents.
        const workspace = org({ welcome: { anonymous: "Hi, {first_name}, how can we help?" } });
        const text = widgetConfigFunctions.renderWelcome({ org: workspace, endUser: null, identityVerified: false });
        assert.doesNotMatch(text, /,\s*,/);
        assert.doesNotMatch(text, /\{first_name\}/);
        assert.match(text, /^Hi, how can we help\?$/);
    });

    test("an identified visitor with no name still gets clean copy", () => {
        const workspace = org({ welcome: { identified: "Welcome back, {first_name}!" } });
        const text = widgetConfigFunctions.renderWelcome({
            org: workspace,
            endUser: { email: "a@b.com" },
            identityVerified: true,
        });
        assert.doesNotMatch(text, /\{first_name\}/);
        assert.equal(text, "Welcome back!");
    });
});

describe("launcher precedence (§4.3)", () => {
    test("a page-level hideLauncher beats the workspace setting", async () => {
        // The documented order, and the one people trip over: someone toggling
        // the dashboard setting and seeing nothing change is looking at a
        // page-level override.
        const result = await widgetConfigFunctions.shouldShowLauncher({
            org: org({ launcher: { showToVisitors: true } }),
            pageSettings: { hideLauncher: true },
            identityVerified: false,
        });
        assert.equal(result.show, false);
        assert.equal(result.level, "page");
        assert.match(result.reason, /zealoopSettings/);
    });

    test("a customLauncherSelector hides the default launcher and says so", async () => {
        const result = await widgetConfigFunctions.shouldShowLauncher({
            org: org({}),
            pageSettings: { customLauncherSelector: "#help-button" },
            identityVerified: false,
        });
        assert.equal(result.show, false);
        assert.equal(result.customLauncherSelector, "#help-button");
    });

    test("workspace settings hide by visitor type", async () => {
        const hidden = await widgetConfigFunctions.shouldShowLauncher({
            org: org({ launcher: { showToVisitors: false, showToIdentified: true } }),
            identityVerified: false,
        });
        assert.equal(hidden.show, false);
        assert.equal(hidden.level, "workspace");

        const shown = await widgetConfigFunctions.shouldShowLauncher({
            org: org({ launcher: { showToVisitors: false, showToIdentified: true } }),
            identityVerified: true,
        });
        assert.equal(shown.show, true);
    });

    test("exclude beats include on the same URL", async () => {
        // "everywhere in the docs EXCEPT the changelog" is what someone writing
        // both means; evaluating include first would show it there.
        const workspace = org({
            launcher: { urlInclude: ["https://acme.com/docs/*"], urlExclude: ["https://acme.com/docs/changelog"] },
        });
        const result = await widgetConfigFunctions.shouldShowLauncher({
            org: workspace,
            pageUrl: "https://acme.com/docs/changelog",
            identityVerified: false,
        });
        assert.equal(result.show, false);
        assert.match(result.reason, /exclude/);
    });

    test("an empty include list means everywhere, not nowhere", async () => {
        const result = await widgetConfigFunctions.shouldShowLauncher({
            org: org({ launcher: { urlInclude: [], urlExclude: [] } }),
            pageUrl: "https://acme.com/anything",
            identityVerified: false,
        });
        assert.equal(result.show, true);
    });

    test("a non-matching include list hides the launcher", async () => {
        const result = await widgetConfigFunctions.shouldShowLauncher({
            org: org({ launcher: { urlInclude: ["https://acme.com/docs/*"] } }),
            pageUrl: "https://acme.com/pricing",
            identityVerified: false,
        });
        assert.equal(result.show, false);
    });

    test("every verdict carries a reason", async () => {
        // The reason string is the feature: "why is my launcher hidden" is the
        // ticket this setting generates.
        const result = await widgetConfigFunctions.shouldShowLauncher({ org: org({}), identityVerified: false });
        assert.ok(result.reason);
        assert.ok(result.level);
    });
});

describe("header text colour (§4.5)", () => {
    test("a manual choice always wins", () => {
        const black = widgetConfigFunctions.resolveHeaderTextColor({ org: org({ headerTextMode: HeaderTextMode.BLACK }) });
        assert.equal(black.color, "#000000");
        assert.equal(black.source, "manual");
    });

    test("a gradient background warns rather than guessing silently", () => {
        // No single computed value works across both stops, so the dashboard
        // has to prompt.
        const result = widgetConfigFunctions.resolveHeaderTextColor({
            org: org({ headerTextMode: HeaderTextMode.AUTO, background: "aurora" }),
        });
        assert.equal(result.source, "gradient-default");
        assert.ok(result.warning);
    });

    test("a solid background computes from luminance", () => {
        const dark = widgetConfigFunctions.resolveHeaderTextColor({
            org: org({ headerTextMode: HeaderTextMode.AUTO, background: "solid", accentColor: "#0B1020" }),
        });
        assert.equal(dark.color, "#FFFFFF");

        const light = widgetConfigFunctions.resolveHeaderTextColor({
            org: org({ headerTextMode: HeaderTextMode.AUTO, background: "solid", accentColor: "#FFF9C4" }),
        });
        assert.equal(light.color, "#000000");
        assert.equal(light.source, "computed");
    });
});

describe("spacing tokens (§4.4)", () => {
    test("the 8px scale from the Intercom comparison is served, not hardcoded in the embed", () => {
        const spacing = widgetConfigFunctions.SPACING_TOKENS;
        assert.equal(spacing.panelPadding, 24);
        assert.equal(spacing.greetingSpaceAbove, 32);
        assert.equal(spacing.greetingSpaceBelow, 32);
        assert.equal(spacing.cardGap, 12);
        assert.equal(spacing.cardPadding, 20);
        assert.equal(spacing.cardRadius, 16);
    });

    test("footer clearance exists so 'Powered by Zealoop' cannot clip behind the tab bar", () => {
        assert.ok(widgetConfigFunctions.SPACING_TOKENS.footerClearance > 0);
    });

    test("the 44px minimum tap target is enforced as a token", () => {
        assert.equal(widgetConfigFunctions.SPACING_TOKENS.minTapTarget, 44);
    });

    test("the 72px minimum logo size is a token, so the fallback rule is shared", () => {
        assert.equal(widgetConfigFunctions.SPACING_TOKENS.minLogoPx, 72);
    });
});

describe("rich response components (§4.6)", () => {
    test("every component carries fallbackText", () => {
        // A client that cannot render a type renders its fallback, so a message
        // is never blank.
        const components = [
            responseComponentFunctions.text({ content: "hello" }),
            responseComponentFunctions.confirm({ actionName: "Cancel order", actionId: "act_1", args: { id: 5 } }),
            responseComponentFunctions.choices({ prompt: "Which one?", options: ["A", "B"] }),
            responseComponentFunctions.card({ title: "Order 4471", fields: [{ label: "Status", value: "Shipped" }] }),
            responseComponentFunctions.link({ label: "Docs", url: "https://acme.com" }),
            responseComponentFunctions.form({ prompt: "Details?", fields: [{ name: "email" }] }),
        ];
        for (const component of components) {
            assert.ok(component.fallbackText, `${component.type} has no fallbackText`);
        }
    });

    test("the confirm component echoes the args so the customer confirms what will happen", () => {
        // "Cancel subscription" and "cancel subscription for account 4471" are
        // different questions.
        const component = responseComponentFunctions.confirm({
            actionName: "Cancel subscription",
            actionId: "act_1",
            args: { accountId: "4471" },
        });
        assert.equal(component.type, ResponseComponentType.CONFIRM);
        assert.deepEqual(component.args, { accountId: "4471" });
        assert.match(component.fallbackText, /yes/i);
    });

    test("a halted turn produces a confirm component", () => {
        // §4.6 calls this out as coupled to Phase 0: write-action confirmation
        // has no first-class UI without it.
        const result = responseComponentFunctions.fromTurn({
            turn: {
                reply: "I'd like to run Cancel order for you.",
                halted: true,
                outcome: TurnOutcome.CLARIFIED,
                toolCalls: [
                    { actionId: "act_1", actionName: "Cancel order", args: { id: 5 }, status: ToolCallStatus.AWAITING_CONFIRMATION },
                ],
            },
        });

        const confirm = result.components.find((component) => component.type === ResponseComponentType.CONFIRM);
        assert.ok(confirm, "a halted turn must produce a confirm component");
        assert.equal(confirm.actionId, "act_1");
    });

    test("a normal turn produces text only", () => {
        const result = responseComponentFunctions.fromTurn({
            turn: { reply: "Refunds take 5 days.", halted: false, outcome: TurnOutcome.ANSWERED, toolCalls: [] },
        });
        assert.equal(result.components.length, 1);
        assert.equal(result.components[0].type, ResponseComponentType.TEXT);
    });

    test("choices are capped at six", () => {
        const component = responseComponentFunctions.choices({
            prompt: "Pick",
            options: ["a", "b", "c", "d", "e", "f", "g", "h"],
        });
        assert.equal(component.options.length, 6);
    });

    test("sanitise drops unknown component types", () => {
        const clean = responseComponentFunctions.sanitise({
            components: [{ type: ResponseComponentType.TEXT, text: "ok" }, { type: "rogue" }, null],
        });
        assert.equal(clean.length, 1);
    });
});
