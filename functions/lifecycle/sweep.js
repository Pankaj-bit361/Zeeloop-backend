"use strict";
const config = require("../../config/config");
const { SourceStatus, ConversationStatus, ConversationChannel, MessageRole, ExecutionStatus, MemberStatus, PublishState } = require("../../config/enums");
const { getPlan } = require("../../config/plans");
const Org = require("../../models/org/org");
const Member = require("../../models/org/member");
const WidgetPing = require("../../models/org/widgetPing");
const Subscription = require("../../models/billing/subscription");
const UsageRecord = require("../../models/billing/usageRecord");
const KnowledgeSource = require("../../models/knowledge/knowledgeSource");
const Conversation = require("../../models/conversation/conversation");
const Message = require("../../models/conversation/message");
const Action = require("../../models/action/action");
const ActionExecution = require("../../models/action/actionExecution");
const Table = require("../../models/table/table");
const Procedure = require("../../models/procedure/procedure");
const { announce, isReservedAddress, lifecycleEnabled } = require("./client");
const { ownerOf, tierOf } = require("./owner");
const { dueEvents, monthKey } = require("./rules");

// The hourly lifecycle sweep: for every workspace, read its state, ask
// rules.js what's due, announce it to Volanea and remember what was told.
//
// Guard rails:
//   - A key is flagged on the workspace only after Volanea accepted the event,
//     so a refused send is retried next hour and nobody is told twice.
//   - Five refusals in a row stop the run instead of burning through every
//     workspace while Volanea is down.
//   - Suspended workspaces are skipped. Evaluation runs create conversations
//     too (their ids carry "_eval_"); they are never counted.
//   - Week and month figures are only computed on the days they're sent.

const DAY = 86_400_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const REAL = { conversationId: { $not: /^conv_eval_/ } };
const ESCALATED = { $or: [{ status: ConversationStatus.ESCALATED }, { hasHumanReply: true }] };

async function windowStats(orgId, from, to) {
    const match = { orgId, ...REAL, createdAt: { $gte: from, $lt: to } };
    const [conversations, resolved, escalated] = await Promise.all([
        Conversation.countDocuments(match),
        Conversation.countDocuments({ ...match, isResolved: true }),
        Conversation.countDocuments({ ...match, ...ESCALATED }),
    ]);
    return { conversations, resolved, escalated };
}

async function snapshotOf(org, subscription, now) {
    const orgId = org.orgId;
    const isMonday = now.getUTCDay() === 1 && now.getUTCHours() >= 9;
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const prevMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));

    const [readySource, failedSources, ping, firstConversation, conversationsTotal, firstEscalation, liveAction, firstTable, liveProcedure, firstEmail, usage, lastActive, failures] = await Promise.all([
        KnowledgeSource.findOne({ orgId, status: SourceStatus.READY, chunkCount: { $gt: 0 } }).sort({ createdAt: 1 }).select("name chunkCount").lean(),
        KnowledgeSource.find({ orgId, status: SourceStatus.FAILED }).select("sourceId name lastError").lean(),
        WidgetPing.findOne({ orgId }).sort({ lastSeenAt: -1 }).select("origin lastSeenAt").lean(),
        Conversation.findOne({ orgId, ...REAL }).sort({ createdAt: 1 }).select("conversationId createdAt").lean(),
        Conversation.countDocuments({ orgId, ...REAL }, { limit: 100_001 }),
        Conversation.findOne({ orgId, ...REAL, ...ESCALATED }).sort({ createdAt: 1 }).select("conversationId").lean(),
        Action.findOne({ orgId, enabled: true, publishState: PublishState.LIVE }).sort({ createdAt: 1 }).select("name").lean(),
        Table.findOne({ orgId }).sort({ createdAt: 1 }).select("name rowCount").lean(),
        Procedure.findOne({ orgId, enabled: true }).sort({ createdAt: 1 }).select("name").lean(),
        Conversation.findOne({ orgId, ...REAL, channel: ConversationChannel.EMAIL }).sort({ createdAt: 1 }).select("emailThread").lean(),
        UsageRecord.findOne({ orgId, periodStart: { $lte: now }, periodEnd: { $gt: now } }).sort({ periodStart: -1 }).select("plan conversations conversationsLimit").lean(),
        Member.findOne({ orgId, status: MemberStatus.ACTIVE, lastActiveAt: { $ne: null } }).sort({ lastActiveAt: -1 }).select("lastActiveAt").lean(),
        ActionExecution.aggregate([
            { $match: { orgId, createdAt: { $gte: new Date(now - DAY) }, status: { $in: [ExecutionStatus.EXECUTED, ExecutionStatus.FAILED] } } },
            { $sort: { createdAt: -1 } },
            { $group: { _id: "$actionId", total: { $sum: 1 }, failed: { $sum: { $cond: [{ $eq: ["$status", ExecutionStatus.FAILED] }, 1, 0] } }, lastStatus: { $first: "$response.status" } } },
            { $match: { failed: { $gte: 5 } } },
        ]),
    ]);

    // The first question is what makes "your first conversation" worth opening.
    const [firstQuestion, escalationQuestion] = await Promise.all([
        firstConversation ? Message.findOne({ orgId, conversationId: firstConversation.conversationId, role: MessageRole.USER }).sort({ createdAt: 1 }).select("content").lean() : null,
        firstEscalation ? Message.findOne({ orgId, conversationId: firstEscalation.conversationId, role: MessageRole.USER }).sort({ createdAt: -1 }).select("content").lean() : null,
    ]);

    // Actions that fail at least half the time, five or more times in a day.
    const failingIds = failures.filter((f) => f.failed / f.total >= 0.5);
    const failingNames = failingIds.length ? await Action.find({ orgId, actionId: { $in: failingIds.map((f) => f._id) } }).select("actionId name").lean() : [];

    const installed = Boolean(ping || firstConversation);
    const lastSeenAt = ping ? ping.lastSeenAt : null;
    const planId = (usage && usage.plan) || (subscription && subscription.plan);
    const limit = usage && typeof usage.conversationsLimit === "number" ? usage.conversationsLimit : getPlan(planId).limits.conversations;

    return {
        orgId,
        workspace: org.name,
        createdAt: org.createdAt,
        tier: tierOf(subscription),
        trialEndsAt: subscription ? subscription.trialEndsAt : null,
        firstReadySource: readySource ? { name: readySource.name, chunks: readySource.chunkCount } : null,
        failedSources: failedSources.map((s) => ({ sourceId: s.sourceId, name: s.name, error: s.lastError })),
        widget: { installed, origin: ping ? ping.origin : null, lastSeenAt },
        firstConversation: firstConversation ? { preview: firstQuestion ? firstQuestion.content : "" } : null,
        conversationsTotal,
        firstEscalation: firstEscalation ? { preview: escalationQuestion ? escalationQuestion.content : "", url: `${config.APP_URL}/app/inbox/${firstEscalation.conversationId}` } : null,
        liveAction: liveAction ? { name: liveAction.name } : null,
        firstTable: firstTable ? { name: firstTable.name, rows: firstTable.rowCount || 0 } : null,
        liveProcedure: liveProcedure ? { name: liveProcedure.name } : null,
        firstEmailConversation: firstEmail ? { from: firstEmail.emailThread && firstEmail.emailThread.fromEmail } : null,
        usage: { conversations: usage ? usage.conversations : 0, limit: limit || null },
        lastActiveAt: lastActive ? lastActive.lastActiveAt : null,
        conversationsSinceActive: lastActive ? await Conversation.countDocuments({ orgId, ...REAL, createdAt: { $gte: lastActive.lastActiveAt } }) : 0,
        failingActions: failingIds.map((f) => ({
            actionId: f._id,
            name: (failingNames.find((a) => a.actionId === f._id) || {}).name || "An action",
            failures: f.failed,
            lastError: f.lastStatus ? `The endpoint answered HTTP ${f.lastStatus}.` : "",
        })),
        week: isMonday ? await windowStats(orgId, new Date(now - 7 * DAY), now) : null,
        previousMonth: now.getUTCDate() <= 3
            ? { key: monthKey(prevMonthStart), label: prevMonthStart.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" }), ...(await windowStats(orgId, prevMonthStart, monthStart)) }
            : null,
    };
}

