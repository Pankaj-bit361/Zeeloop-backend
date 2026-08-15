const config = require("../../config/config");
const { ConversationStatus } = require("../../config/enums");
const Conversation = require("../../models/conversation/conversation");
const Message = require("../../models/conversation/message");
const generalFunctions = require("../utilFunctions/generalFunctions");
const llmFunctions = require("../utilFunctions/llmFunctions");
const redactionFunctions = require("../utilFunctions/redactionFunctions");

// §3.4 — post-hoc answer quality, graded by a model on 100% of conversations.
//
// Thumbs feedback arrives on under 5% of conversations and is biased toward the
// extremes: people click a thumb when delighted or furious, which tells you
// nothing about the eighty percent in the middle where the actual quality
// problem lives.
//
// Runs on cron, never in a turn. The score is not used to gate anything — it is
// an observation, and an observation that could block a customer's answer would
// be a liability rather than a metric.

// A fixed reason vocabulary. Free-text reasons cannot be aggregated: with fifty
// conversations you get fifty distinct explanations and no chart. The model must
// choose one of these and may explain in one sentence beside it.
const POSITIVE_REASONS = {
    DIRECT_ANSWER: "Answered directly with the right level of detail",
    WELL_SOURCED: "Grounded in the knowledge base with useful citations",
    GOOD_CLARIFICATION: "Asked the right clarifying question before answering",
    APPROPRIATE_HANDOFF: "Recognised its limits and handed off cleanly",
    HANDLED_TONE: "Handled a difficult customer well",
};

const NEGATIVE_REASONS = {
    DID_NOT_ANSWER: "Did not answer the question that was asked",
    UNGROUNDED: "Stated something the knowledge base does not support",
    TOO_VAGUE: "Answered without enough specifics to be useful",
    OVER_ESCALATED: "Handed off when it could have answered",
    UNDER_ESCALATED: "Kept trying when it should have handed off",
    REPETITIVE: "Repeated itself instead of trying something else",
    WRONG_TONE: "Tone did not match the situation",
    IGNORED_CONTEXT: "Lost track of what the customer had already said",
};

// Grading a conversation that is still moving means grading a fragment. Only
// finished threads are scored.
const MIN_AGE_MS = 60 * 60 * 1000;

class QualityFunctions {
    // ── Public Functions ─────────────────────────────────────────────

