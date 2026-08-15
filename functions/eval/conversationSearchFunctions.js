const {
    ConversationStatus,
    TurnOutcome,
    FeedbackRating,
    ConversationChannel,
    IdPrefix,
} = require("../../config/enums");
const Conversation = require("../../models/conversation/conversation");
const Message = require("../../models/conversation/message");
const TurnTrace = require("../../models/trace/turnTrace");
const EndUser = require("../../models/user/endUser");
const SavedView = require("../../models/eval/savedView");
const generalFunctions = require("../utilFunctions/generalFunctions");

// §3.7 — conversation search and filtering.
//
// The existing inbox list searches the last-message preview and the customer's
// name. That is the right default and stays where it is. This is the other
// thing people mean by "search": across the full text of every message, with
// structured filters on top.
//
// Full-text is a regex scan over the Message collection rather than an Atlas
// $search index. Deliberate: the chunk text index exists because retrieval runs
// on every turn and has to be fast; inbox search runs when a human clicks a
// button, over one workspace's messages, and a second Atlas index is a second
// thing that silently does not exist on a fresh cluster. The scan is bounded
// and indexed by orgId.

const MAX_MESSAGE_SCAN = 5000;

class ConversationSearchFunctions {
    // ── Public Functions ─────────────────────────────────────────────

