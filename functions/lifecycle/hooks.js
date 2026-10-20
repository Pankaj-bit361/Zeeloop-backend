"use strict";
const config = require("../../config/config");
const { SubscriptionStatus, PlanId } = require("../../config/enums");
const { getPlan, TRIAL_DAYS, GRACE_PERIOD_DAYS } = require("../../config/plans");
const Org = require("../../models/org/org");
const Member = require("../../models/org/member");
const Account = require("../../models/user/account");
const Conversation = require("../../models/conversation/conversation");
const { announce, lifecycleEnabled, num, pct, plural, shortDate, stamp } = require("./client");
const { contactFor, ownerOf, firstNameOf } = require("./owner");

// Inline lifecycle hooks: one call from the code path where something happened
// (a signup, an invite, a payment). Each looks up who to tell, fires the event
// and returns at once — never awaited by the request, never able to fail it.
// Off entirely without VOLANEA_LIFECYCLE_KEY.

const later = (work) => {
    if (!lifecycleEnabled()) return;
    void Promise.resolve()
        .then(work)
        .catch((error) => console.log("Lifecycle: hook failed; the caller is unaffected:", error.message));
};

const limitLabel = (planId) => {
    const limit = getPlan(planId).limits.conversations;
    return limit == null ? "Unlimited conversations" : `${plural(limit, "conversation")} a month`;
};

// The welcome: when a password account verifies its address, or an OAuth
// account is first created (the provider already verified it). Someone who
// signed up to join a teammate's workspace already has their invitation; the
// "create your workspace" series isn't for them.
function onSignedUp(account) {
    later(async () => {
        if (await Member.exists({ email: account.email.toLowerCase() })) return;
        await announce(account.email, "user.signed_up", {}, { firstName: firstNameOf(account.name) });
    });
}

function onWorkspaceCreated({ account, orgId }) {
    later(async () => {
        const owner = await ownerOf(orgId);
        if (!owner) return;
        const trialEnds = owner.subscription && owner.subscription.trialEndsAt;
        await announce(account.email, "workspace.created", {
            workspace: owner.org.name,
            trial_days: String(TRIAL_DAYS),
            trial_ends_on: trialEnds ? shortDate(trialEnds) : "",
        }, contactFor(account, owner.org, owner.subscription, "owner"));
    });
}

// The invitee gets the invitation: until now nothing told them.
function onMemberInvited({ orgId, email, role, inviterEmail }) {
    later(async () => {
        const owner = await ownerOf(orgId);
        if (!owner) return;
        const [inviter, invitee] = await Promise.all([
            inviterEmail ? Account.findOne({ email: inviterEmail.toLowerCase() }).select("name email").lean() : null,
            Account.findOne({ email: email.toLowerCase() }).select("name").lean(),
        ]);
        const inviterName = (inviter && (inviter.name || inviter.email)) || (inviterEmail || "").split("@")[0] || "A teammate";
        // No account yet means no password: send them to sign up with this address.
        const actionUrl = invitee ? `${config.APP_URL}/login` : `${config.APP_URL}/signup?email=${encodeURIComponent(email)}`;
        await announce(email, "member.invited", {
            inviter_name: inviterName,
            workspace: owner.org.name,
            role: String(role || "AGENT").toLowerCase(),
            action_url: actionUrl,
        }, contactFor(invitee, owner.org, owner.subscription, String(role || "AGENT").toLowerCase()));
    });
}

// Told to the owner the first time an invited teammate opens the workspace.
function onMemberJoined({ orgId, email, role }) {
    later(async () => {
        const owner = await ownerOf(orgId);
        if (!owner || owner.email.toLowerCase() === String(email).toLowerCase()) return;
        await announce(owner.email, "member.joined", { member_email: email, role: String(role || "AGENT").toLowerCase(), workspace: owner.org.name }, owner.contact);
    });
}

function onMemberRemoved({ orgId, email }) {
    later(async () => {
        const org = await Org.findOne({ orgId }).select("name").lean();
        if (!org) return;
        const account = await Account.findOne({ email: email.toLowerCase() }).select("name").lean();
        await announce(email, "member.removed", { workspace: org.name }, { firstName: firstNameOf(account && account.name) });
    });
}

function onPasswordChanged(account) {
    later(() => announce(account.email, "security.password_changed", { changed_at: stamp(new Date()) }, { firstName: firstNameOf(account.name) }));
}

function onWidgetSecretRotated({ orgId, actorEmail, graceUntil }) {
    later(async () => {
        const owner = await ownerOf(orgId);
        if (!owner) return;
        await announce(owner.email, "security.widget_secret_rotated", {
            workspace: owner.org.name,
            changed_at: stamp(new Date()),
            actor_email: actorEmail || "someone on your team",
            grace_until: graceUntil ? stamp(graceUntil) : "a short grace period",
        }, owner.contact);
    });
}

// Told to the owner: an agent acting in their workspace is their business,
// whoever connected it.
function onAgentConnected({ orgId, clientName }) {
    later(async () => {
        const owner = await ownerOf(orgId);
        if (owner) await announce(owner.email, "security.agent_connected", { client: clientName || "An MCP client", workspace: owner.org.name }, owner.contact);
    });
}