    // The cron entry point. Grades a bounded batch per tick so a workspace with
    // a large backlog catches up gradually rather than issuing ten thousand
    // model calls in one minute.
    async gradePending({ orgId, limit }) {
        console.log("QualityFunctions:gradePending: orgId:", orgId || "ALL");
        try {
            const query = {
                "quality.gradedAt": null,
                lastMessageAt: { $lt: new Date(Date.now() - MIN_AGE_MS) },
                turnCount: { $gt: 0 },
            };
            if (orgId) query.orgId = orgId;

            const pending = await Conversation.find(query)
                .sort({ lastMessageAt: 1 })
                .limit(Math.min(200, Number(limit) || config.QUALITY_BATCH_SIZE))
                .lean();

            if (pending.length === 0) return { success: true, graded: 0 };

            let graded = 0;
            for (const conversation of pending) {
                const result = await this._gradeOne({ conversation });
                if (result.success) graded += 1;
            }

            console.log("QualityFunctions:gradePending: graded:", graded);
            return { success: true, graded };
        } catch (error) {
            console.error("QualityFunctions:gradePending: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { success: false, graded: 0 };
        }
    }

    // The aggregate the analytics page renders: average score, and the reason
    // vocabulary counted so the top negative reason is visible at a glance.
    async getQualitySummary({ orgId, days }) {
        console.log("QualityFunctions:getQualitySummary: orgId:", orgId);
        try {
            const since = new Date(Date.now() - (Number(days) || 30) * 86_400_000);
            const rows = await Conversation.aggregate([
                { $match: { orgId, "quality.gradedAt": { $ne: null, $gte: since } } },
                {
                    $group: {
                        _id: "$quality.reasonCategory",
                        count: { $sum: 1 },
                        averageScore: { $avg: "$quality.score" },
                    },
                },
                { $sort: { count: -1 } },
            ]);

            const total = rows.reduce((sum, row) => sum + row.count, 0);
            const weighted = rows.reduce((sum, row) => sum + row.averageScore * row.count, 0);

            const positive = rows
                .filter((row) => POSITIVE_REASONS[row._id])
                .map((row) => ({ category: row._id, label: POSITIVE_REASONS[row._id], count: row.count }));
            const negative = rows
                .filter((row) => NEGATIVE_REASONS[row._id])
                .map((row) => ({ category: row._id, label: NEGATIVE_REASONS[row._id], count: row.count }));

            return {
                status: 200,
                json: {
                    success: true,
                    data: {
                        graded: total,
                        averageScore: total > 0 ? Number((weighted / total).toFixed(3)) : null,
                        positive,
                        negative,
                        // Said out loud so nobody reads a 0.82 from eleven
                        // conversations as a trend.
                        note: total < 20 ? "Fewer than 20 graded conversations — treat this as indicative, not a trend." : null,
                    },
                },
            };
        } catch (error) {
            console.error("QualityFunctions:getQualitySummary: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // ── Private Helper Functions ─────────────────────────────────────

    async _gradeOne({ conversation }) {
        try {
            const messages = await Message.find({
                orgId: conversation.orgId,
                conversationId: conversation.conversationId,
            })
                .sort({ createdAt: 1 })
                .limit(30)
                .lean();

            if (messages.length === 0) {
                // Nothing to grade, but it must be marked or the cron picks it
                // up forever.
                await Conversation.updateOne(
                    { orgId: conversation.orgId, conversationId: conversation.conversationId },
                    { $set: { "quality.gradedAt": new Date(), "quality.score": null, "quality.reasonCategory": null } }
                );
                return { success: true };
            }

            const transcript = messages
                .map((message) => `${message.role}: ${redactionFunctions.redactForModel(message.content || "")}`)
                .join("\n");

            const result = await llmFunctions.completeJson({
                model: config.SMALL_MODEL,
                system: `You grade a completed customer support conversation on how well the AI agent handled it.

Score from 0 to 1. Then choose exactly one reason category.

Positive categories (use when score >= 0.6):
${Object.entries(POSITIVE_REASONS).map(([key, label]) => `- ${key}: ${label}`).join("\n")}

Negative categories (use when score < 0.6):
${Object.entries(NEGATIVE_REASONS).map(([key, label]) => `- ${key}: ${label}`).join("\n")}

Judge the handling, not the outcome. Correctly saying "I don't know" and handing off is good work and should score well; a confident wrong answer should score badly even if the customer seemed satisfied.`,
                schemaHint: `{"score": number, "reasonCategory": string, "reason": string}`,
                messages: [{ role: "user", content: transcript }],
                maxTokens: 256,
            });

            const score = Number(result.json.score);
            const category = result.json.reasonCategory;
            const known = POSITIVE_REASONS[category] || NEGATIVE_REASONS[category];

            await Conversation.updateOne(
                { orgId: conversation.orgId, conversationId: conversation.conversationId },
                {
                    $set: {
                        "quality.score": Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : null,
                        // An unrecognised category is dropped rather than
                        // stored, or the aggregate above fills with one-off
                        // strings and stops being a chart.
                        "quality.reasonCategory": known ? category : null,
                        "quality.reason": String(result.json.reason || "").slice(0, 300),
                        "quality.gradedAt": new Date(),
                    },
                }
            );

            return { success: true };
        } catch (error) {
            console.error("QualityFunctions:_gradeOne: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            // Deliberately NOT marked as graded: a provider blip should leave
            // the conversation to be retried on the next tick, not silently
            // excluded from the metric forever.
            return { success: false };
        }
    }
}

module.exports = new QualityFunctions();
module.exports.POSITIVE_REASONS = POSITIVE_REASONS;
module.exports.NEGATIVE_REASONS = NEGATIVE_REASONS;
module.exports.MIN_AGE_MS = MIN_AGE_MS;
