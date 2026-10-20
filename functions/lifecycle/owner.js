"use strict";
const { PlanId, SubscriptionStatus } = require("../../config/enums");
const { getPlan } = require("../../config/plans");
const Org = require("../../models/org/org");
const Subscription = require("../../models/billing/subscription");
const Account = require("../../models/user/account");

// Who hears about a workspace, and the contact fields sent with every event.
// The owner is the person the workspace belongs to; teammates hear only about
// things that happened to them (an invite, a removal).

const firstNameOf = (name) => String(name || "").trim().split(/\s+/)[0] || null;

// "trial" | "free" | "paid" — what workflows branch on. A trial runs on the
// Growth plan, so the plan id alone would call a trialling workspace paid.
function tierOf(subscription) {
    if (!subscription) return "free";
    if (subscription.status === SubscriptionStatus.TRIALING) return "trial";
    return subscription.plan && subscription.plan !== PlanId.FREE ? "paid" : "free";
}

function planNameOf(subscription) {
    const tier = tierOf(subscription);
    if (tier === "trial") return "Growth trial";
    return getPlan(subscription ? subscription.plan : PlanId.FREE).name;
}

function contactFor(person, org, subscription, role) {
    return {
        firstName: firstNameOf(person && person.name),
        workspace: org.name,
        plan_name: planNameOf(subscription),
        plan_tier: tierOf(subscription),
        role: role || null,
    };
}

async function ownerOf(orgId, preloaded = {}) {
    const org = preloaded.org || (await Org.findOne({ orgId }).lean());
    if (!org || !org.ownerEmail) return null;
    const [subscription, account] = await Promise.all([
        preloaded.subscription !== undefined ? preloaded.subscription : Subscription.findOne({ orgId }).lean(),
        Account.findOne({ email: org.ownerEmail.toLowerCase() }).select("name").lean(),
    ]);
    return { email: org.ownerEmail, org, subscription, contact: contactFor(account, org, subscription, "owner") };
}

module.exports = { ownerOf, contactFor, tierOf, planNameOf, firstNameOf };