    async search({ orgId, filters, page, limit }) {
        console.log("ConversationSearchFunctions:search: orgId:", orgId);
        try {
            const criteria = filters || {};
            const pageNumber = Math.max(1, Number(page) || 1);
            const pageSize = Math.min(100, Math.max(1, Number(limit) || 25));

            const query = { orgId };

            if (criteria.status && Object.values(ConversationStatus).includes(criteria.status)) {
                query.status = criteria.status;
            }
            if (criteria.channel && Object.values(ConversationChannel).includes(criteria.channel)) {
                query.channel = criteria.channel;
            }
            if (criteria.rating && Object.values(FeedbackRating).includes(criteria.rating)) {
                query.feedback = criteria.rating;
            }
            if (criteria.assignedTo) query.assignedTo = criteria.assignedTo;
            if (criteria.teamId) query.teamId = criteria.teamId;

            // Dates arrive as ISO strings from a date picker. An unparseable one
            // is ignored rather than turned into `Invalid Date`, which Mongo
            // matches against nothing and which looks exactly like "no results".
            const dateRange = this._dateRange(criteria);
            if (dateRange) query.lastMessageAt = dateRange;

            if (criteria.qualityBelow !== undefined && criteria.qualityBelow !== null) {
                query["quality.score"] = { $lt: Number(criteria.qualityBelow) };
            }

            // Attribute filters: [{ attributeId, value }]. $elemMatch is
            // required — without it Mongo matches a conversation where one
            // attribute has the id and a DIFFERENT one has the value.
            if (Array.isArray(criteria.attributes) && criteria.attributes.length > 0) {
                query.$and = criteria.attributes.map((filter) => ({
                    attributes: {
                        $elemMatch: {
                            attributeId: filter.attributeId,
                            ...(filter.value !== undefined && filter.value !== null ? { value: filter.value } : {}),
                        },
                    },
                }));
            }

            // Identity verified lives on EndUser, so it becomes an id filter.
            if (criteria.identityVerified !== undefined && criteria.identityVerified !== null) {
                const verified = criteria.identityVerified === true || criteria.identityVerified === "true";
                const users = await EndUser.find({ orgId, verified }).select("endUserId").lean();
                const ids = users.map((user) => user.endUserId);
                // An anonymous conversation has no endUserId at all, which is
                // "not verified" — a plain $in would drop those rows and report
                // far fewer unverified conversations than exist.
                query.endUserId = verified ? { $in: ids } : { $in: [...ids, null] };
            }

            // Outcome lives on the trace, one per turn. A conversation matches
            // if ANY of its turns had the outcome, which is what someone
            // filtering for "escalated" means.
            if (criteria.outcome && Object.values(TurnOutcome).includes(criteria.outcome)) {
                const traces = await TurnTrace.find({ orgId, outcome: criteria.outcome })
                    .select("conversationId")
                    .limit(MAX_MESSAGE_SCAN)
                    .lean();
                const ids = [...new Set(traces.map((trace) => trace.conversationId))];
                query.conversationId = this._intersect(query.conversationId, ids);
            }

            // Full-text across message bodies.
            if (criteria.text && String(criteria.text).trim()) {
                const escaped = String(criteria.text).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                const messages = await Message.find({ orgId, content: { $regex: escaped, $options: "i" } })
                    .select("conversationId")
                    .limit(MAX_MESSAGE_SCAN)
                    .lean();
                const ids = [...new Set(messages.map((message) => message.conversationId))];
                query.conversationId = this._intersect(query.conversationId, ids);
            }

            const [conversations, total] = await Promise.all([
                Conversation.find(query)
                    .sort({ lastMessageAt: -1 })
                    .skip((pageNumber - 1) * pageSize)
                    .limit(pageSize)
                    .lean(),
                Conversation.countDocuments(query),
            ]);

            const endUserIds = [...new Set(conversations.map((conversation) => conversation.endUserId).filter(Boolean))];
            const endUsers = await EndUser.find({ orgId, endUserId: { $in: endUserIds } }).lean();
            const usersById = new Map(endUsers.map((user) => [user.endUserId, user]));

            return {
                status: 200,
                json: {
                    success: true,
                    data: conversations.map((conversation) => {
                        const copy = { ...conversation };
                        delete copy._id;
                        delete copy.__v;
                        const user = conversation.endUserId ? usersById.get(conversation.endUserId) : null;
                        copy.user = user
                            ? { name: user.name || user.email, email: user.email, verified: user.verified }
                            : { name: "Anonymous", email: null, verified: false };
                        return copy;
                    }),
                    pagination: { page: pageNumber, limit: pageSize, total },
                    // Reported so a result set silently capped by the scan limit
                    // does not read as a complete answer.
                    truncated: total >= MAX_MESSAGE_SCAN,
                },
            };
        } catch (error) {
            console.error("ConversationSearchFunctions:search: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async listViews({ orgId }) {
        console.log("ConversationSearchFunctions:listViews: orgId:", orgId);
        try {
            const views = await SavedView.find({ orgId }).sort({ createdAt: 1 }).lean();
            return {
                status: 200,
                json: {
                    success: true,
                    data: views.map((view) => {
                        const copy = { ...view };
                        delete copy._id;
                        delete copy.__v;
                        return copy;
                    }),
                },
            };
        } catch (error) {
            console.error("ConversationSearchFunctions:listViews: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async saveView({ orgId, name, filters, createdBy }) {
        console.log("ConversationSearchFunctions:saveView: orgId:", orgId);
        try {
            if (!name || !String(name).trim()) {
                return { status: 400, json: { success: false, error: "name is required" } };
            }

            // Upsert on name: saving over an existing view is what someone
            // means when they tweak a filter and hit save again.
            const view = await SavedView.findOneAndUpdate(
                { orgId, name: String(name).trim() },
                {
                    $set: { filters: filters || {}, createdBy: createdBy || null },
                    $setOnInsert: { savedViewId: generalFunctions.generateId("view") },
                },
                { new: true, upsert: true }
            );

            return { status: 200, json: { success: true, data: view.toJSON() } };
        } catch (error) {
            console.error("ConversationSearchFunctions:saveView: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async deleteView({ orgId, savedViewId }) {
        console.log("ConversationSearchFunctions:deleteView: savedViewId:", savedViewId);
        try {
            const result = await SavedView.deleteOne({ orgId, savedViewId });
            if (result.deletedCount === 0) {
                return { status: 404, json: { success: false, error: "View not found" } };
            }
            return { status: 200, json: { success: true, data: { deleted: savedViewId } } };
        } catch (error) {
            console.error("ConversationSearchFunctions:deleteView: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // ── Private Helper Functions ─────────────────────────────────────

    // Two id filters have to intersect, not overwrite. Text search AND outcome
    // filter both narrow by conversationId, and a naive assignment would make
    // whichever ran second the only one that applied.
    _intersect(existing, ids) {
        if (!existing || !existing.$in) return { $in: ids };
        const set = new Set(ids);
        return { $in: existing.$in.filter((id) => set.has(id)) };
    }

    _dateRange(criteria) {
        const range = {};
        const from = criteria.from ? new Date(criteria.from) : null;
        const to = criteria.to ? new Date(criteria.to) : null;
        if (from && !Number.isNaN(from.getTime())) range.$gte = from;
        if (to && !Number.isNaN(to.getTime())) range.$lte = to;
        return Object.keys(range).length > 0 ? range : null;
    }
}

module.exports = new ConversationSearchFunctions();
module.exports.MAX_MESSAGE_SCAN = MAX_MESSAGE_SCAN;
