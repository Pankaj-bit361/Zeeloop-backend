const {
    MonitorTrigger,
    ReviewStatus,
    IdPrefix,
    TurnOutcome,
    GateSentiment,
    ConversationStatus,
} = require("../../config/enums");
const { Monitor, ConversationReview } = require("../../models/eval/monitor");
const Conversation = require("../../models/conversation/conversation");
const Message = require("../../models/conversation/message");
const TurnTrace = require("../../models/trace/turnTrace");
const Simulation = require("../../models/eval/simulation");
const generalFunctions = require("../utilFunctions/generalFunctions");

// §3.6 — production monitors, a review queue, and scorecards.
//
// Monitors run over recent conversations and flag the ones a human should look
// at. Deliberately a sweep rather than a hook on the turn path: a monitor
// evaluated inline would add work to every turn to catch the one in fifty that
// matters, and "conversations that escalated" is not knowable until the
// conversation is over.
//
// The unique index on (org, conversation, monitor) is what makes re-running the
// sweep safe. Without it every tick re-enqueues the same conversations and the
// queue is unusable by the end of the first day.

const SWEEP_WINDOW_HOURS = 48;
const MAX_FLAGGED_PER_SWEEP = 100;

class MonitorFunctions {
    // ── Public Functions ─────────────────────────────────────────────

