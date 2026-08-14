const EndUser = require("../../models/user/endUser");
const Conversation = require("../../models/conversation/conversation");
const { ConversationStatus } = require("../../config/enums");
const generalFunctions = require("../utilFunctions/generalFunctions");

class UserFunctions {
    // People who have chatted with the agent. "identified" = signed identity
    // verified; "temporary" = an anonymous or unsigned visitor.
    async listUsers({ orgId, verified, search, page, limit }) {
        console.log("UserFunctions:listUsers: orgId:", orgId);
        try {
            if (!orgId) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId" } };
            }
            const pageNum = Math.max(parseInt(page, 10) || 1, 1);
            const pageSize = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

            const filter = { orgId };
            if (verified === "true") filter.verified = true;
            if (verified === "false") filter.verified = false;
            if (search) {
                filter.$or = [
                    { email: { $regex: search, $options: "i" } },
                    { name: { $regex: search, $options: "i" } },
                    { endUserId: { $regex: search, $options: "i" } },
                ];
            }

            const [users, total, identifiedCount, temporaryCount] = await Promise.all([
                EndUser.find(filter)
                    .sort({ lastSeenAt: -1 })
                    .skip((pageNum - 1) * pageSize)
                    .limit(pageSize)
                    .lean(),
                EndUser.countDocuments(filter),
                EndUser.countDocuments({ orgId, verified: true }),
                EndUser.countDocuments({ orgId, verified: false }),
            ]);

            // Chat counts per user in one grouped query rather than N lookups
            const counts = await Conversation.aggregate([
                { $match: { orgId, endUserId: { $in: users.map((user) => user.endUserId) } } },
                { $group: { _id: "$endUserId", chats: { $sum: 1 } } },
            ]);
            const chatsByUser = new Map(counts.map((row) => [row._id, row.chats]));

            const data = users.map((user) => ({
                endUserId: user.endUserId,
                name: user.name || null,
                email: user.email || null,
                verified: user.verified,
                lastSeenAt: user.lastSeenAt || user.updatedAt,
                chats: chatsByUser.get(user.endUserId) || 0,
            }));

            return {
                status: 200,
                json: { success: true, data, total, identifiedCount, temporaryCount, page: pageNum, limit: pageSize },
            };
        } catch (error) {
            console.error("UserFunctions:listUsers: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // GET /api/org/:orgId/users/:endUserId — the person plus every conversation
    // they have had, so the row in the table opens into something real.
    async getUser({ orgId, endUserId }) {
        console.log("UserFunctions:getUser: orgId:", orgId, "endUserId:", endUserId);
        try {
            if (!orgId || !endUserId) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId and endUserId" } };
            }
            const user = await EndUser.findOne({ orgId, endUserId }).lean();
            if (!user) {
                return { status: 404, json: { success: false, error: "User not found" } };
            }

            const conversations = await Conversation.find({ orgId, endUserId })
                .sort({ lastMessageAt: -1 })
                .limit(50)
                .lean();

            const totalCostUsd = conversations.reduce((sum, c) => sum + (c.totalCostUsd || 0), 0);
            const resolved = conversations.filter((c) => c.isResolved).length;

            return {
                status: 200,
                json: {
                    success: true,
                    data: {
                        user: {
                            endUserId: user.endUserId,
                            name: user.name || null,
                            email: user.email || null,
                            verified: user.verified,
                            lastSeenAt: user.lastSeenAt || user.updatedAt,
                            createdAt: user.createdAt,
                        },
                        stats: {
                            chats: conversations.length,
                            resolved,
                            escalated: conversations.filter((c) => c.status === ConversationStatus.ESCALATED).length,
                            totalCostUsd,
                        },
                        conversations: conversations.map((c) => ({
                            conversationId: c.conversationId,
                            status: c.status,
                            isResolved: c.isResolved,
                            turnCount: c.turnCount,
                            lastMessagePreview: c.lastMessagePreview || null,
                            lastMessageAt: c.lastMessageAt,
                            createdAt: c.createdAt,
                        })),
                    },
                },
            };
        } catch (error) {
            console.error("UserFunctions:getUser: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }
}

module.exports = new UserFunctions();
