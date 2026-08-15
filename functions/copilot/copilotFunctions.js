const config = require("../../config/config");
const { IdPrefix, FeatureKey, MessageRole } = require("../../config/enums");
const CopilotThread = require("../../models/copilot/copilotThread");
const Conversation = require("../../models/conversation/conversation");
const Message = require("../../models/conversation/message");
const Org = require("../../models/org/org");
const generalFunctions = require("../utilFunctions/generalFunctions");
const llmFunctions = require("../utilFunctions/llmFunctions");
const agentFunctions = require("../agent/agentFunctions");
const guidanceFunctions = require("../config/guidanceFunctions");
const { planHasFeature } = require("../../config/plans");

// §5.1 — Copilot: the same retrieval pipeline, pointed at a support agent
// instead of a customer.
//
// Three deliberate differences from the customer-facing agent, and they are the
// entire product difference:
//
//   1. No abstention gate. A human asking "do we cover this?" wants "nothing in
//      the knowledge base covers it", not silence. The customer-facing agent
//      abstains because a wrong answer reaches a customer; here the human is
//      the filter.
//   2. No write actions, ever. Copilot drafts; the human sends. "Add to
//      composer" is the only output path, and there is no code path from here
//      to executing anything.
//   3. Internal sources included. Content marked internal is invisible to
//      customers and visible here, which is most of why a support team wants
//      this at all.

const MAX_HISTORY = 12;

class CopilotFunctions {
    // ── Public Functions ─────────────────────────────────────────────

