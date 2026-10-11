// The autonomous-resolution cron, tested in-process with the model reads
// stood in for. What it checks is the "the agent answered" clause: a visitor
// who leaves after a clarifying question or a bare greeting is not a win.
"use strict";
const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");

process.env.NEW_RELIC_ENABLED = "false";
const { ConversationStatus } = require("../config/enums");
const Conversation = require("../models/conversation/conversation");
const Message = require("../models/conversation/message");
const TurnTrace = require("../models/trace/turnTrace");
const analyticsFunctions = require("../functions/analytics/analyticsFunctions");

const originals = [];
function stub(target, name, impl) {
    originals.push([target, name, target[name]]);
    target[name] = impl;
}
afterEach(() => {
    while (originals.length) {
        const [target, name, value] = originals.pop();
        target[name] = value;
    }
});

// Traces newest first, as the cron reads them.
function sweep(tracesNewestFirst) {
    const conversation = {
        orgId: "org_test", conversationId: "conv_test", status: ConversationStatus.OPEN, isResolved: false,
        lastMessageAt: new Date(Date.now() - 48 * 3600_000), endedAt: null, saved: false,
        async save() { this.saved = true; },
    };
    let filter = null;
    stub(Conversation, "find", (query) => { filter = query; return { limit: async () => [conversation] }; });
    stub(Message, "findOne", async () => null);
    stub(TurnTrace, "find", () => ({ sort: () => ({ select: () => ({ lean: async () => tracesNewestFirst }) }) }));
    return analyticsFunctions.computeResolutions().then((result) => ({ result, conversation, filter }));
}

describe("computeResolutions — the agent answered", () => {
    test("an answer, then a closing thanks, is a resolution", async () => {
        const { result, conversation } = await sweep([
            { outcome: "ANSWERED", gateIntent: "CHITCHAT" },
            { outcome: "ANSWERED", gateIntent: "QUESTION" },
        ]);
        assert.equal(conversation.isResolved, true);
        assert.equal(result.resolvedCount, 1);
    });

    test("leaving after a clarifying question closes the thread but is not a win (conv_f15bf87f0ffecb11)", async () => {
        const { result, conversation } = await sweep([
            { outcome: "ANSWERED", gateIntent: "CHITCHAT" },
            { outcome: "CLARIFIED", gateIntent: "QUESTION" },
            { outcome: "ANSWERED", gateIntent: "QUESTION" },
        ]);
        assert.equal(conversation.isResolved, false);
        assert.equal(conversation.status, ConversationStatus.RESOLVED);
        assert.equal(conversation.saved, true);
        assert.equal(result.resolvedCount, 0);
    });

    test("an abstention or a greeting alone is not a win", async () => {
        for (const traces of [[{ outcome: "ABSTAINED", gateIntent: "QUESTION" }], [{ outcome: "ANSWERED", gateIntent: "CHITCHAT" }], []]) {
            const { conversation } = await sweep(traces);
            assert.equal(conversation.isResolved, false);
            while (originals.length) {
                const [target, name, value] = originals.pop();
                target[name] = value;
            }
        }
    });

    test("only OPEN threads are swept, so a closed-but-uncounted one is not revisited", async () => {
        const { filter } = await sweep([]);
        assert.equal(filter.status, ConversationStatus.OPEN);
    });
});
