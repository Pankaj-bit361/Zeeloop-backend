const config = require("../../config/config");
const { EvalRating, RunStatus, ConfigTarget, IdPrefix, TurnOutcome } = require("../../config/enums");
const BatchTest = require("../../models/eval/batchTest");
const TurnTrace = require("../../models/trace/turnTrace");
const generalFunctions = require("../utilFunctions/generalFunctions");
const llmFunctions = require("../utilFunctions/llmFunctions");
const evalRunner = require("./evalRunner");

// §3.1 — batch tests. A saved list of questions, run on demand, with the
// previous answer kept so "what changed" is a comparison rather than a memory.
//
// Three ways to add questions, and the first one is the only one that matters:
// generating them from past conversations solves the cold start. Nobody sits
// down and writes forty representative support questions from scratch; everybody
// has forty in their inbox already.

const MAX_QUESTIONS = 200;
const MAX_RUNS_KEPT = 20;
const GENERATE_SAMPLE_SIZE = 60;

class BatchTestFunctions {
    // ── Public Functions ─────────────────────────────────────────────

    async list({ orgId }) {
        console.log("BatchTestFunctions:list: orgId:", orgId);
        try {
            const tests = await BatchTest.find({ orgId }).sort({ createdAt: -1 }).lean();
            return {
                status: 200,
                json: {
                    success: true,
                    data: tests.map((test) => ({
                        batchTestId: test.batchTestId,
                        name: test.name,
                        description: test.description,
                        questionCount: (test.questions || []).length,
                        lastRun: (test.runs || [])[0] || null,
                        createdAt: test.createdAt,
                    })),
                },
            };
        } catch (error) {
            console.error("BatchTestFunctions:list: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async get({ orgId, batchTestId }) {
        console.log("BatchTestFunctions:get: batchTestId:", batchTestId);
        try {
            const test = await BatchTest.findOne({ orgId, batchTestId }).lean();
            if (!test) return { status: 404, json: { success: false, error: "Batch test not found" } };

            const questions = (test.questions || []).map((question) => ({
                ...question,
                // Computed rather than stored: a stored flag would go stale the
                // moment someone edits the question text.
                changed: !!(question.previousAnswer && question.lastAnswer && question.previousAnswer !== question.lastAnswer),
            }));

            return { status: 200, json: { success: true, data: { ...test, questions, _id: undefined } } };
        } catch (error) {
            console.error("BatchTestFunctions:get: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async create({ orgId, name, description, questions }) {
        console.log("BatchTestFunctions:create: orgId:", orgId);
        try {
            if (!name || !String(name).trim()) {
                return { status: 400, json: { success: false, error: "name is required" } };
            }

            const test = await BatchTest.create({
                orgId,
                batchTestId: generalFunctions.generateId(IdPrefix.BATCH_TEST),
                name: String(name).trim(),
                description: description || "",
                questions: this._normaliseQuestions(questions),
            });

            return { status: 201, json: { success: true, data: test.toJSON() } };
        } catch (error) {
            console.error("BatchTestFunctions:create: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // Paste, CSV, or generated — all three land here. CSV is parsed by the
    // caller into the same shape, because a second parser is a second set of
    // quoting bugs.
    async addQuestions({ orgId, batchTestId, questions }) {
        console.log("BatchTestFunctions:addQuestions: batchTestId:", batchTestId);
        try {
            const test = await BatchTest.findOne({ orgId, batchTestId });
            if (!test) return { status: 404, json: { success: false, error: "Batch test not found" } };

            const incoming = this._normaliseQuestions(questions);
            if (incoming.length === 0) {
                return { status: 400, json: { success: false, error: "No valid questions supplied" } };
            }

            // De-duplicated on text. A suite that accumulates the same question
            // four times reports a change four times and wastes four turns.
            const seen = new Set(test.questions.map((question) => question.text.trim().toLowerCase()));
            const fresh = incoming.filter((question) => !seen.has(question.text.trim().toLowerCase()));

            if (test.questions.length + fresh.length > MAX_QUESTIONS) {
                return {
                    status: 400,
                    json: { success: false, error: `A batch test holds at most ${MAX_QUESTIONS} questions` },
                };
            }

            test.questions.push(...fresh);
            await test.save();

            return {
                status: 200,
                json: { success: true, data: { added: fresh.length, skipped: incoming.length - fresh.length } },
            };
        } catch (error) {
            console.error("BatchTestFunctions:addQuestions: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // §3.1 — generate questions from past conversations. The cold-start answer.
    //
    // Drawn from real first-turn queries, then de-duplicated by a model into
    // distinct questions: an inbox with sixty "where is my order" variants
    // should contribute one test question, not sixty.
    async generateQuestions({ orgId, batchTestId, limit }) {
        console.log("BatchTestFunctions:generateQuestions: orgId:", orgId);
        try {
            const test = await BatchTest.findOne({ orgId, batchTestId });
            if (!test) return { status: 404, json: { success: false, error: "Batch test not found" } };

            const traces = await TurnTrace.find({ orgId, turn: 1 })
                .sort({ createdAt: -1 })
                .limit(GENERATE_SAMPLE_SIZE)
                .select("rawQuery outcome")
                .lean();

            if (traces.length === 0) {
                return {
                    status: 400,
                    json: {
                        success: false,
                        error: "No past conversations to generate from yet. Add questions manually or upload a CSV.",
                    },
                };
            }

            const wanted = Math.min(Number(limit) || 20, 50);
            const result = await llmFunctions.completeJson({
                // The large model on purpose. This runs once per suite and the
                // quality of the question set determines the quality of every
                // future regression check — a bad set is worse than none,
                // because it produces confident green ticks.
                model: config.LARGE_MODEL,
                system:
                    "You turn real customer support questions into a regression test set. Merge near-duplicates into one representative question. Keep the customer's own phrasing rather than tidying it into formal English — the agent has to handle what people actually type. Drop anything that is not a question.",
                schemaHint: `{"questions": [{"text": string, "expectedBehaviour": string}]}`,
                messages: [
                    {
                        role: "user",
                        content: `Produce at most ${wanted} distinct test questions from these real queries:\n${traces
                            .map((trace) => `- ${trace.rawQuery}`)
                            .join("\n")}`,
                    },
                ],
                maxTokens: 2048,
            });

            const generated = this._normaliseQuestions(result.json.questions);
            const seen = new Set(test.questions.map((question) => question.text.trim().toLowerCase()));
            const fresh = generated
                .filter((question) => !seen.has(question.text.trim().toLowerCase()))
                .slice(0, MAX_QUESTIONS - test.questions.length);

            test.questions.push(...fresh);
            await test.save();

            return {
                status: 200,
                json: { success: true, data: { added: fresh.length, sampledFrom: traces.length } },
            };
        } catch (error) {
            console.error("BatchTestFunctions:generateQuestions: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async rateQuestion({ orgId, batchTestId, questionId, rating }) {
        console.log("BatchTestFunctions:rateQuestion: questionId:", questionId);
        try {
            if (!Object.values(EvalRating).includes(rating)) {
                return { status: 400, json: { success: false, error: `rating must be one of: ${Object.values(EvalRating).join(", ")}` } };
            }

            const test = await BatchTest.findOne({ orgId, batchTestId });
            if (!test) return { status: 404, json: { success: false, error: "Batch test not found" } };

            const question = test.questions.find((entry) => entry.questionId === questionId);
            if (!question) return { status: 404, json: { success: false, error: "Question not found" } };

            question.lastRating = rating;
            await test.save();

            return { status: 200, json: { success: true, data: { questionId, rating } } };
        } catch (error) {
            console.error("BatchTestFunctions:rateQuestion: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async deleteQuestion({ orgId, batchTestId, questionId }) {
        console.log("BatchTestFunctions:deleteQuestion: questionId:", questionId);
        try {
            const test = await BatchTest.findOne({ orgId, batchTestId });
            if (!test) return { status: 404, json: { success: false, error: "Batch test not found" } };

            const before = test.questions.length;
            test.questions = test.questions.filter((entry) => entry.questionId !== questionId);
            if (test.questions.length === before) {
                return { status: 404, json: { success: false, error: "Question not found" } };
            }
            await test.save();

            return { status: 200, json: { success: true, data: { deleted: questionId } } };
        } catch (error) {
            console.error("BatchTestFunctions:deleteQuestion: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async remove({ orgId, batchTestId }) {
        console.log("BatchTestFunctions:remove: batchTestId:", batchTestId);
        try {
            const result = await BatchTest.deleteOne({ orgId, batchTestId });
            if (result.deletedCount === 0) {
                return { status: 404, json: { success: false, error: "Batch test not found" } };
            }
            return { status: 200, json: { success: true, data: { deleted: batchTestId } } };
        } catch (error) {
            console.error("BatchTestFunctions:remove: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // Runs every question through the real pipeline. Synchronous from the
    // caller's point of view — a forty-question suite takes a couple of minutes,
    // which is short enough to wait for and long enough that the response
    // reports how long it took.
    async run({ orgId, batchTestId, target }) {
        console.log("BatchTestFunctions:run: batchTestId:", batchTestId, "target:", target);
        try {
            const test = await BatchTest.findOne({ orgId, batchTestId });
            if (!test) return { status: 404, json: { success: false, error: "Batch test not found" } };
            if (test.questions.length === 0) {
                return { status: 400, json: { success: false, error: "Add some questions first" } };
            }

            const org = await evalRunner.loadOrg({ orgId });
            if (!org) return { status: 404, json: { success: false, error: "Org not found" } };

            const runTarget = target === ConfigTarget.DRAFT ? ConfigTarget.DRAFT : ConfigTarget.LIVE;
            const runId = generalFunctions.generateId(IdPrefix.BATCH_RUN);
            const startedAt = new Date();

            const answers = await evalRunner.withTarget({
                orgId,
                target: runTarget,
                run: async () =>
                    evalRunner.mapLimited({
                        items: test.questions.map((question) => ({ ...question.toObject() })),
                        limit: config.EVAL_CONCURRENCY,
                        handler: async (question) => {
                            let ephemeral = null;
                            try {
                                const { turn, conversation } = await evalRunner.runSingleTurn({
                                    org,
                                    question: question.text,
                                    history: [],
                                });
                                ephemeral = conversation;
                                return {
                                    questionId: question.questionId,
                                    answer: turn.reply,
                                    outcome: turn.outcome,
                                    citations: (turn.citations || []).length,
                                };
                            } finally {
                                if (ephemeral) {
                                    await evalRunner.discardEphemeral({
                                        orgId,
                                        conversationId: ephemeral.conversationId,
                                    });
                                }
                            }
                        },
                    }),
            });

            let changed = 0;
            const byId = new Map(answers.filter((answer) => answer && answer.questionId).map((answer) => [answer.questionId, answer]));
            for (const question of test.questions) {
                const answer = byId.get(question.questionId);
                if (!answer) continue;
                if (question.lastAnswer && question.lastAnswer !== answer.answer) changed += 1;
                question.previousAnswer = question.lastAnswer;
                question.lastAnswer = answer.answer;
                question.lastOutcome = answer.outcome;
                question.lastCitations = answer.citations;
                question.lastRunAt = new Date();
                // A changed answer invalidates the old rating. Keeping it would
                // report a suite as passing based on a judgement of text that is
                // no longer what the agent says.
                if (question.previousAnswer && question.previousAnswer !== answer.answer) {
                    question.lastRating = EvalRating.UNRATED;
                }
            }

            const summary = {
                runId,
                target: runTarget,
                status: RunStatus.COMPLETED,
                startedAt,
                finishedAt: new Date(),
                passed: test.questions.filter((question) => question.lastRating === EvalRating.GOOD).length,
                failed: test.questions.filter((question) => question.lastRating === EvalRating.POOR).length,
                unrated: test.questions.filter((question) => question.lastRating === EvalRating.UNRATED).length,
                changed,
            };

            test.runs.unshift(summary);
            test.runs = test.runs.slice(0, MAX_RUNS_KEPT);
            await test.save();

            return {
                status: 200,
                json: {
                    success: true,
                    data: {
                        run: summary,
                        // Said explicitly, because a draft run briefly promotes
                        // this workspace's draft config — see evalRunner.
                        note:
                            runTarget === ConfigTarget.DRAFT
                                ? "Draft config was applied for the duration of this run and reverted afterwards."
                                : null,
                    },
                },
            };
        } catch (error) {
            console.error("BatchTestFunctions:run: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // ── Private Helper Functions ─────────────────────────────────────

    _normaliseQuestions(questions) {
        if (!Array.isArray(questions)) return [];
        return questions
            .map((question) => {
                const text = typeof question === "string" ? question : question && question.text;
                if (!text || !String(text).trim()) return null;
                return {
                    questionId: generalFunctions.generateId("q"),
                    text: String(text).trim(),
                    expectedBehaviour: (question && question.expectedBehaviour) || "",
                    lastRating: EvalRating.UNRATED,
                };
            })
            .filter(Boolean)
            .slice(0, MAX_QUESTIONS);
    }
}

module.exports = new BatchTestFunctions();
module.exports.MAX_QUESTIONS = MAX_QUESTIONS;
module.exports.MAX_RUNS_KEPT = MAX_RUNS_KEPT;
