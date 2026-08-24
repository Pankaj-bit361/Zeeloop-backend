const Org = require("../../models/org/org");
const EndUser = require("../../models/user/endUser");
const Chunk = require("../../models/knowledge/chunk");
const KnowledgeSource = require("../../models/knowledge/knowledgeSource");
const Action = require("../../models/action/action");
const Conversation = require("../../models/conversation/conversation");
const Message = require("../../models/conversation/message");
const TurnTrace = require("../../models/trace/turnTrace");
const {
    ConversationStatus,
    MessageRole,
    ToolCallStatus,
    FeedbackRating,
    IdPrefix,
    TurnOutcome,
    SourceStatus,
    QuotaState,
} = require("../../config/enums");
const config = require("../../config/config");
const generalFunctions = require("../utilFunctions/generalFunctions");
const { asId } = require("../utilFunctions/generalFunctions");
const themeDerivation = require("../utilFunctions/themeDerivation");
const realtimeHub = require("../realtime/realtimeHub");
const usageFunctions = require("../billing/usageFunctions");
const agentFunctions = require("../agent/agentFunctions");
const attributeFunctions = require("../config/attributeFunctions");
const emailFunctions = require("../email/emailFunctions");
const outboundWebhookFunctions = require("../webhook/outboundWebhookFunctions");
const securityFunctions = require("../security/securityFunctions");
const expansionFunctions = require("../expansion/expansionFunctions");
const widgetConfigFunctions = require("../widget/widgetConfigFunctions");
const responseComponentFunctions = require("../widget/responseComponentFunctions");

// Shown to end users on a workspace that has hit its conversation quota or cost
// ceiling. Deliberately says nothing about billing: the visitor is the
// customer's customer, and "they did not pay their bill" is not their problem.
const DEGRADED_REPLY =
    "I'm not able to answer right now. Someone from the team will follow up — thanks for your patience.";
const actionFunctions = require("../action/actionFunctions");

