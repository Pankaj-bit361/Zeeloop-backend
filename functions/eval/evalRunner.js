const crypto = require("crypto");
const config = require("../../config/config");
const { IdPrefix, ConversationStatus } = require("../../config/enums");
const Org = require("../../models/org/org");
const Conversation = require("../../models/conversation/conversation");
const Message = require("../../models/conversation/message");
const TurnTrace = require("../../models/trace/turnTrace");
const evalContext = require("./evalContext");
const generalFunctions = require("../utilFunctions/generalFunctions");
const agentFunctions = require("../agent/agentFunctions");

// Batch tests and simulations use request-local draft configuration. No rows
// are promoted, so concurrent customer traffic continues to see live rules.
// Evaluation conversations and traces are ephemeral and removed afterwards.

const EVAL_ID_MARKER = "eval";

class EvalRunner {
    // ── Public Functions ─────────────────────────────────────────────

    // Runs `items` through `handler` with bounded concurrency, and with the
    // draft context applied around the whole batch rather than per item.
    async withTarget({ orgId, target, run }) {
        console.log("EvalRunner:withTarget: orgId:", orgId, "target:", target);
        return evalContext.run({ orgId, target }, run);
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


}

module.exports = new EvalRunner();
module.exports.EVAL_ID_MARKER = EVAL_ID_MARKER;
