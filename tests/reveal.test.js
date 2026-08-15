// §1.9 — progressive reveal and the approval switch.
//
// These are the rules that decide what a brand-new workspace is shown, so the
// interesting cases are the empty one and the ratchet. Pure rule evaluation is
// tested without a database; the ratchet and the escape hatch need one.
"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const revealFunctions = require("../functions/onboarding/revealFunctions");
const { RULES, ALWAYS_VISIBLE } = revealFunctions;
const { NavSection } = require("../config/enums");

const EMPTY = { conversations: 0, escalations: 0, members: 1, tables: 0, apiKeys: 0 };
const signals = (over) => ({ ...EMPTY, ...over });
const earned = (over) =>
    Object.values(NavSection).filter((section) => RULES[section](signals(over)));

describe("reveal rules", () => {
    test("a brand-new workspace earns nothing beyond the four basics", () => {
        // The whole point. Day one is four sidebar entries, not eleven.
        assert.deepEqual(earned(), []);
        assert.deepEqual(ALWAYS_VISIBLE, ["DASHBOARD", "INBOX", "KNOWLEDGE", "WIDGET"]);
    });

    test("every section in the enum has a rule", () => {
        // A section with no rule is shown unconditionally, which silently
        // defeats the feature for that section.
        for (const section of Object.values(NavSection)) {
            assert.equal(typeof RULES[section], "function", `${section} has no reveal rule`);
        }
    });

    test("Agent and Analytics arrive once there is something to look at", () => {
        assert.equal(earned({ conversations: 9 }).includes(NavSection.AGENT), false);
        assert.ok(earned({ conversations: 10 }).includes(NavSection.AGENT));
        assert.ok(earned({ conversations: 10 }).includes(NavSection.ANALYTICS));
    });

    test("Evaluation waits for real traffic", () => {
        assert.equal(earned({ conversations: 99 }).includes(NavSection.EVALUATION), false);
        assert.ok(earned({ conversations: 100 }).includes(NavSection.EVALUATION));
    });

    test("Tables arrive on escalations, not only on volume", () => {
        // The signal is "the agent needed something it did not have".
        assert.equal(earned({ escalations: 2 }).includes(NavSection.TABLES), false);
        assert.ok(earned({ escalations: 3 }).includes(NavSection.TABLES));
        assert.ok(earned({ conversations: 50 }).includes(NavSection.TABLES));
    });

    test("a workspace that already built a table keeps seeing Tables and APIs", () => {
        // Otherwise creating a table via the API would hide the page that
        // manages it.
        const result = earned({ tables: 1 });
        assert.ok(result.includes(NavSection.TABLES));
        assert.ok(result.includes(NavSection.APIS));
    });

    test("Security and Users arrive with a second person", () => {
        assert.equal(earned({ members: 1 }).includes(NavSection.SECURITY), false);
        assert.ok(earned({ members: 2 }).includes(NavSection.SECURITY));
        assert.ok(earned({ members: 2 }).includes(NavSection.USERS));
    });

    test("Security also arrives for a solo founder who issued an API key", () => {
        // They have plainly found the advanced surface; hiding it now is silly.
        assert.ok(earned({ apiKeys: 1 }).includes(NavSection.SECURITY));
    });

    test("a busy solo workspace ends up with everything except team-only sections", () => {
        const result = earned({ conversations: 500, escalations: 20 });
        assert.ok(result.includes(NavSection.AGENT));
        assert.ok(result.includes(NavSection.EVALUATION));
        assert.ok(result.includes(NavSection.TABLES));
        assert.ok(result.includes(NavSection.USERS));
        // Still alone, so an audit log of your own actions stays out of the way.
        assert.equal(result.includes(NavSection.SECURITY), false);
    });

    test("rules never un-earn as numbers grow", () => {
        // Monotonicity is what makes the persisted ratchet coherent. If a rule
        // could go false as a workspace grows, the stored set and the computed
        // set would disagree forever.
        const growing = [
            signals({ conversations: 0 }),
            signals({ conversations: 10 }),
            signals({ conversations: 100 }),
            signals({ conversations: 100, escalations: 5 }),
            signals({ conversations: 100, escalations: 5, members: 3, tables: 2, apiKeys: 1 }),
        ];
        for (const section of Object.values(NavSection)) {
            let seenTrue = false;
            for (const stage of growing) {
                const value = RULES[section](stage);
                if (value) seenTrue = true;
                else assert.equal(seenTrue, false, `${section} un-earned itself as the workspace grew`);
            }
        }
    });
});
