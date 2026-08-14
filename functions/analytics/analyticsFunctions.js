const Conversation = require("../../models/conversation/conversation");
const TurnTrace = require("../../models/trace/turnTrace");
const Message = require("../../models/conversation/message");
const config = require("../../config/config");
const { ConversationStatus, MessageRole, TurnOutcome, FeedbackRating } = require("../../config/enums");
const generalFunctions = require("../utilFunctions/generalFunctions");

class AnalyticsFunctions {
    // GET /api/analytics/:orgId/overview
    async getOverview({ orgId, days }) {
        console.log("AnalyticsFunctions:getOverview: orgId:", orgId);
        try {
            if (!orgId) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId" } };
            }
            // `|| 7` would treat days=0 as "not provided" (0 is falsy) instead of clamping it to 1.
            const parsedDays = parseInt(days, 10);
            const windowDays = Math.min(Math.max(Number.isNaN(parsedDays) ? 7 : parsedDays, 1), 90);
            const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

            const seriesSince = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
            const [conversationAgg, outcomeAgg, groundedAgg, dailyAgg, tokenAgg] = await Promise.all([
                Conversation.aggregate([
                    { $match: { orgId, createdAt: { $gte: since } } },
                    {
                        $group: {
                            _id: null,
                            total: { $sum: 1 },
                            resolved: { $sum: { $cond: ["$isResolved", 1, 0] } },
                            escalated: { $sum: { $cond: [{ $eq: ["$status", ConversationStatus.ESCALATED] }, 1, 0] } },
                            totalCostUsd: { $sum: "$totalCostUsd" },
                        },
                    },
                ]),
                TurnTrace.aggregate([
                    { $match: { orgId, createdAt: { $gte: since } } },
                    { $group: { _id: "$outcome", count: { $sum: 1 } } },
                ]),
                TurnTrace.aggregate([
                    { $match: { orgId, createdAt: { $gte: since } } },
                    {
                        $group: {
                            _id: null,
                            total: { $sum: { $cond: [{ $ne: ["$grounded", null] }, 1, 0] } },
                            grounded: { $sum: { $cond: ["$grounded", 1, 0] } },
                            inputTokens: { $sum: "$inputTokens" },
                            outputTokens: { $sum: "$outputTokens" },
                        },
                    },
                ]),
                // Daily autonomous-resolution series for the overview chart
                Conversation.aggregate([
                    { $match: { orgId, createdAt: { $gte: seriesSince } } },
                    {
                        $group: {
                            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
                            total: { $sum: 1 },
                            resolved: { $sum: { $cond: ["$isResolved", 1, 0] } },
                        },
                    },
                    { $sort: { _id: 1 } },
                ]),
                // Daily token split across the requested window, for billing
                TurnTrace.aggregate([
                    { $match: { orgId, createdAt: { $gte: since } } },
                    {
                        $group: {
                            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
                            inputTokens: { $sum: "$inputTokens" },
                            outputTokens: { $sum: "$outputTokens" },
                            costUsd: { $sum: "$costUsd" },
                        },
                    },
                    { $sort: { _id: 1 } },
                ]),
            ]);

            const conversationStats = conversationAgg[0] || { total: 0, resolved: 0, escalated: 0, totalCostUsd: 0 };
            const outcomes = {};
            for (const outcome of Object.values(TurnOutcome)) {
                outcomes[outcome] = 0;
            }
            for (const row of outcomeAgg) {
                outcomes[row._id] = row.count;
            }
            const groundedStats = groundedAgg[0] || { total: 0, grounded: 0, inputTokens: 0, outputTokens: 0 };

            return {
                status: 200,
                json: {
                    success: true,
                    data: {
                        windowDays,
                        conversations: conversationStats.total,
                        autonomousResolutionRate:
                            conversationStats.total > 0 ? conversationStats.resolved / conversationStats.total : 0,
                        escalations: conversationStats.escalated,
                        groundednessPassRate: groundedStats.total > 0 ? groundedStats.grounded / groundedStats.total : null,
                        costPerResolution:
                            conversationStats.resolved > 0 ? conversationStats.totalCostUsd / conversationStats.resolved : null,
                        totalCostUsd: conversationStats.totalCostUsd,
                        inputTokens: groundedStats.inputTokens || 0,
                        outputTokens: groundedStats.outputTokens || 0,
                        outcomes,
                        dailyResolution: dailyAgg.map((day) => ({
                            date: day._id,
                            total: day.total,
                            rate: day.total > 0 ? day.resolved / day.total : 0,
                        })),
                        dailyTokens: this._fillDays({ rows: tokenAgg, days: windowDays }),
                    },
                },
            };
        } catch (error) {
            console.error("AnalyticsFunctions:getOverview: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // GET /api/analytics/:orgId/content-gaps — belowThreshold traces grouped by query.
    async getContentGaps({ orgId, days }) {
        console.log("AnalyticsFunctions:getContentGaps: orgId:", orgId);
        try {
            if (!orgId) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId" } };
            }
            const parsedDays = parseInt(days, 10);
            const windowDays = Math.min(Math.max(Number.isNaN(parsedDays) ? 30 : parsedDays, 1), 90);
            const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

            const gaps = await TurnTrace.aggregate([
                { $match: { orgId, belowThreshold: true, createdAt: { $gte: since } } },
                {
                    $group: {
                        _id: { $toLower: { $ifNull: ["$rewrittenQuery", "$rawQuery"] } },
                        occurrences: { $sum: 1 },
                        lastSeen: { $max: "$createdAt" },
                        bestScore: { $max: { $ifNull: [{ $max: "$topChunks.rerankScore" }, 0] } },
                    },
                },
                { $sort: { occurrences: -1, lastSeen: -1 } },
                { $limit: 100 },
                {
                    $project: {
                        _id: 0,
                        query: "$_id",
                        occurrences: 1,
                        lastSeen: 1,
                        bestScore: 1,
                    },
                },
            ]);

            return { status: 200, json: { success: true, data: gaps, windowDays } };
        } catch (error) {
            console.error("AnalyticsFunctions:getContentGaps: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // A day with no traffic must render as a zero bar, not vanish from the axis —
    // otherwise a quiet week silently compresses the chart's time scale.
    _fillDays({ rows, days }) {
        const byDate = new Map(rows.map((row) => [row._id, row]));
        const series = [];
        for (let offset = days - 1; offset >= 0; offset -= 1) {
            const date = new Date(Date.now() - offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
            const row = byDate.get(date);
            series.push({
                date,
                inputTokens: row?.inputTokens || 0,
                outputTokens: row?.outputTokens || 0,
                costUsd: row?.costUsd || 0,
            });
        }
        return series;
    }

    // Cron. Autonomous resolution (§11): ended without escalation, no human
    // reply, no return within 24h, no thumbs down. Never computed at write time.
    async computeResolutions() {
        console.log("AnalyticsFunctions:computeResolutions: run");
        try {
            const cutoff = new Date(Date.now() - config.RESOLUTION_WINDOW_HOURS * 60 * 60 * 1000);

            const candidates = await Conversation.find({
                isResolved: false,
                status: { $ne: ConversationStatus.ESCALATED },
                hasHumanReply: false,
                feedback: { $ne: FeedbackRating.DOWN },
                lastMessageAt: { $lte: cutoff, $ne: null },
                turnCount: { $gt: 0 },
            }).limit(500);

            let resolvedCount = 0;
            for (const conversation of candidates) {
                // "no return within 24h": no user message since lastMessageAt
                const laterUserMessage = await Message.findOne({
                    orgId: conversation.orgId,
                    conversationId: conversation.conversationId,
                    role: MessageRole.USER,
                    createdAt: { $gt: conversation.lastMessageAt },
                });
                if (laterUserMessage) continue;

                conversation.isResolved = true;
                conversation.status = ConversationStatus.RESOLVED;
                conversation.endedAt = conversation.endedAt || conversation.lastMessageAt;
                await conversation.save();
                resolvedCount += 1;
            }

            console.log("AnalyticsFunctions:computeResolutions: resolved:", resolvedCount);
            return { success: true, resolvedCount };
        } catch (error) {
            console.error("AnalyticsFunctions:computeResolutions: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { success: false };
        }
    }
}

module.exports = new AnalyticsFunctions();