    async getThread({ orgId, conversationId, memberEmail }) {
        console.log("CopilotFunctions:getThread: conversationId:", conversationId);
        try {
            const thread = await CopilotThread.findOne({
                orgId,
                conversationId: conversationId || null,
                memberEmail,
            }).lean();

            if (!thread) return { status: 200, json: { success: true, data: { messages: [] } } };

            const copy = { ...thread };
            delete copy._id;
            delete copy.__v;
            return { status: 200, json: { success: true, data: copy } };
        } catch (error) {
            console.error("CopilotFunctions:getThread: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async ask({ orgId, conversationId, memberEmail, question }) {
        console.log("CopilotFunctions:ask: orgId:", orgId, "conversationId:", conversationId);
        try {
            if (!question || !String(question).trim()) {
                return { status: 400, json: { success: false, error: "Ask a question" } };
            }

            const org = await Org.findOne({ orgId }).lean();
            if (!org) return { status: 404, json: { success: false, error: "Org not found" } };

            // Sold as seats, so it is gated on the plan. Checked here rather
            // than only at the route because the command palette calls this too.
            if (!planHasFeature((org.credits && org.credits.plan) || "FREE", FeatureKey.COPILOT)) {
                return {
                    status: 402,
                    json: { success: false, error: "Copilot is not included on your plan", reason: "PLAN_FEATURE" },
                };
            }

            const thread = await this._loadOrCreateThread({ orgId, conversationId, memberEmail });

            // The customer conversation as context, when there is one. This is
            // what makes "what should I say?" answerable rather than requiring
            // the agent to restate the whole ticket.
            const customerContext = conversationId
                ? await this._loadCustomerContext({ orgId, conversationId })
                : "";

            // Retrieval reuses the agent's hybrid search. Same index, same
            // fusion, same everything — there is no second retrieval stack to
            // keep in step.
            const candidates = await agentFunctions._hybridSearch({ orgId, query: question });
            const topChunks = candidates.slice(0, 8);

            const identity = guidanceFunctions.composeIdentityAndContext({ org });
            const numbered = topChunks.map((chunk, index) => ({
                index: index + 1,
                chunkId: chunk.chunkId,
                sourceId: chunk.sourceId,
                heading: (chunk.headingPath || []).join(" › "),
                text: chunk.text,
            }));

            const result = await llmFunctions.completeJson({
                model: config.LARGE_MODEL,
                system: `You are Copilot, helping a support agent at ${org.name}. You are talking to a colleague, not a customer.

- Answer from the knowledge below. Cite with [1], [2] matching the numbered sources.
- If the knowledge does not cover it, say so plainly and say what you would check. Do not refuse to engage.
- When asked to draft a reply, write the reply itself in "draft", ready to paste. No preamble, no "here is a draft".
- Be direct. You are talking to someone who does this all day.

${identity.prompt}`,
                schemaHint: `{"answer": string, "draft": string, "citedIndexes": number[]}`,
                messages: [
                    ...thread.messages.slice(-MAX_HISTORY).map((message) => ({
                        role: message.role === "USER" ? "user" : "assistant",
                        content: message.content,
                    })),
                    {
                        role: "user",
                        content: [
                            customerContext ? `CUSTOMER CONVERSATION:\n${customerContext}\n` : "",
                            numbered.length > 0
                                ? `KNOWLEDGE:\n${numbered.map((chunk) => `[${chunk.index}] (${chunk.heading})\n${chunk.text}`).join("\n\n")}\n`
                                : "KNOWLEDGE: nothing matched this query.\n",
                            `AGENT'S QUESTION: ${question}`,
                        ]
                            .filter(Boolean)
                            .join("\n"),
                    },
                ],
                maxTokens: 1500,
            });

            const answer = result.json.answer || "";
            const cited = (result.json.citedIndexes || [])
                .map((index) => numbered.find((chunk) => chunk.index === index))
                .filter(Boolean)
                .map((chunk) => ({
                    index: chunk.index,
                    chunkId: chunk.chunkId,
                    sourceId: chunk.sourceId,
                    heading: chunk.heading,
                }));

            thread.messages.push({ role: "USER", content: question, citations: [], createdAt: new Date() });
            thread.messages.push({ role: "ASSISTANT", content: answer, citations: cited, createdAt: new Date() });
            thread.totalCostUsd += generalFunctions.estimateCostUsd({
                model: config.LARGE_MODEL,
                inputTokens: result.inputTokens || 0,
                outputTokens: result.outputTokens || 0,
            });
            await thread.save();

            return {
                status: 200,
                json: {
                    success: true,
                    data: {
                        answer,
                        // Present only when the agent asked for a draft. The
                        // panel shows "Add to composer" when it is there and
                        // nothing when it is not — never auto-sends, in either
                        // case.
                        draft: result.json.draft || null,
                        citations: cited,
                        copilotThreadId: thread.copilotThreadId,
                    },
                },
            };
        } catch (error) {
            console.error("CopilotFunctions:ask: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // AI Compose: draft a reply to the customer from the thread so far. Returns
    // text for the composer and writes NOTHING to the customer conversation.
    async compose({ orgId, conversationId, memberEmail, instruction }) {
        console.log("CopilotFunctions:compose: conversationId:", conversationId);
        try {
            const conversation = await Conversation.findOne({ orgId, conversationId }).lean();
            if (!conversation) return { status: 404, json: { success: false, error: "Conversation not found" } };

            const result = await this.ask({
                orgId,
                conversationId,
                memberEmail,
                question: instruction
                    ? `Draft a reply to this customer. ${instruction}`
                    : "Draft a reply to this customer's latest message.",
            });

            if (result.status !== 200) return result;

            return {
                status: 200,
                json: {
                    success: true,
                    data: {
                        draft: result.json.data.draft || result.json.data.answer,
                        citations: result.json.data.citations,
                    },
                    // Stated in the response, because the one thing that must
                    // never happen here is an accidental send.
                    note: "This is a draft. Nothing has been sent to the customer.",
                },
            };
        } catch (error) {
            console.error("CopilotFunctions:compose: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async clearThread({ orgId, conversationId, memberEmail }) {
        console.log("CopilotFunctions:clearThread: conversationId:", conversationId);
        try {
            await CopilotThread.deleteOne({ orgId, conversationId: conversationId || null, memberEmail });
            return { status: 200, json: { success: true, data: { cleared: true } } };
        } catch (error) {
            console.error("CopilotFunctions:clearThread: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // ── Private Helper Functions ─────────────────────────────────────

    async _loadOrCreateThread({ orgId, conversationId, memberEmail }) {
        const existing = await CopilotThread.findOne({ orgId, conversationId: conversationId || null, memberEmail });
        if (existing) return existing;

        return CopilotThread.create({
            orgId,
            copilotThreadId: generalFunctions.generateId(IdPrefix.COPILOT_THREAD),
            conversationId: conversationId || null,
            memberEmail,
        });
    }

    async _loadCustomerContext({ orgId, conversationId }) {
        const messages = await Message.find({ orgId, conversationId })
            .sort({ createdAt: -1 })
            .limit(12)
            .lean();
        return messages
            .reverse()
            .map((message) => {
                const speaker =
                    message.role === MessageRole.USER
                        ? "customer"
                        : message.role === MessageRole.HUMAN_AGENT
                          ? "your teammate"
                          : "the agent";
                return `${speaker}: ${message.content}`;
            })
            .join("\n");
    }
}

module.exports = new CopilotFunctions();
module.exports.MAX_HISTORY = MAX_HISTORY;