function onSuspensionChanged({ orgId, suspended, reason }) {
    later(async () => {
        const owner = await ownerOf(orgId);
        if (!owner) return;
        if (suspended) await announce(owner.email, "workspace.suspended", { workspace: owner.org.name, reason: reason || "a review of the account" }, owner.contact);
        else await announce(owner.email, "workspace.reinstated", { workspace: owner.org.name }, owner.contact);
    });
}

/* ── billing ──────────────────────────────────────────────────────── */

const paid = (planId) => planId && planId !== PlanId.FREE;
const priceOf = (planId) => getPlan(planId).priceUsd || 0;

// Reads what a billing webhook changed — the subscription before and after —
// and announces the transitions a customer should hear about. One webhook can
// carry several (a plan change and a recovered payment), so each is checked.
function billingEvents(before, after) {
    const events = [];
    const wasPaying = paid(before.plan) && [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE].includes(before.status);
    const isPaying = paid(after.plan) && [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE].includes(after.status);
    const planName = getPlan(after.plan).name;

    if (isPaying && !wasPaying) {
        events.push(["billing.subscription_started", { plan_name: planName, limit_label: limitLabel(after.plan), renews_on: after.currentPeriodEnd ? shortDate(after.currentPeriodEnd) : "" }]);
    } else if (isPaying && wasPaying && before.plan !== after.plan) {
        const up = priceOf(after.plan) > priceOf(before.plan);
        events.push([up ? "billing.plan_upgraded" : "billing.plan_downgraded", { from_plan: getPlan(before.plan).name, plan_name: planName, limit_label: limitLabel(after.plan) }]);
    }
    if (after.status === SubscriptionStatus.PAST_DUE && before.status !== SubscriptionStatus.PAST_DUE) {
        const ends = after.gracePeriodEndsAt || new Date(Date.now() + GRACE_PERIOD_DAYS * 86_400_000);
        events.push(["billing.payment_failed", { plan_name: planName, grace_days: String(GRACE_PERIOD_DAYS), grace_ends_on: shortDate(ends) }]);
    }
    if (before.status === SubscriptionStatus.PAST_DUE && after.status === SubscriptionStatus.ACTIVE) {
        events.push(["billing.recovered", { plan_name: planName }]);
    }
    if (after.cancelAtPeriodEnd && !before.cancelAtPeriodEnd && isPaying) {
        events.push(["billing.cancel_scheduled", { plan_name: planName, ends_on: after.currentPeriodEnd ? shortDate(after.currentPeriodEnd) : "the end of the period" }]);
    }
    if (wasPaying && [SubscriptionStatus.CANCELLED, SubscriptionStatus.EXPIRED].includes(after.status)) {
        events.push(["billing.subscription_ended", { plan_name: getPlan(before.plan).name }]);
    }
    return events;
}

function onBillingChange({ orgId, before, after }) {
    later(async () => {
        const events = billingEvents(before, after);
        if (!events.length) return;
        const owner = await ownerOf(orgId, { subscription: after });
        if (!owner) return;
        for (const [event, data] of events) await announce(owner.email, event, data, owner.contact);
    });
}

// The trial ran out and the workspace moved to Free; say what the trial achieved.
function onTrialEnded({ orgId, since }) {
    later(async () => {
        const owner = await ownerOf(orgId);
        if (!owner) return;
        const window = { orgId, conversationId: { $not: /^conv_eval_/ }, ...(since ? { createdAt: { $gte: since } } : {}) };
        const [conversations, resolved] = await Promise.all([Conversation.countDocuments(window), Conversation.countDocuments({ ...window, isResolved: true })]);
        await announce(owner.email, "trial.ended", { conversations: num(conversations), resolved_pct: conversations ? pct(resolved / conversations) : "—" }, owner.contact);
    });
}

// A past-due subscription dropped to Free by the dunning sweep.
function onSubscriptionLapsed({ orgId, previousPlan }) {
    later(async () => {
        const owner = await ownerOf(orgId);
        if (owner) await announce(owner.email, "billing.subscription_ended", { plan_name: getPlan(previousPlan).name }, owner.contact);
    });
}

/* ── usage thresholds, stamped once per billing period ───────────────── */

function onUsageThreshold({ orgId, record, plan, crossed }) {
    later(async () => {
        const owner = await ownerOf(orgId);
        if (!owner) return;
        const limit = plan.limits.conversations;
        const resetsOn = shortDate(record.periodEnd);
        if (crossed.includes("soft") && limit) {
            await announce(owner.email, "usage.quota_near", {
                used_label: plural(record.conversations, "conversation"),
                limit_label: plural(limit, "conversation"),
                percent: `${Math.min(100, Math.round((record.conversations / limit) * 100))}%`,
                resets_on: resetsOn,
            }, owner.contact);
        }
        if (crossed.includes("hard") && limit) {
            await announce(owner.email, "usage.quota_reached", { limit_label: plural(limit, "conversation"), resets_on: resetsOn }, owner.contact);
        }
        if (crossed.includes("cost")) {
            await announce(owner.email, "usage.cost_ceiling", { resets_on: resetsOn }, owner.contact);
        }
    });
}

module.exports = {
    onSignedUp,
    onWorkspaceCreated,
    onMemberInvited,
    onMemberJoined,
    onMemberRemoved,
    onPasswordChanged,
    onWidgetSecretRotated,
    onAgentConnected,
    onSuspensionChanged,
    onBillingChange,
    onSubscriptionLapsed,
    onTrialEnded,
    onUsageThreshold,
    billingEvents,
};