    async listMonitors({ orgId }) {
        console.log("MonitorFunctions:listMonitors: orgId:", orgId);
        try {
            const monitors = await Monitor.find({ orgId }).sort({ createdAt: 1 }).lean();
            return {
                status: 200,
                json: {
                    success: true,
                    data: monitors.map((monitor) => {
                        const copy = { ...monitor };
                        delete copy._id;
                        delete copy.__v;
                        return copy;
                    }),
                    triggers: Object.values(MonitorTrigger),
                },
            };
        } catch (error) {
            console.error("MonitorFunctions:listMonitors: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async createMonitor({ orgId, name, trigger, keywords, samplePercent, scoreBelow, scorecard, assignTo }) {
        console.log("MonitorFunctions:createMonitor: orgId:", orgId);
        try {
            if (!name || !String(name).trim()) {
                return { status: 400, json: { success: false, error: "name is required" } };
            }
            if (!Object.values(MonitorTrigger).includes(trigger)) {
                return { status: 400, json: { success: false, error: `trigger must be one of: ${Object.values(MonitorTrigger).join(", ")}` } };
            }
            if (trigger === MonitorTrigger.KEYWORD_MATCH && (!Array.isArray(keywords) || keywords.length === 0)) {
                return { status: 400, json: { success: false, error: "A keyword monitor needs at least one keyword" } };
            }
            if (trigger === MonitorTrigger.RANDOM_SAMPLE) {
                const percent = Number(samplePercent);
                if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
                    return { status: 400, json: { success: false, error: "samplePercent must be between 0 and 100" } };
                }
            }

            const monitor = await Monitor.create({
                orgId,
                monitorId: generalFunctions.generateId(IdPrefix.MONITOR),
                name: String(name).trim(),
                trigger,
                keywords: keywords || [],
                samplePercent: Number(samplePercent) || 5,
                scoreBelow: Number(scoreBelow) || 0.6,
                scorecard: scorecard || [],
                assignTo: assignTo || null,
            });

            return { status: 201, json: { success: true, data: monitor.toJSON() } };
        } catch (error) {
            console.error("MonitorFunctions:createMonitor: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async deleteMonitor({ orgId, monitorId }) {
        console.log("MonitorFunctions:deleteMonitor: monitorId:", monitorId);
        try {
            const result = await Monitor.deleteOne({ orgId, monitorId });
            if (result.deletedCount === 0) {
                return { status: 404, json: { success: false, error: "Monitor not found" } };
            }
            // The queue items stay. A review someone has already written notes
            // on is theirs, not the monitor's.
            return { status: 200, json: { success: true, data: { deleted: monitorId } } };
        } catch (error) {
            console.error("MonitorFunctions:deleteMonitor: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async runSweep({ orgId }) {
        console.log("MonitorFunctions:runSweep: orgId:", orgId);
        try {
            const monitors = await Monitor.find({ orgId, enabled: true }).lean();
            if (monitors.length === 0) return { status: 200, json: { success: true, data: { flagged: 0 } } };

            const since = new Date(Date.now() - SWEEP_WINDOW_HOURS * 3600_000);
            const conversations = await Conversation.find({ orgId, lastMessageAt: { $gte: since } })
                .sort({ lastMessageAt: -1 })
                .limit(500)
                .lean();

            let flagged = 0;
            for (const monitor of monitors) {
                const matches = await this._matchConversations({ orgId, monitor, conversations });
                for (const match of matches.slice(0, MAX_FLAGGED_PER_SWEEP)) {
                    const created = await this._enqueue({ orgId, monitor, match });
                    if (created) flagged += 1;
                }
                await Monitor.updateOne(
                    { orgId, monitorId: monitor.monitorId },
                    { $set: { lastRunAt: new Date() }, $inc: { flaggedCount: matches.length } }
                );
            }

            return { status: 200, json: { success: true, data: { flagged, monitors: monitors.length } } };
        } catch (error) {
            console.error("MonitorFunctions:runSweep: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async listQueue({ orgId, status, assignedTo, page, limit }) {
        console.log("MonitorFunctions:listQueue: orgId:", orgId);
        try {
            const pageNumber = Math.max(1, Number(page) || 1);
            const pageSize = Math.min(100, Math.max(1, Number(limit) || 25));

            const query = { orgId };
            if (status && Object.values(ReviewStatus).includes(status)) query.status = status;
            if (assignedTo) query.assignedTo = assignedTo;

            const [reviews, total] = await Promise.all([
                ConversationReview.find(query)
                    .sort({ createdAt: -1 })
                    .skip((pageNumber - 1) * pageSize)
                    .limit(pageSize)
                    .lean(),
                ConversationReview.countDocuments(query),
            ]);

            return {
                status: 200,
                json: {
                    success: true,
                    data: reviews.map((review) => {
                        const copy = { ...review };
                        delete copy._id;
                        delete copy.__v;
                        return copy;
                    }),
                    pagination: { page: pageNumber, limit: pageSize, total },
                },
            };
        } catch (error) {
            console.error("MonitorFunctions:listQueue: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async submitReview({ orgId, reviewId, scores, note, status, reviewerEmail }) {
        console.log("MonitorFunctions:submitReview: reviewId:", reviewId);
        try {
            const review = await ConversationReview.findOne({ orgId, reviewId });
            if (!review) return { status: 404, json: { success: false, error: "Review not found" } };

            const nextStatus = status && Object.values(ReviewStatus).includes(status) ? status : ReviewStatus.REVIEWED;
            review.scores = Array.isArray(scores) ? scores : review.scores;
            review.reviewerNote = note !== undefined ? note : review.reviewerNote;
            review.status = nextStatus;
            review.reviewedBy = reviewerEmail || null;
            review.reviewedAt = new Date();
            await review.save();

            return { status: 200, json: { success: true, data: review.toJSON() } };
        } catch (error) {
            console.error("MonitorFunctions:submitReview: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // §3.6 — a reviewed conversation becomes a simulation in one click. The
    // persona is written from the real transcript, so the simulation reproduces
    // a failure that actually happened rather than one somebody imagined.
    async promoteToSimulation({ orgId, reviewId }) {
        console.log("MonitorFunctions:promoteToSimulation: reviewId:", reviewId);
        try {
            const review = await ConversationReview.findOne({ orgId, reviewId });
            if (!review) return { status: 404, json: { success: false, error: "Review not found" } };
            if (review.promotedSimulationId) {
                return {
                    status: 409,
                    json: { success: false, error: "Already promoted", simulationId: review.promotedSimulationId },
                };
            }

            const messages = await Message.find({ orgId, conversationId: review.conversationId })
                .sort({ createdAt: 1 })
                .limit(20)
                .lean();
            if (messages.length === 0) {
                return { status: 400, json: { success: false, error: "That conversation has no messages to build a persona from" } };
            }

            const customerMessages = messages.filter((message) => message.role === "USER");
            const opening = customerMessages[0] ? customerMessages[0].content : "";

            const simulation = await Simulation.create({
                orgId,
                simulationId: generalFunctions.generateId(IdPrefix.SIMULATION),
                name: `From review: ${opening.slice(0, 60)}`,
                description: `Built from conversation ${review.conversationId}, flagged by ${review.trigger}.`,
                persona: {
                    // The customer's real first message, verbatim. A
                    // paraphrase would test a question nobody asked.
                    openingMessage: opening,
                    details: `A customer who asked: "${opening}". They follow up the way the original customer did: ${customerMessages
                        .slice(1, 4)
                        .map((message) => `"${message.content.slice(0, 120)}"`)
                        .join(", ") || "they accept the first answer"}.`,
                    identityVerified: false,
                },
                // Left for the author to fill in. Guessing criteria from a
                // transcript produces criteria that describe what happened,
                // which every future run then passes by definition.
                criteria: ["TODO: what should the agent have done differently?"],
                expectedOutcome: null,
            });

            review.promotedSimulationId = simulation.simulationId;
            await review.save();

            return {
                status: 201,
                json: {
                    success: true,
                    data: { simulationId: simulation.simulationId },
                    note: "Edit the criteria before running — they were left as a TODO on purpose.",
                },
            };
        } catch (error) {
            console.error("MonitorFunctions:promoteToSimulation: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // ── Private Helper Functions ─────────────────────────────────────

    async _matchConversations({ orgId, monitor, conversations }) {
        switch (monitor.trigger) {
            case MonitorTrigger.ALL_ESCALATIONS:
                return conversations
                    .filter((conversation) => conversation.status === ConversationStatus.ESCALATED)
                    .map((conversation) => ({ conversation, reason: "Conversation was escalated" }));

            case MonitorTrigger.ALL_ABSTENTIONS: {
                const ids = conversations.map((conversation) => conversation.conversationId);
                const traces = await TurnTrace.find({
                    orgId,
                    conversationId: { $in: ids },
                    outcome: TurnOutcome.ABSTAINED,
                })
                    .select("conversationId")
                    .lean();
                const abstained = new Set(traces.map((trace) => trace.conversationId));
                return conversations
                    .filter((conversation) => abstained.has(conversation.conversationId))
                    .map((conversation) => ({ conversation, reason: "The agent abstained on at least one turn" }));
            }

            case MonitorTrigger.NEGATIVE_SENTIMENT:
                return conversations
                    .filter((conversation) =>
                        (conversation.attributes || []).some(
                            (attribute) =>
                                attribute.value === GateSentiment.NEGATIVE || attribute.value === GateSentiment.ANGRY
                        )
                    )
                    .map((conversation) => ({ conversation, reason: "Negative or angry sentiment detected" }));

            case MonitorTrigger.LOW_QUALITY_SCORE:
                return conversations
                    .filter(
                        (conversation) =>
                            conversation.quality &&
                            typeof conversation.quality.score === "number" &&
                            conversation.quality.score < monitor.scoreBelow
                    )
                    .map((conversation) => ({
                        conversation,
                        reason: `Quality score ${conversation.quality.score.toFixed(2)} is below ${monitor.scoreBelow}`,
                    }));

            case MonitorTrigger.KEYWORD_MATCH: {
                const ids = conversations.map((conversation) => conversation.conversationId);
                const needles = monitor.keywords.map((keyword) => keyword.toLowerCase());
                const messages = await Message.find({ orgId, conversationId: { $in: ids } })
                    .select("conversationId content")
                    .lean();

                const hits = new Map();
                for (const message of messages) {
                    const haystack = String(message.content || "").toLowerCase();
                    const hit = needles.find((needle) => haystack.includes(needle));
                    if (hit && !hits.has(message.conversationId)) hits.set(message.conversationId, hit);
                }
                return conversations
                    .filter((conversation) => hits.has(conversation.conversationId))
                    .map((conversation) => ({
                        conversation,
                        reason: `Matched keyword "${hits.get(conversation.conversationId)}"`,
                    }));
            }

            case MonitorTrigger.RANDOM_SAMPLE: {
                // Sampled by a hash of the conversation id, not by a random
                // draw. Deterministic sampling means a re-run flags the same
                // conversations rather than accumulating a new random slice on
                // every tick until the whole workspace is in the queue.
                const threshold = (monitor.samplePercent || 5) / 100;
                return conversations
                    .filter((conversation) => this._hashFraction(conversation.conversationId) < threshold)
                    .map((conversation) => ({ conversation, reason: "Random sample" }));
            }

            default:
                return [];
        }
    }

    async _enqueue({ orgId, monitor, match }) {
        try {
            await ConversationReview.create({
                orgId,
                reviewId: generalFunctions.generateId(IdPrefix.REVIEW),
                conversationId: match.conversation.conversationId,
                monitorId: monitor.monitorId,
                trigger: monitor.trigger,
                reason: match.reason,
                assignedTo: monitor.assignTo || null,
                status: monitor.assignTo ? ReviewStatus.IN_REVIEW : ReviewStatus.PENDING,
            });
            return true;
        } catch (error) {
            // Already queued by an earlier sweep. This is the expected path on
            // every run after the first, not an error worth reporting.
            if (error && error.code === 11000) return false;
            console.error("MonitorFunctions:_enqueue: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return false;
        }
    }

    // Stable 0..1 from a string. FNV-1a: short, no dependency, and good enough
    // for spreading ids evenly.
    _hashFraction(value) {
        let hash = 2166136261;
        for (let index = 0; index < value.length; index++) {
            hash ^= value.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0) / 4294967295;
    }
}

module.exports = new MonitorFunctions();
module.exports.SWEEP_WINDOW_HOURS = SWEEP_WINDOW_HOURS;
