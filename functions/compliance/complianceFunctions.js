const config = require("../../config/config");
const Org = require("../../models/org/org");
const Member = require("../../models/org/member");
const EndUser = require("../../models/user/endUser");
const KnowledgeSource = require("../../models/knowledge/knowledgeSource");
const Chunk = require("../../models/knowledge/chunk");
const Table = require("../../models/table/table");
const TableRow = require("../../models/table/tableRow");
const Action = require("../../models/action/action");
const ActionExecution = require("../../models/action/actionExecution");
const Procedure = require("../../models/procedure/procedure");
const Conversation = require("../../models/conversation/conversation");
const Message = require("../../models/conversation/message");
const TurnTrace = require("../../models/trace/turnTrace");
const generalFunctions = require("../utilFunctions/generalFunctions");

const DAY_MS = 24 * 60 * 60 * 1000;

// Data handling obligations (§8.1). The DPA published on zealoop.com already
// promises export and erasure, so these are contractual, not aspirational.
class ComplianceFunctions {
    // ── Public Functions ─────────────────────────────────────────────

    // Everything a workspace owns, as one JSON document. Required by the DPA.
    // Embeddings are excluded deliberately: they are derived data, enormous,
    // and meaningless outside this system — the chunk text they came from is
    // included instead.
    async exportWorkspace({ orgId }) {
        console.log("ComplianceFunctions:exportWorkspace: orgId:", orgId);
        try {
            if (!orgId) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId" } };
            }

            const org = await Org.findOne({ orgId });
            if (!org) {
                return { status: 404, json: { success: false, error: "Org not found" } };
            }

            const [
                members,
                endUsers,
                sources,
                chunks,
                tables,
                tableRows,
                actions,
                actionExecutions,
                procedures,
                conversations,
                messages,
                traces,
            ] = await Promise.all([
                Member.find({ orgId }).lean(),
                EndUser.find({ orgId }).lean(),
                KnowledgeSource.find({ orgId }).lean(),
                Chunk.find({ orgId }).select("-embedding").lean(),
                Table.find({ orgId }).lean(),
                TableRow.find({ orgId }).lean(),
                Action.find({ orgId }).lean(),
                ActionExecution.find({ orgId }).lean(),
                Procedure.find({ orgId }).lean(),
                Conversation.find({ orgId }).lean(),
                Message.find({ orgId }).lean(),
                TurnTrace.find({ orgId }).lean(),
            ]);

            return {
                status: 200,
                json: {
                    success: true,
                    data: {
                        exportedAt: new Date().toISOString(),
                        orgId,
                        // toJSON strips widgetSecret; .lean() would not, so the
                        // org goes through the document's own transform.
                        org: org.toJSON(),
                        members,
                        endUsers,
                        knowledgeSources: sources,
                        chunks,
                        tables,
                        tableRows,
                        actions,
                        actionExecutions,
                        procedures,
                        conversations,
                        messages,
                        turnTraces: traces,
                    },
                },
            };
        } catch (error) {
            console.error("ComplianceFunctions:exportWorkspace: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // Right-to-erasure for one end user. Deletes rather than anonymises: a
    // request to be forgotten is not satisfied by a row that still says when
    // they wrote and what they asked.
    async eraseEndUser({ orgId, endUserId, email }) {
        console.log("ComplianceFunctions:eraseEndUser: orgId:", orgId, "endUserId:", endUserId);
        try {
            if (!orgId || (!endUserId && !email)) {
                return {
                    status: 400,
                    json: { success: false, error: "Invalid request. Please pass orgId and endUserId or email" },
                };
            }

            const endUser = await EndUser.findOne({
                orgId,
                ...(endUserId ? { endUserId } : { email }),
            });
            if (!endUser) {
                return { status: 404, json: { success: false, error: "End user not found" } };
            }

            const conversations = await Conversation.find({ orgId, endUserId: endUser.endUserId })
                .select("conversationId")
                .lean();
            const conversationIds = conversations.map((conversation) => conversation.conversationId);

            // Table rows are matched on identityValue rather than endUserId,
            // because rows are imported by the customer against an identity key
            // (an email, an account number) and never carry our id.
            const [messages, traces, rows, executions] = await Promise.all([
                Message.deleteMany({ orgId, conversationId: { $in: conversationIds } }),
                TurnTrace.deleteMany({ orgId, conversationId: { $in: conversationIds } }),
                endUser.email ? TableRow.deleteMany({ orgId, identityValue: endUser.email }) : { deletedCount: 0 },
                ActionExecution.deleteMany({ orgId, conversationId: { $in: conversationIds } }),
            ]);

            await Conversation.deleteMany({ orgId, conversationId: { $in: conversationIds } });
            await EndUser.deleteOne({ orgId, endUserId: endUser.endUserId });

            return {
                status: 200,
                json: {
                    success: true,
                    data: {
                        endUserId: endUser.endUserId,
                        deleted: {
                            conversations: conversationIds.length,
                            messages: messages.deletedCount || 0,
                            turnTraces: traces.deletedCount || 0,
                            tableRows: rows.deletedCount || 0,
                            actionExecutions: executions.deletedCount || 0,
                            endUsers: 1,
                        },
                    },
                },
            };
        } catch (error) {
            console.error("ComplianceFunctions:eraseEndUser: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // Run by cron. Conversations and traces past the retention window are
    // deleted wholesale — the window is the promise, and keeping "just the
    // useful parts" past it is exactly what a retention policy forbids.
    async purgeExpired({ retentionDays = config.RETENTION_DAYS } = {}) {
        console.log("ComplianceFunctions:purgeExpired: retentionDays:", retentionDays);
        try {
            // 0 disables purging. Deleting everything because a variable was
            // unset would be the single worst bug in this file.
            if (!retentionDays || retentionDays <= 0) {
                return { success: true, skipped: true, reason: "retention disabled" };
            }

            const cutoff = new Date(Date.now() - retentionDays * DAY_MS);

            const expired = await Conversation.find({ createdAt: { $lt: cutoff } })
                .select("conversationId orgId")
                .lean();
            const conversationIds = expired.map((conversation) => conversation.conversationId);

            if (conversationIds.length === 0) {
                const traces = await TurnTrace.deleteMany({ createdAt: { $lt: cutoff } });
                return { success: true, deleted: { conversations: 0, messages: 0, turnTraces: traces.deletedCount || 0 } };
            }

            const [messages, traces] = await Promise.all([
                Message.deleteMany({ conversationId: { $in: conversationIds } }),
                TurnTrace.deleteMany({ createdAt: { $lt: cutoff } }),
            ]);
            const conversations = await Conversation.deleteMany({ conversationId: { $in: conversationIds } });

            console.log(
                "ComplianceFunctions:purgeExpired: removed",
                conversations.deletedCount,
                "conversations,",
                messages.deletedCount,
                "messages,",
                traces.deletedCount,
                "traces"
            );

            return {
                success: true,
                deleted: {
                    conversations: conversations.deletedCount || 0,
                    messages: messages.deletedCount || 0,
                    turnTraces: traces.deletedCount || 0,
                },
            };
        } catch (error) {
            console.error("ComplianceFunctions:purgeExpired: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { success: false };
        }
    }
}

module.exports = new ComplianceFunctions();