// One pass over every workspace. Exported for tests and a manual run.
async function runLifecycleSweep({ now = new Date() } = {}) {
    let told = 0;
    let baselined = 0;
    let failures = 0;
    const orgs = await Org.find({ "suspended.at": null }).select("orgId name ownerEmail createdAt lifecycle").lean();
    for (const org of orgs) {
        const subscription = await Subscription.findOne({ orgId: org.orgId }).lean();
        const owner = await ownerOf(org.orgId, { org, subscription });
        // A seed/test workspace is skipped here, not left for announce() to
        // refuse: refusals count toward MAX_CONSECUTIVE_FAILURES, so a handful
        // of them would stop the sweep for every real workspace after them.
        if (!owner || isReservedAddress(owner.email)) continue;
        const state = { flags: {}, ...(org.lifecycle || {}) };
        const snapshot = await snapshotOf(org, subscription, now);
        const { send, silent } = dueEvents(snapshot, state, now);
        const stamp = now.toISOString();
        const flags = { ...state.flags };
        for (const key of silent) flags[key] = stamp;
        let tipAt = state.lastTipAt;
        for (const due of send) {
            const ok = await announce(owner.email, due.event, due.data, owner.contact, { orgId: org.orgId });
            if (!ok) {
                failures += 1;
                if (failures >= MAX_CONSECUTIVE_FAILURES) {
                    console.error(`Lifecycle: ${MAX_CONSECUTIVE_FAILURES} events in a row refused, stopping this sweep`);
                    await save(org.orgId, state, flags, snapshot, stamp, tipAt);
                    return { told, baselined, stopped: true };
                }
                continue;
            }
            failures = 0;
            flags[due.key] = stamp;
            if (due.tip) tipAt = stamp;
            told += 1;
        }
        if (!state.baselinedAt && !send.length && silent.length) baselined += 1;
        await save(org.orgId, state, flags, snapshot, stamp, tipAt);
    }
    return { told, baselined, stopped: false };
}

async function save(orgId, state, flags, snapshot, stamp, tipAt) {
    // A failed source counts as "seen" once its notice was accepted (or it was
    // already failing last time), so a refused notice is retried next hour.
    const seenBefore = state.failedSources || [];
    const failedSources = snapshot.failedSources
        .map((s) => s.sourceId)
        .filter((id) => seenBefore.includes(id) || Object.keys(flags).some((key) => key.startsWith(`knowledge.source_failed:${id}:`)));
    const next = {
        ...state,
        flags,
        baselinedAt: state.baselinedAt || stamp,
        failedSources,
        ...(tipAt ? { lastTipAt: tipAt } : {}),
    };
    await Org.updateOne({ orgId }, { $set: { lifecycle: next } });
}

module.exports = { runLifecycleSweep, snapshotOf, lifecycleEnabled, REAL };
