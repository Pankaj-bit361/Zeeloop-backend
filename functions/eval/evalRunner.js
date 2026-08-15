const crypto = require("crypto");
const config = require("../../config/config");
const { ConfigTarget, PublishState, IdPrefix, ConversationStatus } = require("../../config/enums");
const Org = require("../../models/org/org");
const Conversation = require("../../models/conversation/conversation");
const Message = require("../../models/conversation/message");
const TurnTrace = require("../../models/trace/turnTrace");
const GuidanceRule = require("../../models/config/guidanceRule");
const EscalationRule = require("../../models/config/escalationRule");
const EscalationGuidance = require("../../models/config/escalationGuidance");
const generalFunctions = require("../utilFunctions/generalFunctions");
const agentFunctions = require("../agent/agentFunctions");

// Shared machinery for batch tests (§3.1) and simulations (§3.2). Both need the
// same two awkward things, so both get them from here.
//
// ── Running against DRAFT config ─────────────────────────────────────
//
// The pipeline reads live config from the database. Testing a draft therefore
// needs the draft to be readable as if it were live, without it actually being
// live for real customers for the duration of the test.
//
// The approach: temporarily flip the org's draft objects to LIVE inside a
// try/finally, run the turns, and flip them back. Considered and rejected:
//
//   - Threading an override through every layer of the pipeline. Correct, and it
//     means every function between the route and the prompt builder grows a
//     parameter it does not use, forever.
//   - Cloning the org into a shadow workspace. Correct, and it means every
//     knowledge chunk, table and action gets cloned too — the cost is enormous
//     and the clone drifts.
//
// The flip is confined to one org's config rows, the finally block always runs,
// and a crash mid-test leaves rows in a state the next publish corrects. That is
// an honest trade, not a free lunch: a draft run does briefly affect live
// traffic for that workspace. It is documented in the API response so nobody
// discovers it by accident.
//
// ── Ephemeral conversations ──────────────────────────────────────────
//
// Test turns write real Conversation, Message and TurnTrace rows, because the
// pipeline needs them. They are deleted afterwards and marked while they exist,
// so a test run does not inflate the automation rate or fill the inbox.

const EVAL_ID_MARKER = "eval";

class EvalRunner {
    // ── Public Functions ─────────────────────────────────────────────

    // Runs `items` through `handler` with bounded concurrency, and with the
    // draft flip applied around the whole batch rather than per item.
    async withTarget({ orgId, target, run }) {
        console.log("EvalRunner:withTarget: orgId:", orgId, "target:", target);
        if (target !== ConfigTarget.DRAFT) {
            return await run();
        }

        const flipped = await this._promoteDrafts({ orgId });
        try {
            return await run();
        } finally {
            await this._demoteDrafts({ orgId, flipped });
        }
    }

    // One question through the real pipeline, in a throwaway conversation.
    async runSingleTurn({ org, question, history, conversation }) {
        console.log("EvalRunner:runSingleTurn");
        const ephemeral = conversation || (await this._createEphemeralConversation({ orgId: org.orgId }));

        await Message.create({
            orgId: org.orgId,
            messageId: generalFunctions.generateId(IdPrefix.MESSAGE),
            conversationId: ephemeral.conversationId,
            role: "USER",
            content: question,
        });

        const turn = await agentFunctions.runTurn({
            org,
            conversation: ephemeral,
            endUser: null,
            identityVerified: false,
            rawMessage: question,
            history: history || [],
        });

        await Message.create({
            orgId: org.orgId,
            messageId: generalFunctions.generateId(IdPrefix.MESSAGE),
            conversationId: ephemeral.conversationId,
            role: "ASSISTANT",
            content: turn.reply,
            citations: turn.citations || [],
        });

        ephemeral.turnCount += 1;
        await ephemeral.save();

        return { turn, conversation: ephemeral };
    }

    // Deletes the conversation, its messages and its traces. Called in a finally
    // by every caller — an eval run that leaves rows behind quietly corrupts the
    // metrics it exists to protect.
    async discardEphemeral({ orgId, conversationId }) {
        console.log("EvalRunner:discardEphemeral: conversationId:", conversationId);
        try {
            await Promise.all([
                Conversation.deleteOne({ orgId, conversationId }),
                Message.deleteMany({ orgId, conversationId }),
                TurnTrace.deleteMany({ orgId, conversationId }),
            ]);
            return { success: true };
        } catch (error) {
            console.error("EvalRunner:discardEphemeral: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { success: false };
        }
    }

    // Bounded parallelism. A suite of forty questions must not open forty
    // concurrent model requests and starve live traffic of rate limit.
    async mapLimited({ items, limit, handler }) {
        const results = new Array(items.length);
        let cursor = 0;

        const workers = Array.from({ length: Math.min(limit || config.EVAL_CONCURRENCY, items.length) }, async () => {
            for (;;) {
                const index = cursor++;
                if (index >= items.length) return;
                try {
                    results[index] = await handler(items[index], index);
                } catch (error) {
                    console.error("EvalRunner:mapLimited: item failed at index", index);
                    console.error(error);
                    generalFunctions.captureException(error);
                    // One bad question must not abandon the other thirty-nine.
                    results[index] = { error: error.message };
                }
            }
        });

        await Promise.all(workers);
        return results;
    }

    async loadOrg({ orgId }) {
        return Org.findOne({ orgId });
    }

    // ── Private Helper Functions ─────────────────────────────────────

    async _createEphemeralConversation({ orgId }) {
        return Conversation.create({
            orgId,
            // The marker is in the id so a stray row is identifiable by eye in
            // the database, not only by a boolean somebody has to know to check.
            conversationId: `${IdPrefix.CONVERSATION}_${EVAL_ID_MARKER}_${crypto.randomBytes(6).toString("hex")}`,
            status: ConversationStatus.OPEN,
        });
    }

    async _promoteDrafts({ orgId }) {
        const flipped = [];
        for (const Model of [GuidanceRule, EscalationRule, EscalationGuidance]) {
            const drafts = await Model.find({ orgId, publishState: PublishState.DRAFT }).select("_id enabled").lean();
            if (drafts.length === 0) continue;
            const ids = drafts.map((draft) => draft._id);
            // `enabled` is restored alongside publishState: a draft is created
            // disabled, and promoting it without enabling it would test nothing.
            flipped.push({ Model, ids, previous: drafts.map((draft) => ({ _id: draft._id, enabled: draft.enabled })) });
            await Model.updateMany({ _id: { $in: ids } }, { $set: { publishState: PublishState.LIVE, enabled: true } });
        }
        return flipped;
    }

    async _demoteDrafts({ orgId, flipped }) {
        for (const entry of flipped) {
            for (const previous of entry.previous) {
                await entry.Model.updateOne(
                    { _id: previous._id },
                    { $set: { publishState: PublishState.DRAFT, enabled: previous.enabled } }
                );
            }
        }
    }
}

module.exports = new EvalRunner();
module.exports.EVAL_ID_MARKER = EVAL_ID_MARKER;
