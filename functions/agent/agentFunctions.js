const config = require("../../config/config");
const {
    TurnOutcome,
    AccessType,
    BlockReason,
    GateIntent,
    GateSentiment,
    ToolCallStatus,
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
const actionFunctions = require("../action/actionFunctions");

class AgentFunctions {
    // The whole pipeline. Six stages, order is the contract. Returns
    // { success, reply, citations, toolCalls, outcome, halted }.
    // The TurnTrace is written on EVERY turn, including blocked and failed ones.
    async runTurn({ org, conversation, endUser, identityVerified, rawMessage, history }) {
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
            model: config.LARGE_MODEL,
            inputTokens: 0,
            outputTokens: 0,
            iterations: 0,
            grounded: null,
            answersQuery: null,
            unsupportedClaims: [],
            outcome: TurnOutcome.ERROR,
            latencyMs: { gate: 0, rewrite: 0, retrieve: 0, rerank: 0, generate: 0, validate: 0 },
            costUsd: 0,
        };

        let result;
        try {
            result = await this._runPipeline({ org, conversation, endUser, identityVerified, rawMessage, history, trace });
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
        return result;
    }

    // Private Helper Functions

    async _runPipeline({ org, conversation, endUser, identityVerified, rawMessage, history, trace }) {
        // Stage 0 — gate (fail open)
        const gateStart = Date.now();
        const gate = await this._runGate({ rawMessage, trace });
        trace.latencyMs.gate = Date.now() - gateStart;
        trace.gateIntent = gate.intent;
        trace.gateLanguage = gate.language;
        trace.gateSentiment = gate.sentiment;
        trace.gateSafe = gate.safe;

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

        // Chitchat skips retrieval entirely
        if (gate.intent === GateIntent.CHITCHAT) {
            const reply = await this._runChitchat({ org, rawMessage, trace });
            trace.outcome = TurnOutcome.ANSWERED;
            return { success: true, reply, citations: [], toolCalls: [], outcome: TurnOutcome.ANSWERED, halted: false };
        }

        // Stage 1 — rewrite (skipped on the first turn; on failure use the raw message)
        const rewriteStart = Date.now();
        const query = await this._runRewrite({ rawMessage, history, turn: trace.turn, trace });
        trace.latencyMs.rewrite = Date.now() - rewriteStart;

        // Stage 2 — retrieval: all four loads in parallel
        const retrieveStart = Date.now();
        const [candidates, tableContext, availableActions, procedure] = await Promise.all([
            this._hybridSearch({ orgId: org.orgId, query }),
            this._loadTables({ orgId: org.orgId, endUser, identityVerified }),
            this._loadActions({ orgId: org.orgId }),
            this._loadProcedures({ orgId: org.orgId, query }),
        ]);
        trace.latencyMs.retrieve = Date.now() - retrieveStart;
        trace.candidateCount = candidates.length;
        trace.procedureId = procedure ? procedure.procedureId : null;

        // Stage 3 — rerank + abstention gate
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

        // Stage 4 — generate (answer, clarifying question, or tool call loop)
        const generateStart = Date.now();
        const generation = await this._runGenerate({
            org,
            conversation,
            endUser,
            identityVerified,
            query,
            rawMessage,
            history,
            topChunks,
            tableContext,
            availableActions,
            procedure,
            trace,
        });
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
        const validateStart = Date.now();
        const verdict = await this._runValidate({ query, reply: generation.reply, topChunks, tableContext, trace });
        trace.latencyMs.validate = Date.now() - validateStart;
        trace.grounded = verdict.grounded;
        trace.answersQuery = verdict.answersQuery;
        trace.unsupportedClaims = verdict.unsupportedClaims;

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
                system: "Rewrite the user's latest message as a standalone search query, resolving pronouns and references from the conversation. Keep it short.",
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

    // Hybrid retrieval: Atlas $vectorSearch + $search merged with reciprocal
    // rank fusion (1 / (60 + rank)). Graceful empty result if indexes are missing.
    async _hybridSearch({ orgId, query }) {
        let queryEmbedding = null;
        try {
            const embeddings = await llmFunctions.embed({ texts: [query] });
            queryEmbedding = embeddings[0];
        } catch (error) {
            console.log("AgentFunctions:_hybridSearch: embed failed, text-only search");
            console.error(error);
            generalFunctions.captureException(error);
        }

        const [vectorHits, textHits] = await Promise.all([
            queryEmbedding ? this._vectorSearch({ orgId, queryEmbedding }) : Promise.resolve([]),
            this._textSearch({ orgId, query }),
        ]);

        // Reciprocal rank fusion
        const fused = new Map();
        vectorHits.forEach((hit, rank) => {
            const entry = fused.get(hit.chunkId) || { ...hit, fusionScore: 0 };
            entry.fusionScore += 1 / (config.FUSION_K + rank + 1);
            entry.vectorScore = hit.vectorScore;
            fused.set(hit.chunkId, entry);
        });
        textHits.forEach((hit, rank) => {
            const entry = fused.get(hit.chunkId) || { ...hit, fusionScore: 0 };
            entry.fusionScore += 1 / (config.FUSION_K + rank + 1);
            entry.textScore = hit.textScore;
            fused.set(hit.chunkId, entry);
        });

        return [...fused.values()]
            .sort((a, b) => b.fusionScore - a.fusionScore)
            .slice(0, config.RETRIEVAL_CANDIDATES);
    }

    async _vectorSearch({ orgId, queryEmbedding }) {
        try {
            const results = await Chunk.aggregate([
                {
                    $vectorSearch: {
                        index: config.VECTOR_INDEX_NAME,
                        path: "embedding",
                        queryVector: queryEmbedding,
                        numCandidates: config.RETRIEVAL_CANDIDATES * 4,
                        limit: config.RETRIEVAL_CANDIDATES,
                        filter: { orgId },
                    },
                },
                {
                    $project: {
                        _id: 0,
                        chunkId: 1,
                        sourceId: 1,
                        text: 1,
                        headingPath: 1,
                        vectorScore: { $meta: "vectorSearchScore" },
                    },
                },
            ]);
            return results;
        } catch (error) {
            // Index missing (local Mongo, fresh Atlas cluster) → empty, not a crash
            console.log("AgentFunctions:_vectorSearch: index unavailable, returning empty");
            console.error(error.message);
            return [];
        }
    }

    async _textSearch({ orgId, query }) {
        try {
            const results = await Chunk.aggregate([
                {
                    $search: {
                        index: config.TEXT_INDEX_NAME,
                        compound: {
                            must: [{ text: { query, path: "text" } }],
                            filter: [{ text: { query: orgId, path: "orgId" } }],
                        },
                    },
                },
                { $limit: config.RETRIEVAL_CANDIDATES },
                {
                    $project: {
                        _id: 0,
                        chunkId: 1,
                        sourceId: 1,
                        text: 1,
                        headingPath: 1,
                        textScore: { $meta: "searchScore" },
                    },
                },
            ]);
            return results;
        } catch (error) {
            console.log("AgentFunctions:_textSearch: index unavailable, using keyword fallback");
            console.error(error.message);
            return this._keywordSearch({ orgId, query });
        }
    }

    // Keyword fallback when the Atlas $search index is missing (local Mongo,
    // fresh cluster). Scores chunks by distinct query-term hits, headings
    // weighted double. Same result shape as _textSearch so fusion is unchanged.
    async _keywordSearch({ orgId, query }) {
        try {
            const stopwords = new Set([
                "the", "and", "for", "are", "but", "not", "you", "your", "with", "can", "how",
                "what", "when", "where", "why", "who", "does", "did", "will", "would", "could",
                "should", "have", "has", "had", "was", "were", "been", "being", "them", "they",
                "this", "that", "there", "their", "from", "about", "into", "than", "then", "get",
                "much", "many", "any", "all", "long", "take", "make", "need", "want", "please",
            ]);
            // Light stemming so "refunds"/"refunded" match "refund".
            const stem = (term) => {
                if (term.length > 5 && term.endsWith("ing")) return term.slice(0, -3);
                if (term.length > 4 && (term.endsWith("ed") || term.endsWith("es"))) return term.slice(0, -2);
                if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
                return term;
            };
            const terms = [...new Set(
                String(query).toLowerCase().split(/[^a-z0-9]+/)
                    .filter((term) => term.length >= 3 && !stopwords.has(term))
                    .map(stem)
            )].slice(0, 8);
            if (terms.length === 0) return [];

            const regexes = terms.map((term) => new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
            const candidates = await Chunk.find({ orgId, $or: regexes.map((regex) => ({ text: regex })) })
                .select("chunkId sourceId text headingPath")
                .limit(200)
                .lean();

            return candidates
                .map((chunk) => {
                    const heading = (chunk.headingPath || []).join(" ");
                    let hits = 0;
                    for (const regex of regexes) {
                        if (regex.test(chunk.text)) hits += 1;
                        if (regex.test(heading)) hits += 2;
                    }
                    return { ...chunk, textScore: hits / (terms.length * 3) };
                })
                .filter((chunk) => chunk.textScore > 0)
                .sort((a, b) => b.textScore - a.textScore)
                .slice(0, config.RETRIEVAL_CANDIDATES);
        } catch (error) {
            console.error("AgentFunctions:_keywordSearch: Catch block");
            console.error(error.message);
            return [];
        }
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

    async _loadProcedures({ orgId, query }) {
        const procedures = await Procedure.find({ orgId, enabled: true }).lean();
        const queryLower = query.toLowerCase();
        return (
            procedures.find((procedure) =>
                (procedure.keywords || []).some((keyword) => queryLower.includes(keyword.toLowerCase()))
            ) || null
        );
    }

    async _runRerank({ query, candidates, trace }) {
        if (candidates.length === 0) {
            return { topChunks: [], belowThreshold: true };
        }
        try {
            const ranked = await llmFunctions.rerank({
                query,
                documents: candidates.map((candidate) => candidate.text),
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

    async _runGenerate({ org, conversation, endUser, identityVerified, query, rawMessage, history, topChunks, tableContext, availableActions, procedure, trace }) {
        const system = this._buildSystemPrompt({ org, topChunks, tableContext, availableActions, procedure, identityVerified });
        const messages = [
            ...(history || []).slice(-10).map((message) => ({
                role: message.role === "USER" ? "user" : "assistant",
                content: message.content,
            })),
            { role: "user", content: rawMessage },
        ];

        const toolCalls = [];
        for (let iteration = 0; iteration < config.MAX_TOOL_ITERATIONS; iteration++) {
            trace.iterations = iteration + 1;
            const result = await llmFunctions.completeJson({
                model: config.LARGE_MODEL,
                system,
                schemaHint: `{"type": "answer", "text": string, "citationChunkIds": string[]} OR {"type": "clarify", "text": string} OR {"type": "tool_call", "actionId": string, "args": object}`,
                messages,
                maxTokens: config.MAX_OUTPUT_TOKENS,
            });
            this._addUsage(trace, config.LARGE_MODEL, result);
            const output = result.json;

            if (output.type === "clarify") {
                return { reply: output.text, citations: [], toolCalls, outcome: TurnOutcome.CLARIFIED, halted: false };
            }

            if (output.type === "tool_call") {
                const action = availableActions.find((candidate) => candidate.actionId === output.actionId) || null;
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
                        pendingAction: { actionId: action.actionId, args: output.args },
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
            return { reply: output.text, citations, toolCalls, outcome: TurnOutcome.ANSWERED, halted: false };
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
        if (action.accessType === AccessType.WRITE && action.requiresConfirmation && !confirmed) {
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

    _buildSystemPrompt({ org, topChunks, tableContext, availableActions, procedure, identityVerified }) {
        const parts = [];
        parts.push(
            `You are ${org.agent.name}, the customer support agent for ${org.name}. Answer ONLY from the context below. If the context does not contain the answer, say so plainly. Never invent facts, prices, or policies.`
        );

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
            parts.push(
                `PROCEDURE — you MUST follow these steps in order for this request:\n${procedure.steps
                    .map((step, index) => `${index + 1}. ${step}`)
                    .join("\n")}`
            );
        }

        parts.push(
            `Identity verified: ${identityVerified ? "yes" : "no"}. Cite knowledge chunk ids you used in citationChunkIds. If you need information only the user can provide, respond with {"type":"clarify",...}.`
        );
        return parts.join("\n\n");
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
