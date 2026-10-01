const config = require("../../config/config");
const {
    TurnOutcome,
    AccessType,
    BlockReason,
    GateIntent,
    GateSentiment,
    ToolCallStatus,
    ConversationChannel,
    Channel,
} = require("../../config/enums");
const Chunk = require("../../models/knowledge/chunk");
const Table = require("../../models/table/table");
const TableRow = require("../../models/table/tableRow");
const Action = require("../../models/action/action");
const Procedure = require("../../models/procedure/procedure");
const TurnTrace = require("../../models/trace/turnTrace");
const generalFunctions = require("../utilFunctions/generalFunctions");
const redactionFunctions = require("../utilFunctions/redactionFunctions");
const llmFunctions = require("../utilFunctions/llmFunctions");
const searchFunctions = require("../knowledge/searchFunctions");
const actionFunctions = require("../action/actionFunctions");
const guidanceFunctions = require("../config/guidanceFunctions");
const procedureFunctions = require("../procedure/procedureFunctions");

class AgentFunctions {
    // The whole pipeline. Six stages, order is the contract. Returns
    // { success, reply, citations, toolCalls, outcome, halted }.
    // The TurnTrace is written on EVERY turn, including blocked and failed ones.
    async runTurn({ org, conversation, endUser, identityVerified, rawMessage, history, channel, onProgress }) {
        console.log("AgentFunctions:runTurn: orgId:", org.orgId, "conversationId:", conversation.conversationId);

        const trace = {
            orgId: org.orgId,
            traceId: generalFunctions.generateId("trc"),
            conversationId: conversation.conversationId,
            turn: conversation.turnCount + 1,
            rawQuery: rawMessage,
            rewrittenQuery: null,
            candidateCount: 0,
            topChunks: [],
            belowThreshold: false,
            procedureId: null,
            model: config.ANSWER_MODEL,
            inputTokens: 0,
            outputTokens: 0,
            iterations: 0,
            grounded: null,
            answersQuery: null,
            unsupportedClaims: [],
            appliedRuleIds: [],
            escalationRuleId: null,
            segmentIds: [],
            channel: channel || ConversationChannel.CHAT,
            outcome: TurnOutcome.ERROR,
            latencyMs: { gate: 0, rewrite: 0, retrieve: 0, rerank: 0, generate: 0, validate: 0 },
            costUsd: 0,
            contextChunkCount: 0,
            repairAttempted: false,
            repairSucceeded: false,
        };

        let result;
        try {
            result = await this._runPipeline({ org, conversation, endUser, identityVerified, rawMessage, history, channel, trace, onProgress });
        } catch (error) {
            console.error("AgentFunctions:runTurn: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            trace.outcome = TurnOutcome.ERROR;
            result = {
                success: false,
                reply: "Something went wrong on my end. I've flagged this for the team — please try again in a moment.",
                citations: [],
                toolCalls: [],
                outcome: TurnOutcome.ERROR,
                halted: false,
            };
        } finally {
            // Unconditional. The trace is the eval set, the content-gap source and
            // the cost attribution source — it cannot be reconstructed later.
            await this._writeTrace(trace);
        }

        result.costUsd = trace.costUsd;
        result.inputTokens = trace.inputTokens;
        result.outputTokens = trace.outputTokens;
        // Handed back so attribute detection can reuse the Gate's sentiment
        // instead of paying a second model call to re-derive it (§2.3).
        result.sentiment = trace.gateSentiment || null;
        result.traceId = trace.traceId;
        return result;
    }

    // Private Helper Functions

    async _runPipeline({ org, conversation, endUser, identityVerified, rawMessage, history, channel, trace, onProgress }) {
        // Progress is advisory. It feeds the widget's typing bubble over the
        // socket and nothing else, so a listener that throws must not be able
        // to fail the turn.
        const report = (stage, detail) => {
            if (typeof onProgress !== "function") return;
            try {
                onProgress({ stage, ...(detail || {}) });
            } catch (error) {
                console.log("AgentFunctions:_runPipeline: progress listener threw, ignoring");
            }
        };

        // Stage 0 — gate (fail open) and Stage 1 — rewrite, started together.
        // Neither reads the other's output: the gate classifies the raw message,
        // the rewrite resolves it against history. Run serially they cost a
        // full small-model round trip on every follow-up turn, spent waiting
        // for a verdict the rewrite never needed. Blocked, escalated and
        // chitchat turns throw the rewrite away — one cheap call wasted on the
        // rare path against one saved on the common one.
        //
        // A first turn has no rewrite, so its query is the raw message and the
        // embedding can start now as well, instead of after the gate returns.
        report("classifying");
        const gateStart = Date.now();
        const firstTurn = trace.turn <= 1 || !history || history.length === 0;
        const rewritePromise = this._runRewrite({ rawMessage, history, turn: trace.turn, trace })
            .catch(() => rawMessage)
            .then((query) => {
                trace.latencyMs.rewrite = firstTurn ? 0 : Date.now() - gateStart;
                return query;
            });
        let queryEmbeddingPromise = null;
        if (firstTurn) {
            queryEmbeddingPromise = llmFunctions.embed({ texts: [rawMessage] });
            // Observed later inside _hybridSearch. Without this, a rejection
            // that lands while the gate is still running is an unhandled one.
            queryEmbeddingPromise.catch(() => {});
        }
        const gate = await this._runGate({ rawMessage, trace });
        trace.latencyMs.gate = Date.now() - gateStart;
        trace.gateIntent = gate.intent;
        trace.gateLanguage = gate.language;
        trace.gateSentiment = gate.sentiment;
        trace.gateSafe = gate.safe;

        // Stage 0b — configuration (§2). Loaded after the gate because half the
        // condition fields — sentiment, intent, language — are the gate's
        // output, and an escalation rule that cannot read them would be limited
        // to turn counts.
        const configContext = this._buildConditionContext({ org, conversation, endUser, identityVerified, gate });
        const guidance = await guidanceFunctions.loadForTurn({
            orgId: org.orgId,
            context: configContext,
            channel: channel === ConversationChannel.EMAIL ? Channel.EMAIL : Channel.CHAT,
        });
        trace.appliedRuleIds = guidance.appliedRuleIds;
        trace.segmentIds = guidance.segmentIds;

        if (!gate.safe) {
            trace.outcome = TurnOutcome.BLOCKED;
            return {
                success: true,
                reply: "I can't help with that. If you have a question about our product or your account, I'm happy to help.",
                citations: [],
                toolCalls: [],
                outcome: TurnOutcome.BLOCKED,
                halted: false,
            };
        }

        if (gate.intent === GateIntent.HUMAN_REQUEST) {
            trace.outcome = TurnOutcome.ESCALATED;
            return {
                success: true,
                reply: `Of course — I'm looping in the ${org.name} team now. They'll pick this up right here with full context.`,
                citations: [],
                toolCalls: [],
                outcome: TurnOutcome.ESCALATED,
                halted: false,
                escalate: true,
            };
        }

        // A deterministic escalation rule matched (§2.2). Checked before
        // retrieval and generation, not after: the whole point of the
        // deterministic half is that it does not depend on what the model
        // decides, and running the pipeline first would spend the tokens anyway.
        if (guidance.escalation.triggered) {
            trace.outcome = TurnOutcome.ESCALATED;
            trace.escalationRuleId = guidance.escalation.rule.escalationRuleId;
            return {
                success: true,
                reply: `I'm bringing in the ${org.name} team on this one — they'll pick it up right here with everything you've told me.`,
                citations: [],
                toolCalls: [],
                outcome: TurnOutcome.ESCALATED,
                halted: false,
                escalate: true,
                escalationRule: guidance.escalation.rule,
            };
        }

        // Chitchat skips retrieval entirely
        if (gate.intent === GateIntent.CHITCHAT) {
            const reply = await this._runChitchat({ org, rawMessage, trace });
            trace.outcome = TurnOutcome.ANSWERED;
            return { success: true, reply, citations: [], toolCalls: [], outcome: TurnOutcome.ANSWERED, halted: false };
        }

        // Stage 1 — rewrite, running since the gate started.
        const query = await rewritePromise;

        // Stage 2 — retrieval: all four loads in parallel
        report("searching");
        const retrieveStart = Date.now();
        const [candidates, tableContext, availableActions, procedure] = await Promise.all([
            this._hybridSearch({ orgId: org.orgId, query, rawQuery: rawMessage, queryEmbeddingPromise }),
            this._loadTables({ orgId: org.orgId, endUser, identityVerified }),
            this._loadActions({ orgId: org.orgId }),
            this._loadProcedures({ orgId: org.orgId, query }),
        ]);
        trace.latencyMs.retrieve = Date.now() - retrieveStart;
        trace.candidateCount = candidates.length;
        trace.procedureId = procedure ? procedure.procedureId : null;

        // Stage 3 — rerank + abstention gate
        report("reading", { sources: candidates.length });
        const rerankStart = Date.now();
        const { topChunks, belowThreshold } = await this._runRerank({ query, candidates, trace });
        trace.latencyMs.rerank = Date.now() - rerankStart;
        trace.topChunks = topChunks.map((chunk) => ({
            chunkId: chunk.chunkId,
            vectorScore: chunk.vectorScore || 0,
            textScore: chunk.textScore || 0,
            rerankScore: chunk.rerankScore || 0,
        }));
        trace.belowThreshold = belowThreshold;

        if (belowThreshold && tableContext.rows.length === 0) {
            trace.outcome = TurnOutcome.ABSTAINED;
            return {
                success: true,
                reply: "I don't have enough in my knowledge base to answer that confidently. Would you like me to connect you with the team?",
                citations: [],
                toolCalls: [],
                outcome: TurnOutcome.ABSTAINED,
                halted: false,
            };
        }

        // Stage 3b — neighbour expansion (small-to-big). Reranking picks the
        // 600-token chunk that best matches the question, and the answer is
        // routinely in the chunk next to it: step 4 of a procedure whose steps
        // 1–3 scored, the exception paragraph under the policy heading. Each
        // top chunk is widened to its immediate neighbours in the same
        // document and overlapping windows are merged, so the model reads one
        // passage rather than the same paragraph twice. Citations still name
        // the chunk that matched. The validator reads the widened context too;
        // otherwise a claim taken from a neighbour would be judged unsupported
        // by the very text it came from.
        const contextChunks = await this._expandNeighbors({ orgId: org.orgId, topChunks });
        trace.contextChunkCount = contextChunks.length;

        // Stage 4 — generate (answer, clarifying question, or tool call loop)
        report("writing");
        const generateStart = Date.now();
        const generateArgs = {
            org,
            conversation,
            endUser,
            identityVerified,
            query,
            rawMessage,
            history,
            topChunks: contextChunks,
            tableContext,
            availableActions,
            procedure,
            guidance,
            trace,
        };
        let generation = await this._runGenerate(generateArgs);
        trace.latencyMs.generate = Date.now() - generateStart;

        if (generation.halted) {
            // A write action was proposed. The loop breaks, the user confirms, and
            // execution happens on the NEXT turn via the confirm endpoint. This is
            // the single most important property in the system.
            trace.outcome = TurnOutcome.CLARIFIED;
            return { ...generation, success: true, outcome: TurnOutcome.CLARIFIED };
        }

        if (generation.outcome === TurnOutcome.CLARIFIED || generation.outcome === TurnOutcome.BLOCKED) {
            trace.outcome = generation.outcome;
            return { ...generation, success: true };
        }

        // Stage 5 — validate (fail closed)
        report("checking");
        const validateStart = Date.now();
        let verdict = await this._runValidate({ query, reply: generation.reply, topChunks: contextChunks, tableContext, trace });
        trace.latencyMs.validate = Date.now() - validateStart;
        trace.grounded = verdict.grounded;
        trace.answersQuery = verdict.answersQuery;
        trace.unsupportedClaims = verdict.unsupportedClaims;

        // Stage 5b — one repair pass. The validator names the claims it could
        // not find in the context. When the answer otherwise addresses the
        // question, that list is a precise edit request, and paying one more
        // generate call to act on it is far cheaper than abstaining on an
        // answer that was four-fifths right. The repaired text goes through
        // the validator again on the same terms: it is never shown unchecked,
        // and a second failure abstains exactly as before. Once only — a loop
        // here is a model arguing with a validator on the customer's clock.
        if (this._isRepairable({ generation, verdict })) {
            report("repairing");
            trace.repairAttempted = true;
            const repairStart = Date.now();
            const repaired = await this._runGenerate({
                ...generateArgs,
                repair: { previousReply: generation.reply, unsupportedClaims: verdict.unsupportedClaims },
            });
            trace.latencyMs.generate += Date.now() - repairStart;
            if (repaired.outcome === TurnOutcome.ANSWERED && !repaired.halted && repaired.reply) {
                const recheckStart = Date.now();
                const second = await this._runValidate({
                    query,
                    reply: repaired.reply,
                    topChunks: contextChunks,
                    tableContext,
                    trace,
                });
                trace.latencyMs.validate += Date.now() - recheckStart;
                if (second.grounded && second.answersQuery) {
                    generation = repaired;
                    verdict = second;
                    trace.repairSucceeded = true;
                    trace.grounded = second.grounded;
                    trace.answersQuery = second.answersQuery;
                    trace.unsupportedClaims = second.unsupportedClaims;
                }
            }
        }

        if (!verdict.grounded || !verdict.answersQuery) {
            trace.outcome = TurnOutcome.ABSTAINED;
            return {
                success: true,
                reply: "I'm not confident enough in my answer to share it. Would you like me to bring in a teammate?",
                citations: [],
                toolCalls: generation.toolCalls,
                outcome: TurnOutcome.ABSTAINED,
                halted: false,
            };
        }

        trace.outcome = TurnOutcome.ANSWERED;
        // The Answer Receipt — the user-facing proof trail. Everything in it is
        // read straight from this turn's real pipeline state, never synthesized.
        const receipt = {
            searched: candidates.length,
            read: [...new Set(
                topChunks.map((chunk) => (chunk.headingPath || []).join(" › ")).filter(Boolean)
            )].slice(0, 4),
            grounded: verdict.grounded === true,
            answersQuery: verdict.answersQuery === true,
            tookMs: Object.values(trace.latencyMs).reduce((total, ms) => total + ms, 0),
        };
        return { ...generation, success: true, outcome: TurnOutcome.ANSWERED, receipt };
    }

    async _runGate({ rawMessage, trace }) {
        try {
            const result = await llmFunctions.completeJson({
                model: config.SMALL_MODEL,
                system: "You are a message classifier for a customer support agent.",
                schemaHint: `{"language": "ISO 639-1", "intent": "${Object.values(GateIntent).join("|")}", "sentiment": "${Object.values(GateSentiment).join("|")}", "safe": boolean}`,
                messages: [{ role: "user", content: `Classify this customer message: ${JSON.stringify(rawMessage)}` }],
                maxTokens: 128,
            });
            this._addUsage(trace, config.SMALL_MODEL, result);
            return {
                language: result.json.language || "en",
                intent: Object.values(GateIntent).includes(result.json.intent) ? result.json.intent : GateIntent.QUESTION,
                sentiment: Object.values(GateSentiment).includes(result.json.sentiment) ? result.json.sentiment : GateSentiment.NEUTRAL,
                safe: result.json.safe !== false,
            };
        } catch (error) {
            // Fail open with safe defaults — a classifier outage must not take the product down.
            console.log("AgentFunctions:_runGate: failed open");
            console.error(error);
            generalFunctions.captureException(error);
            trace.gateFailedOpen = true;
            return { language: "en", intent: GateIntent.QUESTION, sentiment: GateSentiment.NEUTRAL, safe: true };
        }
    }

    async _runChitchat({ org, rawMessage, trace }) {
        try {
            const result = await llmFunctions.complete({
                model: config.SMALL_MODEL,
                system: `You are ${org.agent.name}, the friendly support agent for ${org.name}. Reply to this greeting or pleasantry in one or two short sentences. Do not invent product facts.`,
                messages: [{ role: "user", content: rawMessage }],
                maxTokens: 128,
            });
            this._addUsage(trace, config.SMALL_MODEL, result);
            return result.text.trim();
        } catch (error) {
            console.log("AgentFunctions:_runChitchat: fallback greeting");
            console.error(error);
            generalFunctions.captureException(error);
            return `Hi! I'm ${org.agent.name}. How can I help you today?`;
        }
    }

    async _runRewrite({ rawMessage, history, turn, trace }) {
        if (turn <= 1 || !history || history.length === 0) {
            return rawMessage;
        }
        try {
            const recent = history
                .slice(-6)
                .map((message) => `${message.role}: ${message.content}`)
                .join("\n");
            const result = await llmFunctions.completeJson({
                model: config.SMALL_MODEL,
                system: "Rewrite the user's latest message as a standalone search query, resolving only necessary pronouns and references from the conversation. Keep it short and preserve the user's intent. If the message is already standalone, return it unchanged. Never add lists of products, alternatives, assumptions, or facts the user did not ask about. 'You' refers to the support agent, not a product mentioned earlier.",
                schemaHint: `{"query": string}`,
                messages: [{ role: "user", content: `Conversation:\n${recent}\n\nLatest message: ${JSON.stringify(rawMessage)}` }],
                maxTokens: 128,
            });
            this._addUsage(trace, config.SMALL_MODEL, result);
            const rewritten = (result.json.query || "").trim();
            if (rewritten && rewritten !== rawMessage) {
                trace.rewrittenQuery = rewritten;
                return rewritten;
            }
            return rawMessage;
        } catch (error) {
            // Rewrite fails → use the raw message.
            console.log("AgentFunctions:_runRewrite: failed, using raw message");
            console.error(error);
            generalFunctions.captureException(error);
            return rawMessage;
        }
    }

    // Shared retrieval with the help centre. Keep these small wrappers so
    // pipeline tests can isolate providers without replacing fallback ranking.
    async _hybridSearch({ orgId, query, rawQuery, queryEmbeddingPromise }) {
        return searchFunctions.hybridSearch({
            orgId, query, rawQuery, queryEmbeddingPromise,
            vectorSearch: (args) => this._vectorSearch(args),
            textSearch: (args) => this._textSearch(args),
        });
    }

    async _vectorSearch(args) {
        return searchFunctions.vectorSearch(args);
    }

    async _textSearch(args) {
        return searchFunctions.textSearch(args);
    }

    async _keywordSearch(args) {
        return searchFunctions.keywordSearch(args);
    }

    // Verified identity unlocks the user's own table rows — nobody else's.
    async _loadTables({ orgId, endUser, identityVerified }) {
        if (!identityVerified || !endUser || !endUser.email) {
            return { tables: [], rows: [] };
        }
        const tables = await Table.find({ orgId }).lean();
        if (tables.length === 0) {
            return { tables: [], rows: [] };
        }
        const rows = await TableRow.find({
            orgId,
            tableId: { $in: tables.map((table) => table.tableId) },
            identityValue: endUser.email,
        })
            .limit(50)
            .lean();
        return { tables, rows };
    }

    // An action that has never passed a test call is never even shown to the model.
    async _loadActions({ orgId }) {
        return Action.find({ orgId, enabled: true, lastTestStatus: "PASS" }).lean();
    }

    // §5.4 — keyword first, then intent classification only when a procedure
    // actually wants it. See procedureFunctions.selectForTurn.
    async _loadProcedures({ orgId, query }) {
        const selected = await procedureFunctions.selectForTurn({ orgId, query });
        return selected.procedure || null;
    }

    async _runRerank({ query, candidates, trace }) {
        if (candidates.length === 0) {
            return { topChunks: [], belowThreshold: true };
        }
        try {
            const ranked = await llmFunctions.rerank({
                query,
                documents: candidates.map((candidate) => `${(candidate.headingPath || []).join(" > ")}\n${candidate.text}`),
                topN: config.RERANK_TOP_N,
            });
            const topChunks = ranked.map((entry) => ({
                ...candidates[entry.index],
                rerankScore: entry.score,
            }));
            const best = topChunks.length > 0 ? topChunks[0].rerankScore : 0;
            return { topChunks, belowThreshold: best < config.RERANK_THRESHOLD };
        } catch (error) {
            // Rerank fails → degrade to fusion order and SKIP the threshold check.
            // Validation still runs downstream.
            console.log("AgentFunctions:_runRerank: failed, degrading to fusion order");
            console.error(error);
            generalFunctions.captureException(error);
            return { topChunks: candidates.slice(0, config.RERANK_TOP_N), belowThreshold: false };
        }
    }

    async _runGenerate({ org, conversation, endUser, identityVerified, query, rawMessage, history, topChunks, tableContext, availableActions, procedure, guidance, trace, repair }) {
        const { prompt: system, maxTokens } = this._buildSystemPrompt({
            org,
            topChunks,
            tableContext,
            availableActions,
            procedure,
            identityVerified,
            guidance,
        });
        const messages = [
            ...(history || []).slice(-10).map((message) => ({
                role: message.role === "USER" ? "user" : "assistant",
                content: message.content,
            })),
            { role: "user", content: rawMessage },
        ];
        if (repair && repair.previousReply) {
            // The repair pass. The model sees its own answer and the exact
            // claims the validator rejected, and is asked to rewrite from the
            // context alone. Framed as a conversation turn rather than a new
            // system prompt so the history, the knowledge and the guards are
            // all exactly what the first attempt saw.
            messages.push({ role: "assistant", content: repair.previousReply });
            messages.push({
                role: "user",
                content:
                    `A reviewer checked that answer against the KNOWLEDGE and CUSTOMER DATA and could not find support for these claims:\n` +
                    repair.unsupportedClaims.map((claim) => `- ${claim}`).join("\n") +
                    `\n\nRewrite the answer using only what the context states. Remove or correct every claim above. ` +
                    `If the context cannot answer the question without them, say plainly what it does and does not cover. ` +
                    `Reply in the same JSON format.`,
            });
        }

        const toolCalls = [];
        for (let iteration = 0; iteration < config.MAX_TOOL_ITERATIONS; iteration++) {
            trace.iterations = iteration + 1;
            let result;
            try {
                result = await llmFunctions.completeJson({
                    model: config.ANSWER_MODEL,
                    system,
                    schemaHint: `{"type": "answer", "text": string, "citationChunkIds": string[], "followUps": string[]} OR {"type": "clarify", "text": string} OR {"type": "tool_call", "actionId": string, "args": object}`,
                    messages,
                    // Comes from the workspace's answer-length setting (§2.8). A
                    // model told to be concise and handed a thousand tokens uses
                    // them, so the instruction and the ceiling move together.
                    maxTokens: maxTokens || config.MAX_OUTPUT_TOKENS,
                });
            } catch (error) {
                /* The model sometimes writes a perfectly good answer and simply
                   does not wrap it in JSON. Discarding that and showing the
                   visitor "something went wrong" is the worse failure: we had
                   the answer and threw it away.

                   Salvaging is safe because it changes nothing downstream —
                   the reply still goes through Stage 5 validation, so prose
                   that is not grounded in the retrieved chunks abstains exactly
                   as a malformed-JSON answer would have. What it cannot do is
                   call a tool: a tool call has arguments, and guessing those
                   from prose is precisely the kind of invention this pipeline
                   exists to prevent. */
                const salvaged = String(error && error.rawText ? error.rawText : "").trim();
                const usable = salvaged.length > 20 && !salvaged.startsWith("{") && !salvaged.startsWith("[");
                if (!usable) throw error;
                console.log("AgentFunctions:_runGenerate: salvaged prose from a non-JSON answer");
                trace.jsonSalvaged = true;
                return {
                    reply: salvaged,
                    citations: [],
                    toolCalls,
                    outcome: TurnOutcome.ANSWERED,
                    halted: false,
                };
            }
            this._addUsage(trace, config.ANSWER_MODEL, result);
            const output = result.json;

            if (output.type === "clarify") {
                return { reply: output.text, citations: [], toolCalls, outcome: TurnOutcome.CLARIFIED, halted: false };
            }

            if (output.type === "tool_call") {
                const action = availableActions.find((candidate) => candidate.actionId === output.actionId) || null;
                if (action) {
                    const resolved = actionFunctions.resolveDataInputs({ action, args: output.args || {},
                        context: { email: endUser?.email, identityVerified } });
                    output.args = resolved.resolved;
                    if (resolved.missing.length) {
                        return { reply: resolved.missing.map((input) => input.prompt).join(" "),
                            citations: [], toolCalls, outcome: TurnOutcome.CLARIFIED, halted: false };
                    }
                }
                const blockReason = await this._checkGuards({
                    action,
                    args: output.args,
                    identityVerified,
                    confirmed: false,
                });

                if (action && action.accessType === AccessType.WRITE && blockReason === BlockReason.CONFIRMATION_REQUIRED) {
                    // Halt. The model proposes, the user confirms, execution is next turn.
                    toolCalls.push({
                        actionId: action.actionId,
                        actionName: action.name,
                        args: output.args,
                        status: ToolCallStatus.AWAITING_CONFIRMATION,
                    });
                    return {
                        reply: `I'd like to run “${action.name}” for you. Please confirm and I'll take care of it.`,
                        citations: [],
                        toolCalls,
                        outcome: TurnOutcome.CLARIFIED,
                        halted: true,
                        pendingAction: { actionId: action.actionId, args: output.args, endUserId: endUser ? endUser.endUserId : null },
                    };
                }

                if (blockReason) {
                    toolCalls.push({
                        actionId: output.actionId,
                        actionName: action ? action.name : output.actionId,
                        args: output.args,
                        status: ToolCallStatus.BLOCKED,
                    });
                    trace.outcome = TurnOutcome.BLOCKED;
                    return {
                        reply: this._blockReasonMessage({ blockReason, org }),
                        citations: [],
                        toolCalls,
                        outcome: TurnOutcome.BLOCKED,
                        halted: false,
                    };
                }

                // READ action, all guards pass → execute inline and iterate
                const execution = await actionFunctions.executeAction({
                    orgId: org.orgId,
                    actionId: action.actionId,
                    args: output.args,
                    conversationId: conversation.conversationId,
                    endUserId: endUser ? endUser.endUserId : null,
                    confirmed: false,
                    identityVerified,
                    identity: endUser ? { email: endUser.email, verified: identityVerified } : null,
                });
                toolCalls.push({
                    actionId: action.actionId,
                    actionName: action.name,
                    args: output.args,
                    status: execution.success ? ToolCallStatus.EXECUTED : ToolCallStatus.BLOCKED,
                    executionId: execution.executionId || null,
                });
                messages.push({ role: "assistant", content: JSON.stringify(output) });
                messages.push({
                    role: "user",
                    content: `[tool result for ${action.name}]: ${JSON.stringify(execution.success ? execution.data : { error: execution.error })}`,
                });
                continue;
            }

            // Default: answer
            const citations = (output.citationChunkIds || [])
                .map((chunkId) => topChunks.find((chunk) => chunk.chunkId === chunkId))
                .filter(Boolean)
                .map((chunk) => ({
                    chunkId: chunk.chunkId,
                    sourceId: chunk.sourceId,
                    heading: (chunk.headingPath || []).join(" › "),
                }));
            return {
                reply: output.text,
                citations,
                toolCalls,
                outcome: TurnOutcome.ANSWERED,
                halted: false,
                followUps: this._cleanFollowUps({ followUps: output.followUps, query, rawMessage }),
            };
        }

        // Tool loop exhausted without an answer
        return {
            reply: "I wasn't able to complete that. Let me bring in a teammate to help.",
            citations: [],
            toolCalls,
            outcome: TurnOutcome.ESCALATED,
            halted: false,
        };
    }

    async _runValidate({ query, reply, topChunks, tableContext, trace }) {
        try {
            const context = [
                ...topChunks.map((chunk) => chunk.text),
                ...tableContext.rows.map((row) => JSON.stringify(row.data)),
            ].join("\n---\n");
            const result = await llmFunctions.completeJson({
                model: config.SMALL_MODEL,
                system: "You are a strict validator. Check whether the answer is fully supported by the context and actually addresses the question.",
                schemaHint: `{"grounded": boolean, "answersQuery": boolean, "unsupportedClaims": string[]}`,
                messages: [
                    {
                        role: "user",
                        content: `Question: ${query}\n\nContext:\n${context}\n\nAnswer to validate: ${reply}`,
                    },
                ],
                maxTokens: 256,
            });
            this._addUsage(trace, config.SMALL_MODEL, result);
            return {
                grounded: result.json.grounded === true,
                answersQuery: result.json.answersQuery === true,
                unsupportedClaims: Array.isArray(result.json.unsupportedClaims) ? result.json.unsupportedClaims : [],
            };
        } catch (error) {
            // Fail closed — a validator outage must never become an unvalidated answer.
            console.log("AgentFunctions:_runValidate: failed closed");
            console.error(error);
            generalFunctions.captureException(error);
            return { grounded: false, answersQuery: false, unsupportedClaims: [] };
        }
    }

    // Guards live here, in code — not in the prompt. A model that decides to
    // skip a confirmation gets BLOCKED.
    async _checkGuards({ action, args, identityVerified, confirmed }) {
        if (!action || !action.enabled) return BlockReason.NOT_AVAILABLE;
        if (action.lastTestStatus !== "PASS") return BlockReason.NEVER_TESTED;
        if (action.requiresIdentity && !identityVerified) return BlockReason.IDENTITY_REQUIRED;
        if (action.accessType === AccessType.WRITE && confirmed !== true) {
            return BlockReason.CONFIRMATION_REQUIRED;
        }
        return null;
    }

    _blockReasonMessage({ blockReason, org }) {
        if (blockReason === BlockReason.IDENTITY_REQUIRED) {
            return "I can look that up once I've verified who you are. Please sign in on this site and try again.";
        }
        return `I'm not able to do that from chat just yet — I've flagged this conversation for the ${org.name} team.`;
    }

    // Returns { prompt, maxTokens } rather than a bare string: the answer-length
    // setting decides both, and splitting them across two call sites is how they
    // drift apart.
    //
    // Section order is fixed and deliberate. Identity and tone first because
    // they colour everything after; guidance next because it constrains how the
    // knowledge is used; knowledge, data and actions last because they are the
    // material rather than the instructions.
    _buildSystemPrompt({ org, topChunks, tableContext, availableActions, procedure, identityVerified, guidance }) {
        const parts = [];
        parts.push(
            `You are ${org.agent.name}, the customer support agent for ${org.name}. Answer ONLY from the context below. If the context does not contain the answer, say so plainly. Never invent facts, prices, or policies.`
        );
        parts.push("For broad comparison or recommendation questions, explain the supported options and decision criteria in the knowledge. If a recommendation requires the customer's goals or situation, ask one focused question with type clarify. Missing preferences alone are not a reason to offer a teammate.");
        parts.push("For a short topic with several possible meanings, ask one focused clarifying question with type clarify before assuming product capabilities. A clarification should ask for the missing detail, without introducing unsupported facts.");

        const identity = guidanceFunctions.composeIdentityAndContext({ org });
        if (identity.prompt) parts.push(identity.prompt);

        if (guidance && guidance.guidancePrompt) parts.push(guidance.guidancePrompt);
        if (guidance && guidance.escalationPrompt) parts.push(guidance.escalationPrompt);

        if (topChunks.length > 0) {
            parts.push(
                `KNOWLEDGE:\n${topChunks
                    .map((chunk) => `[${chunk.chunkId}] (${(chunk.headingPath || []).join(" › ")})\n${chunk.text}`)
                    .join("\n\n")}`
            );
        }

        if (tableContext.rows.length > 0) {
            parts.push(
                `CUSTOMER DATA (verified user's own rows):\n${tableContext.rows
                    .map((row) => JSON.stringify(row.data))
                    .join("\n")}`
            );
        }

        if (availableActions.length > 0) {
            parts.push(
                `ACTIONS you may call via {"type":"tool_call","actionId":...,"args":{...}}:\n${availableActions
                    .map(
                        (action) =>
                            `- ${action.actionId}: ${action.name} (${action.accessType}) — ${action.description}. Params: ${(action.params || [])
                                .map((param) => param.name)
                                .join(", ") || "none"}`
                    )
                    .join("\n")}`
            );
        }

        if (procedure) {
            // Rendered by procedureFunctions so branches are resolved in code
            // against this turn's context and the model sees only the
            // applicable path (§5.4). A model shown both sides of an IF picks
            // whichever it prefers, which makes the condition decorative.
            const rendered = procedureFunctions.renderForPrompt({
                procedure,
                context: guidance ? { segmentIds: guidance.segmentIds } : {},
                actionsById: new Map((availableActions || []).map((action) => [action.actionId, action])),
            });
            if (rendered) {
                parts.push(`PROCEDURE — you MUST follow these steps in order for this request:\n${rendered}`);
            }
        }

        parts.push(
            `Identity verified: ${identityVerified ? "yes" : "no"}. Cite knowledge chunk ids you used in citationChunkIds. If you need information only the user can provide, respond with {"type":"clarify",...}. In followUps, suggest up to ${config.FOLLOW_UPS_MAX} short questions (under 60 characters each) the customer is likely to ask next AND that the KNOWLEDGE above can answer; leave it empty rather than guess.`
        );
        return { prompt: parts.join("\n\n"), maxTokens: identity.maxTokens };
    }

    // Everything a condition may read, assembled once per turn (§2.6). Built
    // here rather than inside the evaluator so ten rules cost one assembly, and
    // so the set of readable fields is visible in one place next to the
    // allowlist that enforces it.
    _buildConditionContext({ org, conversation, endUser, identityVerified, gate }) {
        const attributes = {};
        for (const entry of conversation.attributes || []) {
            // Keyed by name as well as id: a rule written in the dashboard
            // references the attribute the author picked, and both spellings
            // reaching the evaluator is cheaper than making the author care.
            if (entry.name) attributes[entry.name] = entry.value;
            attributes[entry.attributeId] = entry.value;
        }

        return {
            identityVerified: identityVerified === true,
            turnCount: (conversation.turnCount || 0) + 1,
            sentiment: gate ? gate.sentiment : null,
            intent: gate ? gate.intent : null,
            language: gate ? gate.language : null,
            planId: (org.credits && org.credits.plan) || null,
            email: endUser ? endUser.email : null,
            conversationCount: endUser ? endUser.conversationCount || 0 : 0,
            firstSeenAt: endUser ? endUser.firstSeenAt : null,
            attributes,
            tableValues: {},
        };
    }

    // Repair is worth one more call only when the validator's complaint is
    // specific and the rest of the answer stands: it addressed the question,
    // it was a plain answer (not a clarification or a tool proposal), and the
    // validator produced claims to remove. "Does not answer the question" has
    // no edit that fixes it, and a validator that timed out names no claims.
    _isRepairable({ generation, verdict }) {
        if (!generation || !verdict) return false;
        if (generation.halted || generation.outcome !== TurnOutcome.ANSWERED) return false;
        if (!generation.reply || (generation.toolCalls || []).length > 0) return false;
        if (verdict.grounded || !verdict.answersQuery) return false;
        return Array.isArray(verdict.unsupportedClaims) && verdict.unsupportedClaims.length > 0;
    }

    // The model's follow-up suggestions, made safe to render as buttons: strings
    // only, trimmed, bounded in number and length, no duplicates, and never the
    // question that was just asked.
    _cleanFollowUps({ followUps, query, rawMessage }) {
        if (!Array.isArray(followUps)) return [];
        const seen = new Set([String(query || "").trim().toLowerCase(), String(rawMessage || "").trim().toLowerCase()]);
        const clean = [];
        for (const candidate of followUps) {
            if (typeof candidate !== "string") continue;
            const text = candidate.replace(/\s+/g, " ").trim();
            if (text.length < 4 || text.length > config.FOLLOW_UP_MAX_CHARS) continue;
            const key = text.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            clean.push(text);
            if (clean.length >= config.FOLLOW_UPS_MAX) break;
        }
        return clean;
    }

    // Small-to-big: widen the reranked chunks to their neighbours in the same
    // document, merge overlapping windows, and return one passage per window.
    // Each passage keeps the chunkId of the best-scoring chunk inside it so
    // the model's citations still resolve, and `memberChunkIds` records what
    // was actually read. Bounded by CONTEXT_MAX_TOKENS: passages are widened
    // in rerank order and a passage that would cross the budget is left as
    // the bare chunk. Any failure degrades to the input — retrieval already
    // succeeded, and a lookup problem must not turn that into an abstention.
    async _expandNeighbors({ orgId, topChunks }) {
        if (!Array.isArray(topChunks) || topChunks.length === 0) return [];
        try {
            const rows = await this._fetchChunkRows({ orgId, topChunks });
            if (!rows || rows.length === 0) return topChunks;

            const byId = new Map(rows.map((row) => [row.chunkId, row]));
            const scoreOf = new Map(topChunks.map((chunk) => [chunk.chunkId, chunk.rerankScore || 0]));
            const topIds = new Set(topChunks.map((chunk) => chunk.chunkId));

            // Group every fetched row (top chunks and neighbours) by document.
            const docs = new Map();
            for (const row of rows) {
                const key = `${row.sourceId}::${row.documentKey || ""}`;
                if (!docs.has(key)) docs.set(key, []);
                docs.get(key).push(row);
            }

            let budget = config.CONTEXT_MAX_TOKENS;
            const passages = [];
            const consumed = new Set();

            // Rerank order decides who gets widened first, whatever order the
            // caller handed them in.
            const ordered = [...topChunks].sort((a, b) => (b.rerankScore || 0) - (a.rerankScore || 0));
            for (const top of ordered) {
                if (consumed.has(top.chunkId)) continue;
                const row = byId.get(top.chunkId);
                if (!row) {
                    passages.push({ ...top, memberChunkIds: [top.chunkId] });
                    consumed.add(top.chunkId);
                    budget -= generalFunctions.estimateTokens(top.text || "");
                    continue;
                }
                const key = `${row.sourceId}::${row.documentKey || ""}`;
                const siblings = (docs.get(key) || []).slice().sort((a, b) => a.position - b.position);
                const wanted = siblings.filter(
                    (sibling) => !consumed.has(sibling.chunkId) && Math.abs(sibling.position - row.position) <= config.NEIGHBOR_EXPAND_RADIUS
                );
                // Only contiguous positions merge; a gap means the middle chunk
                // was not fetched, and stitching across it would fabricate a
                // sentence.
                const window = [];
                for (const sibling of wanted) {
                    if (window.length > 0 && sibling.position !== window[window.length - 1].position + 1) {
                        if (window.some((member) => member.chunkId === row.chunkId)) break;
                        window.length = 0;
                    }
                    window.push(sibling);
                }
                const windowTokens = window.reduce((sum, member) => sum + (member.tokenCount || generalFunctions.estimateTokens(member.text)), 0);
                const ownTokens = row.tokenCount || generalFunctions.estimateTokens(row.text);
                const members = windowTokens <= budget ? window : [row];
                budget -= members === window ? windowTokens : ownTokens;

                // The citation id is the best-scoring top chunk inside the window.
                const cited = members
                    .filter((member) => topIds.has(member.chunkId))
                    .sort((a, b) => (scoreOf.get(b.chunkId) || 0) - (scoreOf.get(a.chunkId) || 0))[0] || row;
                for (const member of members) consumed.add(member.chunkId);
                passages.push({
                    chunkId: cited.chunkId,
                    sourceId: row.sourceId,
                    headingPath: cited.headingPath || row.headingPath || [],
                    text: this._stitchChunks(members.map((member) => member.text)),
                    vectorScore: top.vectorScore,
                    textScore: top.textScore,
                    rerankScore: scoreOf.get(cited.chunkId) || top.rerankScore || 0,
                    memberChunkIds: members.map((member) => member.chunkId),
                });
            }
            return passages;
        } catch (error) {
            console.log("AgentFunctions:_expandNeighbors: failed, using reranked chunks as-is");
            console.error(error);
            generalFunctions.captureException(error);
            return topChunks;
        }
    }

    // Two queries: the top chunks themselves (search results do not carry
    // position or documentKey), then every chunk within the radius in the same
    // documents. Split out so tests can stand in for the database.
    async _fetchChunkRows({ orgId, topChunks }) {
        const ids = topChunks.map((chunk) => chunk.chunkId);
        const select = "chunkId sourceId documentKey position text headingPath tokenCount";
        const tops = await Chunk.find({ orgId, chunkId: { $in: ids } }).select(select).lean();
        if (tops.length === 0) return [];
        const conditions = tops.map((row) => ({
            sourceId: row.sourceId,
            documentKey: row.documentKey || null,
            position: { $gte: row.position - config.NEIGHBOR_EXPAND_RADIUS, $lte: row.position + config.NEIGHBOR_EXPAND_RADIUS },
        }));
        return Chunk.find({ orgId, $or: conditions }).select(select).lean();
    }

    // Adjacent chunks overlap by CHUNK_OVERLAP_RATIO. Drop the repeated span
    // where the end of one is the start of the next, so the model does not
    // read the same sentence twice and treat it as emphasis.
    _stitchChunks(texts) {
        let out = "";
        for (const text of texts) {
            const next = String(text || "");
            if (!out) {
                out = next;
                continue;
            }
            const maxOverlap = Math.min(out.length, next.length, Math.floor(config.CHUNK_TARGET_TOKENS * 4 * config.CHUNK_OVERLAP_RATIO) + 64);
            let overlap = 0;
            for (let size = maxOverlap; size >= 20; size--) {
                if (out.endsWith(next.slice(0, size))) {
                    overlap = size;
                    break;
                }
            }
            out = overlap > 0 ? out + next.slice(overlap) : `${out}\n\n${next}`;
        }
        return out;
    }

    _addUsage(trace, model, result) {
        trace.inputTokens += result.inputTokens || 0;
        trace.outputTokens += result.outputTokens || 0;
        trace.costUsd += generalFunctions.estimateCostUsd({
            model,
            inputTokens: result.inputTokens || 0,
            outputTokens: result.outputTokens || 0,
        });
    }

    async _writeTrace(trace) {
        try {
            // Redacted on the way in, not on the way out (§8.1). A trace is kept
            // for months and read by the eval tooling, so PII that reaches this
            // collection is PII we now have to find and purge later. The
            // redactor walks the whole document because the customer's email
            // can be in rawQuery, rewrittenQuery, a retrieved chunk, or a tool
            // call's arguments.
            await TurnTrace.create(redactionFunctions.redactForStorage(trace));
        } catch (error) {
            console.error("AgentFunctions:_writeTrace: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
        }
    }
}

module.exports = new AgentFunctions();