class ChatFunctions {
    // POST /api/widget/rtm/connect — where to open the live socket.
    //
    // Returns a list, primary first, so a client that cannot reach the first
    // endpoint has somewhere to go instead of falling back to polling on its
    // first attempt. Today both entries point at this deployment; the shape is
    // what matters, because changing it later would mean re-embedding every
    // customer's snippet.
    async rtmConnect({ publicKey }) {
        console.log("ChatFunctions:rtmConnect: publicKey:", publicKey);
        try {
            if (!publicKey) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass publicKey" } };
            }
            const org = await Org.findOne({ publicKey: asId(publicKey) }).select("orgId").lean();
            if (!org) {
                return { status: 404, json: { success: false, error: "Unknown publicKey" } };
            }
            const base = String(config.API_URL || "").replace(/^http/, "ws").replace(/\/$/, "");
            return {
                status: 200,
                json: {
                    success: true,
                    data: {
                        channelPrefix: `conv:${org.orgId}:`,
                        endpoints: [{ endpoint: `${base}/rtm` }],
                        // How long the client should wait for the socket before
                        // giving up and letting polling carry the session.
                        connectTimeoutMs: 6000,
                        heartbeatMs: 25000,
                    },
                },
            };
        } catch (error) {
            console.error("ChatFunctions:rtmConnect: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // POST /api/widget/bootstrap — org by publicKey, widget config + a conversation.
    //
    // The home screen default now lives in widgetConfigFunctions alongside the
    // rest of the §4.1 logic, so the dashboard's idea of "the default sections"
    // and the widget's cannot drift apart.
    async bootstrap({ publicKey, conversationId, identity, accentColor, pageUrl, pageSettings, origin }) {
        console.log("ChatFunctions:bootstrap: publicKey:", publicKey);
        try {
            if (!publicKey) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass publicKey" } };
            }
            const org = await Org.findOne({ publicKey: asId(publicKey) });
            if (!org) {
                return { status: 404, json: { success: false, error: "Unknown publicKey" } };
            }

            const { endUser, identityVerified } = await this._resolveIdentity({ org, identity });

            // No conversation is created here — threads spawn lazily on the first
            // message, so idle widget loads never leave empty rows in the inbox.
            const conversation = conversationId
                ? await Conversation.findOne({ orgId: org.orgId, conversationId: asId(conversationId) })
                : null;

            const messages = conversation
                ? await Message.find({ orgId: org.orgId, conversationId: conversation.conversationId })
                      .sort({ createdAt: 1 })
                      .limit(100)
                : [];

            // A reload mid-confirmation must not lose the confirm card — surface
            // the pending action so the widget can re-render it.
            let pendingAction = null;
            if (conversation && conversation.pendingAction && conversation.pendingAction.actionId) {
                const pendingId = conversation.pendingAction.actionId;
                const action = await Action.findOne({ orgId: org.orgId, actionId: pendingId });
                // The action may have been renamed or deleted since the turn ran;
                // the message that proposed it still knows what it was called.
                const proposedName = messages
                    .flatMap((message) => message.toolCalls || [])
                    .find((tool) => tool.actionId === pendingId && tool.actionName)?.actionName;
                pendingAction = {
                    actionId: pendingId,
                    actionName: (action && action.name) || proposedName || pendingId,
                    args: conversation.pendingAction.args || {},
                };
            }

            // §1.6 step 5 — the install verification signal. Fire-and-forget:
            // the wizard polls for it, and the widget must not wait on a write
            // it does not read.
            this._recordPing({ orgId: org.orgId, origin }).catch((error) => {
                console.error("ChatFunctions:bootstrap: ping failed");
                console.error(error.message);
            });

            // §4.3 — launcher visibility, decided in one place with a stated
            // reason. The widget renders `launcher.show`; the reason string is
            // what answers "why is it not showing on this page" without a
            // support ticket.
            const launcher = await widgetConfigFunctions.shouldShowLauncher({
                org,
                pageUrl,
                identityVerified,
                endUser,
                pageSettings,
            });

            return {
                status: 200,
                json: {
                    success: true,
                    data: {
                        orgId: org.orgId,
                        orgName: org.name,
                        agent: org.agent,
                        widget: org.widget,
                        // Pre-computed tokens; a snippet accent override re-derives
                        // here, server-side — the widget never does color math.
                        themeTokens: accentColor
                            ? themeDerivation.deriveThemes(accentColor)
                            : org.widget.themeTokens || themeDerivation.deriveThemes(org.widget.accentColor || null),
                        configVersion: org.widget.configVersion || 1,
                        homeSections: widgetConfigFunctions.resolveHomeSections({ org }),
                        // §4.4 — the 8px spacing scale, served rather than
                        // hardcoded in the embed, so a visual change reaches
                        // deployed widgets without anyone republishing a script.
                        spacing: widgetConfigFunctions.SPACING_TOKENS,
                        // §4.5 — computed from luminance for a solid background,
                        // and carrying a warning when the background is a
                        // gradient and needs a manual choice.
                        headerText: widgetConfigFunctions.resolveHeaderTextColor({ org }),
                        // §4.2 — `{first_name}` already substituted, and the
                        // whole clause collapsed when there is no name.
                        welcome: widgetConfigFunctions.renderWelcome({ org, endUser, identityVerified }),
                        launcher,
                        conversationId: conversation ? conversation.conversationId : null,
                        conversationStatus: conversation ? conversation.status : null,
                        identityVerified,
                        messages,
                        pendingAction,
                    },
                },
            };
        } catch (error) {
            console.error("ChatFunctions:bootstrap: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // POST /api/widget/messages — the widget's message endpoint; runs the pipeline.
    // conversationId is optional: the first message of a fresh thread creates the
    // conversation lazily, so opening the widget never spawns empty rows.
    async sendMessage({ publicKey, conversationId, content, identity, ip }) {
        console.log("ChatFunctions:sendMessage: conversationId:", conversationId);
        try {
            if (!publicKey || !content) {
                return {
                    status: 400,
                    json: { success: false, error: "Invalid request. Please pass publicKey and content" },
                };
            }
            const org = await Org.findOne({ publicKey: asId(publicKey) });
            if (!org) {
                return { status: 404, json: { success: false, error: "Unknown publicKey" } };
            }

            const { endUser, identityVerified } = await this._resolveIdentity({ org, identity });

            // §8.2 — the blocklist. Checked before the message is stored and
            // before any model call, because the point is to stop spending money
            // on someone the workspace has already decided is abusive.
            //
            // The visitor gets the same graceful message a quota-exceeded
            // workspace gives, not "you are blocked": telling an abuser exactly
            // what happened tells them what to change.
            const blocked = await expansionFunctions.checkBlocked({
                orgId: org.orgId,
                email: identity && identity.email,
                ip,
            });
            if (blocked.blocked) {
                console.log("ChatFunctions:sendMessage: blocked by", blocked.type, "for orgId:", org.orgId);
                return {
                    status: 200,
                    json: {
                        success: true,
                        data: {
                            conversationId: conversationId || null,
                            message: { role: MessageRole.ASSISTANT, content: DEGRADED_REPLY },
                            outcome: TurnOutcome.BLOCKED,
                            awaitingConfirmation: false,
                            degraded: true,
                        },
                    },
                };
            }

            let conversation = conversationId
                ? await Conversation.findOne({ orgId: org.orgId, conversationId: asId(conversationId) })
                : null;
            if (conversationId && !conversation) {
                return { status: 404, json: { success: false, error: "Conversation not found" } };
            }
            const isNewConversation = !conversation;
            if (!conversation) {
                conversation = await Conversation.create({
                    orgId: org.orgId,
                    conversationId: generalFunctions.generateId(IdPrefix.CONVERSATION),
                    endUserId: endUser ? endUser.endUserId : null,
                    status: ConversationStatus.OPEN,
                });
            }
            conversationId = conversation.conversationId;

            const history = await Message.find({ orgId: org.orgId, conversationId })
                .sort({ createdAt: 1 })
                .limit(50)
                .lean();

            const visitorMessage = await Message.create({
                orgId: org.orgId,
                messageId: generalFunctions.generateId(IdPrefix.MESSAGE),
                conversationId,
                role: MessageRole.USER,
                content,
            });

            // An agent with this thread open in the dashboard learns about the
            // visitor's own message the same way the visitor's other tabs learn
            // about the assistant's reply below — over the socket, not a poll.
            // This was the missing half: only the assistant/human-agent replies
            // were ever published, so a dashboard subscribed to this channel
            // would sit silent through the exact event it most needs to know
            // about — the customer actually saying something.
            realtimeHub.publish(org.orgId, conversationId, { type: "message", message: visitorMessage.toJSON() });

            // Quota is checked after the question is stored, not before (§0.3).
            // A workspace that hits its ceiling still wants to see what its
            // customers were asking while capped — that is the demand signal
            // that justifies the upgrade. The visitor gets a graceful message
            // rather than an error, because a support widget that returns a 500
            // reflects on the customer, not on us.
            const quota = await usageFunctions.checkQuota({ orgId: org.orgId });
            if (quota.state === QuotaState.EXCEEDED) {
                console.log("ChatFunctions:sendMessage: quota exceeded for orgId:", org.orgId, "reason:", quota.reason);
                const degradedMessage = await Message.create({
                    orgId: org.orgId,
                    messageId: generalFunctions.generateId(IdPrefix.MESSAGE),
                    conversationId,
                    role: MessageRole.ASSISTANT,
                    content: DEGRADED_REPLY,
                });

                conversation.turnCount += 1;
                conversation.lastMessageAt = new Date();
                conversation.lastMessagePreview = content.slice(0, 140);
                await conversation.save();

                await usageFunctions.recordTurn({ orgId: org.orgId, isNewConversation });

                return {
                    status: 200,
                    json: {
                        success: true,
                        data: {
                            conversationId,
                            message: degradedMessage,
                            outcome: TurnOutcome.ERROR,
                            awaitingConfirmation: false,
                            // The widget can use this to hide the composer; the
                            // dashboard uses the reason to explain why.
                            degraded: true,
                            reason: quota.reason,
                        },
                    },
                };
            }

            const turn = await agentFunctions.runTurn({
                org,
                conversation,
                endUser,
                identityVerified,
                rawMessage: content,
                history,
            });

            const assistantMessage = await Message.create({
                orgId: org.orgId,
                messageId: generalFunctions.generateId(IdPrefix.MESSAGE),
                conversationId,
                role: MessageRole.ASSISTANT,
                content: turn.reply,
                citations: turn.citations || [],
                toolCalls: turn.toolCalls || [],
                receipt: turn.receipt || null,
            });

            conversation.turnCount += 1;
            conversation.totalCostUsd += turn.costUsd || 0;
            conversation.lastMessageAt = new Date();
            conversation.lastMessagePreview = content.slice(0, 140);
            if (turn.escalate || turn.outcome === TurnOutcome.ESCALATED) {
                conversation.status = ConversationStatus.ESCALATED;
            }
            conversation.pendingAction = turn.halted && turn.pendingAction ? turn.pendingAction : { actionId: null, args: null };
            if (endUser && !conversation.endUserId) {
                conversation.endUserId = endUser.endUserId;
            }
            await conversation.save();

            // Other tabs the same visitor has open are watching this thread.
            realtimeHub.publish(org.orgId, conversationId, {
                type: "message",
                message: assistantMessage.toJSON(),
            });

            // §2.3 — attribute detection runs after the reply is written and is
            // deliberately NOT awaited. It is worth a small-model call to keep
            // the inbox's columns populated; it is not worth adding that call's
            // latency to every customer's answer, and a classifier outage must
            // not be able to fail a turn that already succeeded.
            attributeFunctions
                .detectForTurn({
                    orgId: org.orgId,
                    conversationId,
                    gateSentiment: turn.sentiment || null,
                    context: { identityVerified, turnCount: conversation.turnCount },
                })
                .catch((error) => {
                    console.error("ChatFunctions:sendMessage: attribute detection failed");
                    console.error(error);
                    generalFunctions.captureException(error);
                });

            // §4.8 — escalation notice to the team. Same reasoning: an email
            // provider being slow must not hold the widget's response open.
            if (turn.escalate || turn.outcome === TurnOutcome.ESCALATED) {
                emailFunctions
                    .sendEscalationNotice({ org, conversationId, lastMessage: content, rule: turn.escalationRule || null })
                    .catch((error) => {
                        console.error("ChatFunctions:sendMessage: escalation notice failed");
                        console.error(error);
                        generalFunctions.captureException(error);
                    });
            }

            // Outbound webhooks (§5.6), for customers wiring Zealoop into their
            // own systems. Fire-and-forget for the same reason.
            outboundWebhookFunctions
                .dispatchForTurn({ org, conversation, turn, isNewConversation })
                .catch((error) => {
                    console.error("ChatFunctions:sendMessage: webhook dispatch failed");
                    console.error(error);
                    generalFunctions.captureException(error);
                });

            // Metered after the turn completes, never before — a turn that threw
            // should not be billed to the customer.
            await usageFunctions.recordTurn({
                orgId: org.orgId,
                costUsd: turn.costUsd || 0,
                inputTokens: turn.inputTokens || 0,
                outputTokens: turn.outputTokens || 0,
                isNewConversation,
            });

            return {
                status: 200,
                json: {
                    success: true,
                    data: {
                        conversationId,
                        message: assistantMessage,
                        outcome: turn.outcome,
                        awaitingConfirmation: !!turn.halted,
                        // §4.6 — the rich response contract. Built from the
                        // turn's real state by code that knows a guard actually
                        // fired, never emitted by the model. A widget that does
                        // not understand a component renders its fallbackText,
                        // so old embeds keep working.
                        components: responseComponentFunctions.fromTurn({ turn }).components,
                    },
                },
            };
        } catch (error) {
            console.error("ChatFunctions:sendMessage: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // POST /api/widget/actions/confirm — executes the write action proposed last turn.
    async confirmAction({ publicKey, conversationId, confirmed, identity }) {
        console.log("ChatFunctions:confirmAction: conversationId:", conversationId);
        try {
            if (!publicKey || !conversationId) {
                return {
                    status: 400,
                    json: { success: false, error: "Invalid request. Please pass publicKey and conversationId" },
                };
            }
            const org = await Org.findOne({ publicKey: asId(publicKey) });
            if (!org) {
                return { status: 404, json: { success: false, error: "Unknown publicKey" } };
            }
            const conversation = await Conversation.findOne({ orgId: org.orgId, conversationId: asId(conversationId) });
            if (!conversation) {
                return { status: 404, json: { success: false, error: "Conversation not found" } };
            }
            const pending = conversation.pendingAction;
            if (!pending || !pending.actionId) {
                return { status: 409, json: { success: false, error: "No action awaiting confirmation" } };
            }

            const { endUser, identityVerified } = await this._resolveIdentity({ org, identity });

            let replyContent;
            let toolCalls = [];

            if (confirmed === false) {
                replyContent = "No problem — I won't run that. Anything else I can help with?";
            } else {
                const execution = await actionFunctions.executeAction({
                    orgId: org.orgId,
                    actionId: pending.actionId,
                    args: pending.args || {},
                    conversationId,
                    endUserId: endUser ? endUser.endUserId : null,
                    confirmed: true,
                    identityVerified,
                });
                if (execution.success) {
                    replyContent = "Done! That's taken care of. Anything else I can help with?";
                    toolCalls = [
                        {
                            actionId: pending.actionId,
                            args: pending.args,
                            status: ToolCallStatus.EXECUTED,
                            executionId: execution.executionId,
                        },
                    ];
                } else if (execution.blocked) {
                    replyContent = "I wasn't able to run that action — I've flagged this conversation for the team.";
                    toolCalls = [{ actionId: pending.actionId, args: pending.args, status: ToolCallStatus.BLOCKED }];
                    conversation.status = ConversationStatus.ESCALATED;
                } else {
                    replyContent = "That didn't go through on our side. I've flagged it for the team to sort out.";
                    toolCalls = [
                        {
                            actionId: pending.actionId,
                            args: pending.args,
                            status: ToolCallStatus.BLOCKED,
                            executionId: execution.executionId || null,
                        },
                    ];
                    conversation.status = ConversationStatus.ESCALATED;
                }
            }

            const message = await Message.create({
                orgId: org.orgId,
                messageId: generalFunctions.generateId(IdPrefix.MESSAGE),
                conversationId,
                role: MessageRole.ASSISTANT,
                content: replyContent,
                toolCalls,
            });

            conversation.pendingAction = { actionId: null, args: null };
            conversation.lastMessageAt = new Date();
            await conversation.save();

            return { status: 200, json: { success: true, data: { message } } };
        } catch (error) {
            console.error("ChatFunctions:confirmAction: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // POST /api/widget/feedback — thumbs up / down on the conversation.
    async feedback({ publicKey, conversationId, rating }) {
        console.log("ChatFunctions:feedback: conversationId:", conversationId);
        try {
            if (!publicKey || !conversationId || !Object.values(FeedbackRating).includes(rating)) {
                return {
                    status: 400,
                    json: { success: false, error: "Invalid request. Please pass publicKey, conversationId and rating (UP|DOWN)" },
                };
            }
            const org = await Org.findOne({ publicKey: asId(publicKey) });
            if (!org) {
                return { status: 404, json: { success: false, error: "Unknown publicKey" } };
            }
            const conversation = await Conversation.findOneAndUpdate(
                { orgId: org.orgId, conversationId },
                { feedback: rating },
                { new: true }
            );
            if (!conversation) {
                return { status: 404, json: { success: false, error: "Conversation not found" } };
            }
            return { status: 200, json: { success: true } };
        } catch (error) {
            console.error("ChatFunctions:feedback: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // POST /api/widget/conversations — hydrate previews for the conversation ids
    // this browser already knows. The client's own id list is the auth boundary:
    // ids are unguessable, and we only ever describe ids the caller presented.
    async listWidgetConversations({ publicKey, conversationIds }) {
        console.log("ChatFunctions:listWidgetConversations");
        try {
            if (!publicKey || !Array.isArray(conversationIds)) {
                return {
                    status: 400,
                    json: { success: false, error: "Invalid request. Please pass publicKey and conversationIds" },
                };
            }
            const org = await Org.findOne({ publicKey: asId(publicKey) });
            if (!org) {
                return { status: 404, json: { success: false, error: "Unknown publicKey" } };
            }
            const ids = conversationIds.filter((id) => typeof id === "string").slice(0, 20);
            const conversations = await Conversation.find({ orgId: org.orgId, conversationId: { $in: ids } })
                .select("conversationId status lastMessagePreview lastMessageAt hasHumanReply turnCount")
                .sort({ lastMessageAt: -1 })
                .lean();
            const data = conversations.map((c) => ({
                conversationId: c.conversationId,
                status: c.status,
                preview: c.lastMessagePreview || "",
                lastMessageAt: c.lastMessageAt,
                hasHumanReply: !!c.hasHumanReply,
                turnCount: c.turnCount || 0,
            }));
            return { status: 200, json: { success: true, data } };
        } catch (error) {
            console.error("ChatFunctions:listWidgetConversations: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // POST /api/widget/help — the widget's help center. One endpoint, three
    // shapes: no args → collections; query → search hits; chunkId → article.
    // Only READY sources are ever exposed.
    async help({ publicKey, query, chunkId, sourceId, suggest }) {
        console.log("ChatFunctions:help: query:", query, "chunkId:", chunkId, "sourceId:", sourceId, "suggest:", !!suggest);
        try {
            if (!publicKey) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass publicKey" } };
            }
            const org = await Org.findOne({ publicKey: asId(publicKey) });
            if (!org) {
                return { status: 404, json: { success: false, error: "Unknown publicKey" } };
            }

            const readySources = await KnowledgeSource.find({ orgId: org.orgId, status: SourceStatus.READY })
                .select("sourceId name chunkCount")
                .lean();
            const readyIds = readySources.map((source) => source.sourceId);
            const nameBySource = new Map(readySources.map((source) => [source.sourceId, source.name]));

            const toHit = (chunk) => ({
                chunkId: chunk.chunkId,
                heading: (chunk.headingPath || []).join(" › ") || "Untitled",
                snippet: (chunk.text || "").slice(0, 150),
                source: nameBySource.get(chunk.sourceId) || "",
            });

            // one article, in full
            if (chunkId) {
                const chunk = await Chunk.findOne({ orgId: org.orgId, chunkId, sourceId: { $in: readyIds } }).lean();
                if (!chunk) {
                    return { status: 404, json: { success: false, error: "Article not found" } };
                }
                return {
                    status: 200,
                    json: {
                        success: true,
                        data: { article: { ...toHit(chunk), text: chunk.text, updatedAt: chunk.updatedAt } },
                    },
                };
            }

            // suggested articles for the home screen — freshest content first
            if (suggest && !query && !chunkId && !sourceId) {
                const chunks = await Chunk.find({ orgId: org.orgId, sourceId: { $in: readyIds } })
                    .select("chunkId headingPath text sourceId")
                    .sort({ updatedAt: -1 })
                    .limit(4)
                    .lean();
                return { status: 200, json: { success: true, data: { hits: chunks.map(toHit) } } };
            }

            // search across headings and body text
            if (query && String(query).trim()) {
                const escaped = String(query).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                const regex = new RegExp(escaped, "i");
                const hits = await Chunk.find({
                    orgId: org.orgId,
                    sourceId: { $in: readyIds },
                    $or: [{ headingPath: regex }, { text: regex }],
                })
                    .select("chunkId headingPath text sourceId")
                    .limit(8)
                    .lean();
                return { status: 200, json: { success: true, data: { hits: hits.map(toHit) } } };
            }

            // articles of one collection
            if (sourceId) {
                const chunks = await Chunk.find({ orgId: org.orgId, sourceId, ...(readyIds.includes(sourceId) ? {} : { _id: null }) })
                    .select("chunkId headingPath text sourceId")
                    .sort({ position: 1 })
                    .limit(50)
                    .lean();
                return { status: 200, json: { success: true, data: { hits: chunks.map(toHit) } } };
            }

            // default: collections overview — counts plus a description built
            // from the collection's real section names
            const counts = await Chunk.aggregate([
                { $match: { orgId: org.orgId, sourceId: { $in: readyIds } } },
                { $sort: { position: 1 } },
                {
                    $group: {
                        _id: "$sourceId",
                        count: { $sum: 1 },
                        heads: { $push: { $arrayElemAt: ["$headingPath", -1] } },
                    },
                },
                { $project: { count: 1, heads: { $slice: ["$heads", 3] } } },
            ]);
            const bySource = new Map(counts.map((row) => [row._id, row]));
            const collections = readySources
                .map((source) => {
                    const row = bySource.get(source.sourceId);
                    return {
                        sourceId: source.sourceId,
                        name: source.name,
                        articleCount: row ? row.count : 0,
                        description: row ? row.heads.filter(Boolean).join(" · ") : "",
                    };
                })
                .filter((collection) => collection.articleCount > 0);
            return { status: 200, json: { success: true, data: { collections } } };
        } catch (error) {
            console.error("ChatFunctions:help: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // Dashboard inbox reads

    async listConversations({ orgId, status, search, page, limit }) {
        console.log("ChatFunctions:listConversations: orgId:", orgId, "status:", status);
        try {
            if (!orgId) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId" } };
            }
            const pageNum = Math.max(parseInt(page, 10) || 1, 1);
            const pageSize = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
            const filter = { orgId, ...(status && Object.values(ConversationStatus).includes(status) && { status }) };

            // Search spans the message preview and the person — an inbox where you
            // can only search one of those is not an inbox you can work.
            if (search && String(search).trim()) {
                const escaped = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                const matchedUsers = await EndUser.find({
                    orgId,
                    $or: [{ email: { $regex: escaped, $options: "i" } }, { name: { $regex: escaped, $options: "i" } }],
                })
                    .select("endUserId")
                    .lean();
                filter.$or = [
                    { lastMessagePreview: { $regex: escaped, $options: "i" } },
                    { conversationId: { $regex: escaped, $options: "i" } },
                    ...(matchedUsers.length > 0
                        ? [{ endUserId: { $in: matchedUsers.map((user) => user.endUserId) } }]
                        : []),
                ];
            }

            // Tab counts must ignore the status filter — otherwise every tab shows
            // its own total and the others read as zero — but still honour search.
            const countFilter = { ...filter };
            delete countFilter.status;

            const [conversations, total, statusAgg] = await Promise.all([
                Conversation.find(filter)
                    .sort({ lastMessageAt: -1 })
                    .skip((pageNum - 1) * pageSize)
                    .limit(pageSize),
                Conversation.countDocuments(filter),
                Conversation.aggregate([
                    { $match: countFilter },
                    { $group: { _id: "$status", count: { $sum: 1 } } },
                ]),
            ]);

            // Attach the end user so the inbox can render names without N+1 calls
            const endUserIds = [...new Set(conversations.map((c) => c.endUserId).filter(Boolean))];
            const endUsers = await EndUser.find({ orgId, endUserId: { $in: endUserIds } }).lean();
            const usersById = new Map(endUsers.map((u) => [u.endUserId, u]));
            const data = conversations.map((c) => {
                const json = c.toJSON();
                const user = c.endUserId ? usersById.get(c.endUserId) : null;
                json.user = user
                    ? { name: user.name || user.email, email: user.email, verified: user.verified }
                    : { name: "Anonymous", email: null, verified: false };
                return json;
            });

            const statusCounts = { ALL: 0 };
            for (const value of Object.values(ConversationStatus)) {
                statusCounts[value] = 0;
            }
            for (const row of statusAgg) {
                statusCounts[row._id] = row.count;
                statusCounts.ALL += row.count;
            }

            return { status: 200, json: { success: true, data, total, statusCounts, page: pageNum, limit: pageSize } };
        } catch (error) {
            console.error("ChatFunctions:listConversations: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async getConversation({ orgId, conversationId }) {
        console.log("ChatFunctions:getConversation: orgId:", orgId, "conversationId:", conversationId);
        try {
            if (!orgId || !conversationId) {
                return { status: 400, json: { success: false, error: "Invalid request. Please pass orgId and conversationId" } };
            }
            const conversation = await Conversation.findOne({ orgId, conversationId });
            if (!conversation) {
                return { status: 404, json: { success: false, error: "Conversation not found" } };
            }
            const [messages, traces, endUser] = await Promise.all([
                Message.find({ orgId, conversationId }).sort({ createdAt: 1 }),
                TurnTrace.find({ orgId, conversationId }).sort({ turn: 1 }),
                conversation.endUserId ? EndUser.findOne({ orgId, endUserId: conversation.endUserId }) : Promise.resolve(null),
            ]);

            // Attach chunk headings so the trace panel can show sections, not ids
            const chunkIds = [...new Set(traces.flatMap((t) => t.topChunks.map((c) => c.chunkId)).filter(Boolean))];
            const chunks = await Chunk.find({ orgId, chunkId: { $in: chunkIds } }).select("chunkId headingPath").lean();
            const headingById = new Map(chunks.map((c) => [c.chunkId, (c.headingPath || []).join(" › ")]));
            const traceData = traces.map((t) => {
                const json = t.toJSON();
                json.topChunks = json.topChunks.map((c) => ({ ...c, heading: headingById.get(c.chunkId) || c.chunkId }));
                return json;
            });

            return { status: 200, json: { success: true, data: { conversation, messages, traces: traceData, endUser } } };
        } catch (error) {
            console.error("ChatFunctions:getConversation: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // POST .../conversations/:conversationId/reply — a human teammate replies.
    async replyAsHuman({ orgId, conversationId, content }) {
        console.log("ChatFunctions:replyAsHuman: orgId:", orgId, "conversationId:", conversationId);
        try {
            if (!orgId || !conversationId || !content) {
                return {
                    status: 400,
                    json: { success: false, error: "Invalid request. Please pass orgId, conversationId and content" },
                };
            }
            const conversation = await Conversation.findOne({ orgId, conversationId });
            if (!conversation) {
                return { status: 404, json: { success: false, error: "Conversation not found" } };
            }

            const message = await Message.create({
                orgId,
                messageId: generalFunctions.generateId(IdPrefix.MESSAGE),
                conversationId,
                role: MessageRole.HUMAN_AGENT,
                content,
            });

            conversation.hasHumanReply = true;
            conversation.lastMessageAt = new Date();
            conversation.lastMessagePreview = String(content).slice(0, 160);
            await conversation.save();

            // The visitor is usually looking at this exact thread right now.
            realtimeHub.publish(orgId, conversationId, { type: "message", message: message.toJSON() });

            return { status: 200, json: { success: true, data: { message } } };
        } catch (error) {
            console.error("ChatFunctions:replyAsHuman: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // PATCH /api/org/:orgId/conversations/:conversationId — close, reopen or
    // escalate from the inbox.
    async updateConversationStatus({ orgId, conversationId, status }) {
        console.log("ChatFunctions:updateConversationStatus: conversationId:", conversationId, "status:", status);
        try {
            if (!orgId || !conversationId || !status) {
                return {
                    status: 400,
                    json: { success: false, error: "Invalid request. Please pass orgId, conversationId and status" },
                };
            }
            if (!Object.values(ConversationStatus).includes(status)) {
                return { status: 400, json: { success: false, error: "Unknown conversation status" } };
            }
            const conversation = await Conversation.findOne({ orgId, conversationId });
            if (!conversation) {
                return { status: 404, json: { success: false, error: "Conversation not found" } };
            }

            conversation.status = status;
            if (status === ConversationStatus.RESOLVED) {
                // A human closing a ticket is not an autonomous resolution, so
                // isResolved stays untouched — otherwise the headline metric
                // would count our own clicks as agent wins.
                conversation.manuallyResolvedAt = new Date();
                conversation.endedAt = conversation.endedAt || new Date();
            } else if (status === ConversationStatus.OPEN) {
                conversation.manuallyResolvedAt = null;
                conversation.endedAt = null;
            }
            await conversation.save();

            return { status: 200, json: { success: true, data: conversation } };
        } catch (error) {
            console.error("ChatFunctions:updateConversationStatus: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // Private Helper Functions

    // An unsigned identity payload is a claim, not a fact. Only a valid HMAC
    // (signed with the org's widgetSecret) sets identityVerified — which is what
    // unlocks table rows and write actions downstream.
    async _resolveIdentity({ org, identity }) {
        if (!identity || !identity.email) {
            return { endUser: null, identityVerified: false };
        }

        let identityVerified = false;
        let usedPreviousSecret = false;
        if (identity.signature) {
            // §8.4 — verified through securityFunctions rather than inline, so
            // the rotation grace window (old secret still accepted for a bounded
            // period) is honoured everywhere identity is checked rather than in
            // whichever call sites remembered.
            const verdict = securityFunctions.verifyIdentitySignature({
                org,
                email: identity.email,
                signature: identity.signature,
            });
            identityVerified = verdict.verified;
            usedPreviousSecret = verdict.usedPrevious;
            if (usedPreviousSecret) {
                console.log("ChatFunctions:_resolveIdentity: verified with the PREVIOUS secret, orgId:", org.orgId);
            }
        }

        const endUser = await EndUser.findOneAndUpdate(
            { orgId: org.orgId, email: identity.email },
            {
                $set: {
                    ...(identity.externalId && { externalId: identity.externalId }),
                    ...(identity.name && { name: identity.name }),
                    verified: identityVerified,
                    lastSeenAt: new Date(),
                },
                $setOnInsert: {
                    endUserId: generalFunctions.generateId(IdPrefix.END_USER),
                    firstSeenAt: new Date(),
                },
            },
            { new: true, upsert: true }
        );

        return { endUser, identityVerified, usedPreviousSecret };
    }

    // §1.6 step 5 — proof the widget actually loaded, and from where.
    //
    // Upserted per (org, origin) rather than appended per page view: a busy
    // customer site would otherwise write a row per load forever, to answer a
    // question that only needs one row per site.
    async _recordPing({ orgId, origin }) {
        const WidgetPing = require("../../models/org/widgetPing");
        await WidgetPing.updateOne(
            { orgId, origin: origin || null },
            { $set: { lastSeenAt: new Date() }, $inc: { hits: 1 }, $setOnInsert: { firstSeenAt: new Date() } },
            { upsert: true }
        );
        return { success: true };
    }
}

module.exports = new ChatFunctions();
