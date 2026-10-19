const { PlanId, SubscriptionStatus, BillingProvider } = require("../../config/enums");
const { getPlan } = require("../../config/plans");
const Org = require("../../models/org/org");
const Member = require("../../models/org/member");
const Account = require("../../models/user/account");
const Subscription = require("../../models/billing/subscription");
const UsageRecord = require("../../models/billing/usageRecord");
const KnowledgeSource = require("../../models/knowledge/knowledgeSource");
const Conversation = require("../../models/conversation/conversation");
const WidgetPing = require("../../models/org/widgetPing");
const AdminAudit = require("../../models/admin/adminAudit");
const billingFunctions = require("../billing/billingFunctions");
const generalFunctions = require("../utilFunctions/generalFunctions");
const { isSuspended } = require("./suspension");

/* The admin panel (routes/adminRoutes.js, ADMIN_EMAILS only): the business at
   a glance, every workspace with its plan and usage, and the few changes
   support makes to one. Every change needs a reason and writes an AdminAudit
   row with what it was before, so "who gave this workspace Scale, and why"
   always has an answer. */

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 25;
const PAID_PLANS = [PlanId.STARTER, PlanId.GROWTH, PlanId.SCALE];

const since = (days) => new Date(Date.now() - days * DAY_MS);
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fail = (status, error) => Object.assign(new Error(error), { status });

function needReason(reason) {
    const text = String(reason || "").trim();
    if (text.length < 5) throw fail(400, "Say why, in a few words: it goes in the audit log.");
    return text.slice(0, 500);
}

class AdminFunctions {
    // ── Public Functions ─────────────────────────────────────────────

