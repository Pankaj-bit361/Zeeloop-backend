const crypto = require("crypto");
const config = require("../../config/config");
const {
    ConversationChannel,
    ConversationStatus,
    MessageRole,
    IdPrefix,
    TurnOutcome,
    EmailKind,
    FeatureKey,
    QuotaState,
} = require("../../config/enums");
const Org = require("../../models/org/org");
const Conversation = require("../../models/conversation/conversation");
const Message = require("../../models/conversation/message");
const EndUser = require("../../models/user/endUser");
const generalFunctions = require("../utilFunctions/generalFunctions");
const agentFunctions = require("../agent/agentFunctions");
const emailFunctions = require("./emailFunctions");
const usageFunctions = require("../billing/usageFunctions");
const { planHasFeature } = require("../../config/plans");

// §4.8 — the email channel. Same pipeline, same guidance, same everything: the
// `channels` field that has been on config objects since Phase 2 finally does
// something.
//
// ── Threading ────────────────────────────────────────────────────────
//
// By Message-ID chain, in this order:
//
//   1. `In-Reply-To` / `References` matching a Message-ID we have seen
//   2. the `[ref:conv_...]` token our own signature plants in every outbound
//   3. subject + sender, as a last resort
//
// The token exists because header threading breaks constantly in the real
// world: Outlook rewrites headers, forwards drop them, and some clients start a
// fresh chain on reply. Subject matching alone is worse than useless — every
// "Re: Your order" from a different customer would land in one thread.
//
// ── Identity ─────────────────────────────────────────────────────────
//
// An email sender is NEVER identity-verified. Anyone can put any address in a
// From header. Email conversations therefore reach tables and write actions
// exactly as far as an anonymous chat visitor does, which is not at all.

const MAX_BODY_CHARS = 20000;

class InboundEmailFunctions {
    // ── Public Functions ─────────────────────────────────────────────