    overview() {
        return this._run("overview", async () => {
            const now = new Date();
            const [workspaces, new7, new30, accounts, accounts7, suspended, allSubscriptions, orgIds, current, conversations30, days] = await Promise.all([
                Org.countDocuments({}),
                Org.countDocuments({ createdAt: { $gte: since(7) } }),
                Org.countDocuments({ createdAt: { $gte: since(30) } }),
                Account.countDocuments({}),
                Account.countDocuments({ createdAt: { $gte: since(7) } }),
                Org.countDocuments({ "suspended.at": { $ne: null } }),
                Subscription.find({}).select("orgId plan status provider trialEndsAt gracePeriodEndsAt currentPeriodEnd").lean(),
                Org.distinct("orgId"),
                UsageRecord.aggregate([
                    { $match: { periodEnd: { $gt: now } } },
                    { $group: { _id: null, conversations: { $sum: "$conversations" }, costUsd: { $sum: "$costUsd" }, overLimit: { $sum: { $cond: [{ $or: [{ $ne: ["$hardLimitReachedAt", null] }, { $ne: ["$costCeilingReachedAt", null] }] }, 1, 0] } } } },
                ]),
                Conversation.countDocuments({ createdAt: { $gte: since(30) } }),
                Org.aggregate([
                    { $match: { createdAt: { $gte: since(14) } } },
                    { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, n: { $sum: 1 } } },
                ]),
            ]);

            // A deleted workspace can leave its subscription row behind; count live ones.
            const live = new Set(orgIds);
            const subscriptions = allSubscriptions.filter((s) => live.has(s.orgId));
            // By what each workspace may actually do right now, not what its row says.
            const plans = Object.fromEntries(Object.values(PlanId).map((plan) => [plan, 0]));
            let paying = 0;
            let trialing = 0;
            let pastDue = 0;
            for (const subscription of subscriptions) {
                const effective = billingFunctions._resolveEffectivePlanId({ subscription }).planId;
                plans[effective] = (plans[effective] || 0) + 1;
                if (subscription.status === SubscriptionStatus.ACTIVE && subscription.provider !== BillingProvider.NONE && PAID_PLANS.includes(subscription.plan)) paying += 1;
                if (subscription.status === SubscriptionStatus.TRIALING && effective !== PlanId.FREE) trialing += 1;
                if (subscription.status === SubscriptionStatus.PAST_DUE) pastDue += 1;
            }
            // Recurring revenue from workspaces that pay a provider, in USD list price.
            const mrrUsd = subscriptions
                .filter((s) => s.status === SubscriptionStatus.ACTIVE && s.provider !== BillingProvider.NONE)
                .reduce((sum, s) => sum + (getPlan(s.plan).priceUsd || 0), 0);

            const signups = Array.from({ length: 14 }, (_, i) => {
                const day = new Date(Date.now() - (13 - i) * DAY_MS).toISOString().slice(0, 10);
                return { day, n: (days.find((d) => d._id === day) || {}).n || 0 };
            });
            const period = current[0] || { conversations: 0, costUsd: 0, overLimit: 0 };

            return {
                status: 200,
                json: {
                    success: true,
                    data: {
                        workspaces, new7, new30, accounts, accounts7, suspended, paying, trialing, pastDue, mrrUsd, plans,
                        conversations30,
                        periodConversations: period.conversations,
                        periodCostUsd: Number(period.costUsd.toFixed(2)),
                        overLimit: period.overLimit,
                        signups,
                    },
                },
            };
        });
    }

    /* Workspaces newest first. `search` matches the name, website, owner,
       workspace id, or the email of anyone with a seat in it. */
    listWorkspaces({ search, plan, status, page }) {
        return this._run("listWorkspaces", async () => {
            const pageNumber = Math.max(1, Number(page) || 1);
            const filter = {};
            const and = [];

            if (search && String(search).trim()) {
                const re = new RegExp(escapeRegex(String(search).trim().slice(0, 100)), "i");
                const seats = await Member.find({ email: re }).select("orgId").limit(500).lean();
                and.push({ $or: [{ name: re }, { website: re }, { ownerEmail: re }, { orgId: re }, { orgId: { $in: seats.map((s) => s.orgId) } }] });
            }
            if (status === "SUSPENDED") {
                and.push({ "suspended.at": { $ne: null } });
            } else if (status && Object.values(SubscriptionStatus).includes(status)) {
                const rows = await Subscription.find({ status }).select("orgId").lean();
                and.push({ orgId: { $in: rows.map((r) => r.orgId) } });
            }
            if (plan && Object.values(PlanId).includes(plan)) {
                and.push({ "credits.plan": plan });
            }
            if (and.length) filter.$and = and;

            const [orgs, total] = await Promise.all([
                Org.find(filter).sort({ createdAt: -1 }).skip((pageNumber - 1) * PAGE_SIZE).limit(PAGE_SIZE)
                    .select("orgId name website ownerEmail createdAt credits suspended").lean(),
                Org.countDocuments(filter),
            ]);
            const ids = orgs.map((o) => o.orgId);
            const now = new Date();
            const [subscriptions, usage, seats] = await Promise.all([
                Subscription.find({ orgId: { $in: ids } }).lean(),
                UsageRecord.find({ orgId: { $in: ids }, periodEnd: { $gt: now } }).sort({ periodStart: -1 }).lean(),
                Member.aggregate([{ $match: { orgId: { $in: ids } } }, { $group: { _id: "$orgId", n: { $sum: 1 } } }]),
            ]);

            return {
                status: 200,
                json: {
                    success: true,
                    data: {
                        page: pageNumber,
                        pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
                        total,
                        workspaces: orgs.map((org) => {
                            const subscription = subscriptions.find((s) => s.orgId === org.orgId) || null;
                            const record = usage.find((u) => u.orgId === org.orgId) || null;
                            const summary = this._planSummary(subscription);
                            return {
                                orgId: org.orgId,
                                name: org.name,
                                website: org.website,
                                ownerEmail: org.ownerEmail,
                                createdAt: org.createdAt,
                                suspended: isSuspended(org),
                                seats: (seats.find((s) => s._id === org.orgId) || {}).n || 0,
                                ...summary,
                                conversations: record ? record.conversations : 0,
                                conversationsLimit: getPlan(record ? record.plan : summary.effectivePlan).limits.conversations,
                                costUsd: record ? Number(record.costUsd.toFixed(2)) : 0,
                            };
                        }),
                    },
                },
            };
        });
    }

    /* One workspace in full: who is in it, what it pays, what it uses, what it
       has built, whether the widget is live, and what staff did to it. */
    getWorkspace({ orgId }) {
        return this._run("getWorkspace", async () => {
            const org = await this._orgOf(orgId);
            const [subscription, usage, members, sources, conversationCounts, conversations30, lastConversation, pings, audits] = await Promise.all([
                Subscription.findOne({ orgId }).lean(),
                UsageRecord.find({ orgId }).sort({ periodStart: -1 }).limit(6).lean(),
                Member.find({ orgId }).sort({ createdAt: 1 }).lean(),
                KnowledgeSource.aggregate([{ $match: { orgId } }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
                Conversation.aggregate([{ $match: { orgId } }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
                Conversation.countDocuments({ orgId, createdAt: { $gte: since(30) } }),
                Conversation.findOne({ orgId }).sort({ createdAt: -1 }).select("createdAt").lean(),
                WidgetPing.find({ orgId }).sort({ lastSeenAt: -1 }).limit(5).lean(),
                AdminAudit.find({ orgId }).sort({ createdAt: -1 }).limit(25).lean(),
            ]);
            const accounts = await Account.find({ email: { $in: members.map((m) => m.email.toLowerCase()) } })
                .select("accountId email emailVerifiedAt lastLoginAt providers createdAt").lean();

            return {
                status: 200,
                json: {
                    success: true,
                    data: {
                        workspace: {
                            orgId: org.orgId,
                            name: org.name,
                            website: org.website,
                            ownerEmail: org.ownerEmail,
                            publicKey: org.publicKey,
                            createdAt: org.createdAt,
                            agentName: (org.agent && org.agent.name) || "",
                            billing: org.billing || {},
                            onboardedAt: (org.onboarding && org.onboarding.wizardCompletedAt) || null,
                            suspended: isSuspended(org) ? org.suspended : null,
                        },
                        plan: this._planSummary(subscription),
                        subscription: subscription && {
                            plan: subscription.plan,
                            status: subscription.status,
                            provider: subscription.provider,
                            providerSubscriptionId: subscription.providerSubscriptionId,
                            currency: subscription.currency,
                            currentPeriodStart: subscription.currentPeriodStart,
                            currentPeriodEnd: subscription.currentPeriodEnd,
                            trialEndsAt: subscription.trialEndsAt,
                            gracePeriodEndsAt: subscription.gracePeriodEndsAt,
                            cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
                        },
                        usage: usage.map((u) => ({
                            periodStart: u.periodStart,
                            periodEnd: u.periodEnd,
                            plan: u.plan,
                            conversations: u.conversations,
                            conversationsLimit: getPlan(u.plan).limits.conversations,
                            turns: u.turns,
                            costUsd: Number(u.costUsd.toFixed(4)),
                            costUsdLimit: getPlan(u.plan).limits.costUsd,
                            hardLimitReachedAt: u.hardLimitReachedAt,
                            costCeilingReachedAt: u.costCeilingReachedAt,
                        })),
                        members: members.map((m) => {
                            const account = accounts.find((a) => a.email === m.email.toLowerCase()) || null;
                            return {
                                email: m.email,
                                name: m.name,
                                role: m.role,
                                status: m.status,
                                lastActiveAt: m.lastActiveAt,
                                account: account && {
                                    accountId: account.accountId,
                                    emailVerified: Boolean(account.emailVerifiedAt),
                                    lastLoginAt: account.lastLoginAt,
                                    providers: account.providers,
                                },
                            };
                        }),
                        knowledge: Object.fromEntries(sources.map((s) => [s._id, s.n])),
                        conversations: {
                            byStatus: Object.fromEntries(conversationCounts.map((c) => [c._id, c.n])),
                            last30Days: conversations30,
                            lastAt: lastConversation ? lastConversation.createdAt : null,
                        },
                        widget: pings.map((p) => ({ origin: p.origin, lastSeenAt: p.lastSeenAt, hits: p.hits })),
                        audits,
                    },
                },
            };
        });
    }

    /* Put a workspace on a plan, free of charge. Refused while a provider is
       billing it: the next webhook would put the provider's plan back, and the
       customer would be charged for one plan while being given another. */
    setPlan({ adminEmail, orgId, plan, reason }) {
        return this._run("setPlan", async () => {
            const why = needReason(reason);
            if (!Object.values(PlanId).includes(plan)) throw fail(400, "Pick a plan: FREE, STARTER, GROWTH or SCALE.");
            const org = await this._orgOf(orgId);
            const subscription = await this._editableSubscription(orgId);
            const before = this._planSummary(subscription.toObject());

            const now = new Date();
            subscription.plan = plan;
            subscription.status = SubscriptionStatus.ACTIVE;
            subscription.trialEndsAt = null;
            subscription.gracePeriodEndsAt = null;
            subscription.cancelAtPeriodEnd = false;
            subscription.cancelledAt = null;
            if (!subscription.currentPeriodEnd || subscription.currentPeriodEnd <= now) {
                subscription.currentPeriodStart = now;
                subscription.currentPeriodEnd = new Date(now.getTime() + 30 * DAY_MS);
            }
            await subscription.save();
            await this._applyPlanNow({ orgId, subscription });

            await this._audit({ adminEmail, action: "set_plan", org, reason: why, detail: { plan, before } });
            return { status: 200, json: { success: true, data: this._planSummary(subscription.toObject()) } };
        });
    }

    /* A trial on a paid plan until a date. Uses the ordinary trial machinery,
       so the lifecycle sweep drops it to FREE when it ends, exactly as for a
       trial that started at signup. */
    extendTrial({ adminEmail, orgId, days, plan, reason }) {
        return this._run("extendTrial", async () => {
            const why = needReason(reason);
            const count = Math.round(Number(days));
            if (!Number.isFinite(count) || count < 1 || count > 90) throw fail(400, "Give a number of days between 1 and 90.");
            const org = await this._orgOf(orgId);
            const subscription = await this._editableSubscription(orgId);
            const trialPlan = plan || (PAID_PLANS.includes(subscription.plan) ? subscription.plan : PlanId.GROWTH);
            if (!PAID_PLANS.includes(trialPlan)) throw fail(400, "A trial is of a paid plan: STARTER, GROWTH or SCALE.");
            const before = this._planSummary(subscription.toObject());

            const now = new Date();
            const stillTrialing = subscription.status === SubscriptionStatus.TRIALING && subscription.trialEndsAt && subscription.trialEndsAt > now;
            const from = stillTrialing ? subscription.trialEndsAt : now;
            const trialEndsAt = new Date(from.getTime() + count * DAY_MS);
            if (!stillTrialing) subscription.currentPeriodStart = now;
            subscription.plan = trialPlan;
            subscription.status = SubscriptionStatus.TRIALING;
            subscription.trialEndsAt = trialEndsAt;
            subscription.currentPeriodEnd = trialEndsAt;
            subscription.gracePeriodEndsAt = null;
            subscription.cancelAtPeriodEnd = false;
            await subscription.save();
            await this._applyPlanNow({ orgId, subscription });

            await this._audit({ adminEmail, action: "extend_trial", org, reason: why, detail: { days: count, plan: trialPlan, trialEndsAt, before } });
            return { status: 200, json: { success: true, data: this._planSummary(subscription.toObject()) } };
        });
    }

    setSuspended({ adminEmail, orgId, suspended, reason }) {
        return this._run("setSuspended", async () => {
            const why = needReason(reason);
            const org = await this._orgOf(orgId);
            const suspend = suspended !== false;
            if (suspend === isSuspended(org)) throw fail(400, suspend ? "This workspace is already suspended." : "This workspace isn't suspended.");
            await Org.updateOne(
                { orgId },
                suspend ? { $set: { suspended: { at: new Date(), reason: why, by: adminEmail } } } : { $set: { suspended: { at: null, reason: "", by: "" } } }
            );
            await this._audit({ adminEmail, action: suspend ? "suspend" : "unsuspend", org, reason: why });
            return { status: 200, json: { success: true, data: { suspended: suspend } } };
        });
    }

    // For a sign-up stuck on a verification email that never arrived.
    verifyAccountEmail({ adminEmail, accountId, reason }) {
        return this._run("verifyAccountEmail", async () => {
            const why = needReason(reason);
            const account = await this._accountOf(accountId);
            if (account.emailVerifiedAt) throw fail(400, "This email is already verified.");
            await Account.updateOne({ accountId }, { $set: { emailVerifiedAt: new Date() } });
            await this._audit({ adminEmail, action: "verify_email", account, reason: why });
            return { status: 200, json: { success: true, data: { emailVerified: true } } };
        });
    }

    /* Ends every session and org token the account holds, on every device —
       both check sessionVersion on each request. For a lost laptop or a
       person who has left. */
    signOutAccount({ adminEmail, accountId, reason }) {
        return this._run("signOutAccount", async () => {
            const why = needReason(reason);
            const account = await this._accountOf(accountId);
            if (account.email === adminEmail) throw fail(400, "That's you; sign out from the menu instead.");
            await Account.updateOne({ accountId }, { $inc: { sessionVersion: 1 } });
            await this._audit({ adminEmail, action: "sign_out_everywhere", account, reason: why });
            return { status: 200, json: { success: true, data: { signedOut: true } } };
        });
    }

    listAudit({ orgId, limit }) {
        return this._run("listAudit", async () => {
            const filter = orgId ? { orgId: String(orgId) } : {};
            const entries = await AdminAudit.find(filter).sort({ createdAt: -1 }).limit(Math.min(200, Number(limit) || 100)).lean();
            return { status: 200, json: { success: true, data: { entries } } };
        });
    }

    // ── Private Helper Functions ─────────────────────────────────────

    async _run(name, work) {
        try {
            return await work();
        } catch (error) {
            if (error.status) return { status: error.status, json: { success: false, error: error.message } };
            console.error(`AdminFunctions:${name}: Catch block`);
            console.error(error);
            generalFunctions.captureException(error);
            return { status: 500, json: { success: false, error: "Internal server error, please contact support" } };
        }
    }

    async _orgOf(orgId) {
        const org = typeof orgId === "string" ? await Org.findOne({ orgId }).lean() : null;
        if (!org) throw fail(404, "Workspace not found");
        return org;
    }

    async _accountOf(accountId) {
        const account = typeof accountId === "string" ? await Account.findOne({ accountId }).lean() : null;
        if (!account) throw fail(404, "Account not found");
        return account;
    }

    async _editableSubscription(orgId) {
        const ensured = await billingFunctions._ensureSubscription({ orgId });
        if (!ensured.success) throw fail(500, "Could not read this workspace's subscription");
        const subscription = ensured.subscription;
        const billed = subscription.provider !== BillingProvider.NONE && subscription.providerSubscriptionId
            && [SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE].includes(subscription.status);
        if (billed) throw fail(409, `This workspace pays through ${subscription.provider}. Change or cancel the plan there first.`);
        return subscription;
    }

    /* The quota check reads the plan snapshotted on the current period's usage
       row, and the API gate reads Org.credits. Both move now, so the change is
       felt on the next message rather than at the next period. */
    async _applyPlanNow({ orgId, subscription }) {
        const effective = billingFunctions._resolveEffectivePlanId({ subscription }).planId;
        const limits = getPlan(effective).limits;
        await Org.updateOne({ orgId }, { $set: { "credits.plan": effective, "credits.conversationsLimit": limits.conversations } });
        await UsageRecord.updateOne(
            { orgId, periodStart: subscription.currentPeriodStart },
            { $set: { plan: effective, conversationsLimit: limits.conversations, costUsdLimit: limits.costUsd, hardLimitReachedAt: null, costCeilingReachedAt: null } }
        );
    }

    _planSummary(subscription) {
        if (!subscription) return { plan: PlanId.FREE, effectivePlan: PlanId.FREE, status: null, provider: BillingProvider.NONE, trialEndsAt: null, currentPeriodEnd: null };
        const effective = billingFunctions._resolveEffectivePlanId({ subscription });
        return {
            plan: subscription.plan,
            effectivePlan: effective.planId,
            downgradeReason: effective.reason,
            status: subscription.status,
            provider: subscription.provider,
            trialEndsAt: subscription.trialEndsAt,
            currentPeriodEnd: subscription.currentPeriodEnd,
        };
    }

    async _audit({ adminEmail, action, org, account, reason, detail = {} }) {
        await AdminAudit.create({
            adminEmail,
            action,
            orgId: org ? org.orgId : null,
            accountId: account ? account.accountId : null,
            targetLabel: org ? org.name : account.email,
            reason,
            detail,
        });
    }
}

module.exports = new AdminFunctions();