    // The provider's parse webhook posts here. Authenticated by a shared secret
    // rather than a signature, because inbound parse providers differ on signing
    // and an unauthenticated endpoint here means anyone can inject messages into
    // any workspace's inbox.
    async receive({ secret, to, from, subject, text, messageId, inReplyTo, references }) {
        console.log("InboundEmailFunctions:receive: to:", to, "messageId:", messageId);
        try {
            if (!config.EMAIL_INBOUND_SECRET) {
                console.log("InboundEmailFunctions:receive: refused, EMAIL_INBOUND_SECRET is not set");
                return { status: 503, json: { success: false, error: "Inbound email is not configured" } };
            }
            if (!this._secretMatches(secret)) {
                return { status: 401, json: { success: false, error: "Invalid inbound secret" } };
            }
            if (!to || !from) {
                return { status: 400, json: { success: false, error: "to and from are required" } };
            }

            const org = await this._resolveOrg({ to });
            if (!org) {
                // 200, not 404. A provider that receives a 4xx retries, and
                // retrying a message addressed to a workspace that does not
                // exist will never succeed.
                console.log("InboundEmailFunctions:receive: no workspace for address:", to);
                return { status: 200, json: { success: true, data: { ignored: true, reason: "UNKNOWN_ADDRESS" } } };
            }

            if (!planHasFeature((org.credits && org.credits.plan) || "FREE", FeatureKey.EMAIL_CHANNEL)) {
                console.log("InboundEmailFunctions:receive: plan does not include the email channel");
                return { status: 200, json: { success: true, data: { ignored: true, reason: "PLAN_FEATURE" } } };
            }

            const senderEmail = this._extractAddress(from);
            const body = this._stripQuotedReply(String(text || "")).slice(0, MAX_BODY_CHARS);
            if (!body.trim()) {
                return { status: 200, json: { success: true, data: { ignored: true, reason: "EMPTY_BODY" } } };
            }

            const { conversation, isNew } = await this._resolveThread({
                org,
                senderEmail,
                subject,
                inReplyTo,
                references,
                body,
            });

            // Idempotency. Providers retry, and a retried parse must not run the
            // pipeline twice and send two replies.
            if (messageId && (conversation.emailThread.messageIds || []).includes(messageId)) {
                console.log("InboundEmailFunctions:receive: duplicate messageId, ignoring:", messageId);
                return { status: 200, json: { success: true, data: { duplicate: true, conversationId: conversation.conversationId } } };
            }

            const endUser = await this._resolveEndUser({ org, senderEmail });

            await Message.create({
                orgId: org.orgId,
                messageId: generalFunctions.generateId(IdPrefix.MESSAGE),
                conversationId: conversation.conversationId,
                role: MessageRole.USER,
                content: body,
            });

            const quota = await usageFunctions.checkQuota({ orgId: org.orgId });
            if (quota.state === QuotaState.EXCEEDED) {
                console.log("InboundEmailFunctions:receive: quota exceeded, storing without answering");
                await this._recordMessageId({ conversation, messageId });
                return { status: 200, json: { success: true, data: { conversationId: conversation.conversationId, degraded: true } } };
            }

            const history = await Message.find({ orgId: org.orgId, conversationId: conversation.conversationId })
                .sort({ createdAt: 1 })
                .limit(30)
                .lean();

            const turn = await agentFunctions.runTurn({
                org,
                conversation,
                endUser,
                // Never. An email From header is not proof of anything.
                identityVerified: false,
                rawMessage: body,
                history: history.slice(0, -1),
                channel: ConversationChannel.EMAIL,
            });

            await Message.create({
                orgId: org.orgId,
                messageId: generalFunctions.generateId(IdPrefix.MESSAGE),
                conversationId: conversation.conversationId,
                role: MessageRole.ASSISTANT,
                content: turn.reply,
                citations: turn.citations || [],
            });

            conversation.turnCount += 1;
            conversation.totalCostUsd += turn.costUsd || 0;
            conversation.lastMessageAt = new Date();
            conversation.lastMessagePreview = body.slice(0, 140);
            if (turn.escalate || turn.outcome === TurnOutcome.ESCALATED) {
                conversation.status = ConversationStatus.ESCALATED;
            }
            if (endUser && !conversation.endUserId) conversation.endUserId = endUser.endUserId;
            await this._recordMessageId({ conversation, messageId });

            await usageFunctions.recordTurn({
                orgId: org.orgId,
                costUsd: turn.costUsd || 0,
                inputTokens: turn.inputTokens || 0,
                outputTokens: turn.outputTokens || 0,
                isNewConversation: isNew,
            });

            // Escalated threads do not get an auto-reply. Sending "a human will
            // be in touch" and then having a human be in touch is two emails
            // where one would do, and the first one reads as a brush-off.
            if (!turn.escalate && turn.outcome !== TurnOutcome.ESCALATED) {
                await this._sendReply({ org, conversation, reply: turn.reply, senderEmail, subject });
            }

            return {
                status: 200,
                json: {
                    success: true,
                    data: { conversationId: conversation.conversationId, outcome: turn.outcome, replied: !turn.escalate },
                },
            };
        } catch (error) {
            console.error("InboundEmailFunctions:receive: Catch block");
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    // The address a workspace publishes. One verified sending domain, one
    // address per workspace — rather than asking every customer to verify a
    // domain, which is where email-channel onboarding usually dies.
    inboundAddress({ org }) {
        const token = this._inboundToken({ orgId: org.orgId });
        return `support+${token}@${config.EMAIL_INBOUND_DOMAIN}`;
    }

    // ── Private Helper Functions ─────────────────────────────────────

    // Derived from the orgId and the app secret rather than stored, so it needs
    // no column and cannot drift. HMAC rather than a plain hash: a guessable
    // token would let anyone address any workspace.
    _inboundToken({ orgId }) {
        return crypto.createHmac("sha256", config.SESSION_SECRET).update(`inbound:${orgId}`).digest("hex").slice(0, 16);
    }

    async _resolveOrg({ to }) {
        const address = this._extractAddress(to);
        const local = address.split("@")[0];
        const plus = local.indexOf("+");
        if (plus === -1) return null;
        const token = local.slice(plus + 1);

        // Scanned rather than looked up, because the token is derived and not
        // indexed. Workspaces number in the thousands, not the millions, and the
        // alternative is storing a token that can fall out of sync with the key
        // that generates it.
        const orgs = await Org.find({}).select("orgId name credits ownerEmail agent widget escalation businessContext").lean();
        return orgs.find((org) => this._inboundToken({ orgId: org.orgId }) === token) || null;
    }

    async _resolveThread({ org, senderEmail, subject, inReplyTo, references, body }) {
        const headerIds = [inReplyTo, ...(String(references || "").split(/\s+/) || [])].filter(Boolean);

        if (headerIds.length > 0) {
            const byHeader = await Conversation.findOne({
                orgId: org.orgId,
                channel: ConversationChannel.EMAIL,
                "emailThread.messageIds": { $in: headerIds },
            });
            if (byHeader) return { conversation: byHeader, isNew: false };
        }

        // Our own token, planted in every outbound signature. Survives the
        // header rewriting that breaks the branch above.
        const tokenMatch = String(body || "").match(/\[ref:(conv_[a-z0-9]+)\]/i);
        if (tokenMatch) {
            const byToken = await Conversation.findOne({ orgId: org.orgId, conversationId: tokenMatch[1] });
            if (byToken) return { conversation: byToken, isNew: false };
        }

        // Last resort: same sender, same subject, still open, recent. Bounded by
        // all four, because subject alone would merge every "Re: your order"
        // in the workspace into one thread.
        if (subject) {
            const normalised = this._normaliseSubject(subject);
            const bySubject = await Conversation.findOne({
                orgId: org.orgId,
                channel: ConversationChannel.EMAIL,
                status: ConversationStatus.OPEN,
                "emailThread.fromEmail": senderEmail,
                "emailThread.subject": normalised,
                lastMessageAt: { $gte: new Date(Date.now() - 7 * 86_400_000) },
            });
            if (bySubject) return { conversation: bySubject, isNew: false };
        }

        const conversation = await Conversation.create({
            orgId: org.orgId,
            conversationId: generalFunctions.generateId(IdPrefix.CONVERSATION),
            channel: ConversationChannel.EMAIL,
            status: ConversationStatus.OPEN,
            emailThread: {
                subject: this._normaliseSubject(subject || "(no subject)"),
                fromEmail: senderEmail,
                messageIds: [],
            },
        });
        return { conversation, isNew: true };
    }

    async _resolveEndUser({ org, senderEmail }) {
        if (!senderEmail) return null;
        return EndUser.findOneAndUpdate(
            { orgId: org.orgId, email: senderEmail },
            {
                $set: { lastSeenAt: new Date() },
                $setOnInsert: {
                    endUserId: generalFunctions.generateId(IdPrefix.END_USER),
                    // Explicitly false. See the header note on identity.
                    verified: false,
                    firstSeenAt: new Date(),
                },
            },
            { upsert: true, new: true }
        );
    }

    async _sendReply({ org, conversation, reply, senderEmail, subject }) {
        return emailFunctions.send({
            orgId: org.orgId,
            kind: EmailKind.AGENT_REPLY,
            to: senderEmail,
            // Per turn, not per conversation: every reply in a thread is a
            // different email and must not be deduped against the last one.
            dedupeKey: `${org.orgId}:REPLY:${conversation.conversationId}:${conversation.turnCount}`,
            subjectOverride: this._replySubject(subject),
            data: {
                agentName: (org.agent && org.agent.name) || "Support",
                orgName: org.name,
                reply,
                conversationId: conversation.conversationId,
                replyTo: this.inboundAddress({ org }),
            },
        });
    }

    async _recordMessageId({ conversation, messageId }) {
        if (messageId) {
            conversation.emailThread.messageIds = [
                ...(conversation.emailThread.messageIds || []),
                messageId,
            ].slice(-50);
        }
        await conversation.save();
    }

    // Timing-safe, because a plain === on a secret leaks its prefix through
    // response time to anyone patient enough to measure.
    _secretMatches(provided) {
        if (!provided) return false;
        const expected = Buffer.from(config.EMAIL_INBOUND_SECRET);
        const actual = Buffer.from(String(provided));
        if (expected.length !== actual.length) return false;
        return crypto.timingSafeEqual(expected, actual);
    }

    // "Maya Chen <maya@brightloop.io>" → "maya@brightloop.io"
    _extractAddress(value) {
        const match = String(value || "").match(/<([^>]+)>/);
        return (match ? match[1] : String(value || "")).trim().toLowerCase();
    }

    _normaliseSubject(subject) {
        return String(subject || "")
            .replace(/^(\s*(re|fwd|fw)\s*:\s*)+/i, "")
            .trim();
    }

    _replySubject(subject) {
        const clean = this._normaliseSubject(subject);
        return clean ? `Re: ${clean}` : "Re: your message";
    }

    // Quoted history off the bottom. Without this every reply in a long thread
    // re-sends the entire conversation to the model, which costs tokens and
    // actively confuses the rewrite stage — the customer's real question is the
    // three words at the top.
    _stripQuotedReply(text) {
        const markers = [
            /^\s*On .+ wrote:\s*$/m,
            /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/im,
            /^\s*_{10,}\s*$/m,
            /^\s*From:\s.+$/m,
            // Our own signature. Cutting here also removes the [ref:] token,
            // which is why threading reads the token from the RAW body before
            // this runs.
            /^\s*—\s*$/m,
        ];

        let cut = text.length;
        for (const marker of markers) {
            const match = text.match(marker);
            if (match && match.index !== undefined && match.index < cut) cut = match.index;
        }

        const trimmed = text.slice(0, cut);
        // A reply that is nothing but quoted text means the cut was wrong —
        // better to send the model too much than nothing at all.
        return trimmed.trim() ? trimmed : text;
    }
}

module.exports = new InboundEmailFunctions();
module.exports.MAX_BODY_CHARS = MAX_BODY_CHARS;
